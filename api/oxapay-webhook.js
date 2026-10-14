import crypto from "node:crypto";
import { db } from "./_auth.js";

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const FINAL = ["completed", "failed"];

// Returns which of our keys signed the request ("merchant" / "payout") or null.
function matchedKey(raw, received) {
  if (typeof received !== "string" || !/^[a-f0-9]{128}$/i.test(received)) return null;
  const supplied = Buffer.from(received, "hex");
  const candidates = [
    ["merchant", process.env.OXAPAY_MERCHANT_API_KEY],
    ["payout", process.env.OXAPAY_PAYOUT_API_KEY],
  ];
  for (const [name, key] of candidates) {
    if (!key) continue;
    const calc = crypto.createHmac("sha512", key).update(raw).digest();
    if (calc.length === supplied.length && crypto.timingSafeEqual(calc, supplied)) return name;
  }
  return null;
}

// ---------- Deposit (invoice) ----------
async function handleInvoice(data, res) {
  if (!data.order_id || !data.track_id) {
    return res.status(400).send("Invalid invoice data");
  }

  const orderId = String(data.order_id);
  if (!/^NRD_[a-f0-9-]{36}$/i.test(orderId)) {
    return res.status(400).send("Invalid order ID");
  }

  console.log("WEBHOOK received:", { orderId, status: data.status, amount: data.amount, currency: data.currency });

  if (String(data.status || "").toLowerCase() !== "paid") {
    return res.status(200).send("ok");
  }

  const database = db();
  const orderRef = database.ref("depositOrders/" + orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists()) {
    console.error("Webhook order not found:", orderId);
    return res.status(404).send("Order not found");
  }

  const order = orderSnap.val();

  if (!order.trackId || String(order.trackId) !== String(data.track_id)) {
    console.error("OxaPay track ID mismatch:", orderId);
    return res.status(400).send("Invoice mismatch");
  }

  if (order.status !== "pending") {
    return res.status(200).send("ok");
  }

  const expectedAmount = Number(order.amount);
  const paidAmount = Number(data.amount);

  if (
    !Number.isFinite(expectedAmount) ||
    !Number.isFinite(paidAmount) ||
    expectedAmount <= 0 ||
    paidAmount < expectedAmount ||
    String(data.currency || "").toUpperCase() !== String(order.currency || "").toUpperCase()
  ) {
    console.error("OxaPay amount/currency mismatch:", orderId);
    await orderRef.update({ status: "review_required", updatedAt: Date.now() });
    return res.status(200).send("ok");
  }

  // Atomic + idempotent wallet credit
  const walletRef = database.ref("wallets/" + order.uid);
  await walletRef.transaction((current) => {
    const wallet = current || {};
    const credited = wallet.credited || {};
    if (credited[orderId]) return; // already credited
    wallet.balance = round(Number(wallet.balance || 0) + expectedAmount);
    wallet.credited = {
      ...credited,
      [orderId]: { amount: expectedAmount, trackId: String(data.track_id), at: Date.now() },
    };
    wallet.updatedAt = Date.now();
    return wallet;
  });

  await orderRef.update({
    status: "paid",
    paidAt: Date.now(),
    updatedAt: Date.now(),
    providerAmount: paidAmount,
    providerCurrency: String(data.currency).toUpperCase(),
  });

  console.log("WEBHOOK success: credited", orderId, expectedAmount);
  return res.status(200).send("ok");
}

// ---------- Withdrawal (payout) ----------
async function handlePayout(data, res) {
  if (!data.track_id) {
    return res.status(400).send("Invalid payout data");
  }

  const trackId = String(data.track_id);
  const status = String(data.status || "").toLowerCase();
  console.log("PAYOUT WEBHOOK:", { trackId, status });

  const database = db();

  let withdrawalId = (await database.ref("payoutTracks/" + trackId).get()).val();

  if (!withdrawalId) {
    const found = await database
      .ref("withdrawalRequests")
      .orderByChild("trackId")
      .equalTo(trackId)
      .limitToFirst(1)
      .get();
    if (found.exists()) {
      found.forEach((child) => {
        withdrawalId = child.key;
      });
    }
  }

  if (!withdrawalId) {
    console.error("PAYOUT WEBHOOK: withdrawal not found for track", trackId);
    return res.status(404).send("Withdrawal not found");
  }

  const requestRef = database.ref("withdrawalRequests/" + withdrawalId);
  const snap = await requestRef.get();
  if (!snap.exists()) return res.status(404).send("Withdrawal not found");

  const request = snap.val();
  if (String(request.trackId) !== trackId) {
    return res.status(400).send("Track mismatch");
  }

  if (FINAL.includes(request.status)) {
    return res.status(200).send("ok");
  }

  if (status === "confirming") {
    await requestRef.update({ status: "confirming", updatedAt: Date.now() });
    return res.status(200).send("ok");
  }

  if (status === "confirmed" || status === "complete" || status === "completed") {
    const update = { status: "completed", completedAt: Date.now(), updatedAt: Date.now() };
    if (data.tx_hash) update.txHash = String(data.tx_hash);
    await requestRef.update(update);
    console.log("PAYOUT WEBHOOK: completed", withdrawalId);
    return res.status(200).send("ok");
  }

  if (["failed", "rejected", "canceled", "cancelled"].includes(status)) {
    const amount = Number(request.amount);
    const walletRef = database.ref("wallets/" + request.uid);

    await walletRef.transaction((current) => {
      if (current === null) return current;
      const refunded = current.refunded || {};
      if (refunded[withdrawalId]) return;
      if (!(current.debited || {})[withdrawalId]) return;
      current.balance = round(Number(current.balance || 0) + amount);
      current.refunded = { ...refunded, [withdrawalId]: { amount, at: Date.now() } };
      current.updatedAt = Date.now();
      return current;
    });

    await requestRef.update({ status: "failed", reason: "payout_" + status, updatedAt: Date.now() });
    console.log("PAYOUT WEBHOOK: failed + refunded", withdrawalId);
    return res.status(200).send("ok");
  }

  return res.status(200).send("ok");
}

// ---------- Entry point ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  try {
    if (!process.env.OXAPAY_MERCHANT_API_KEY && !process.env.OXAPAY_PAYOUT_API_KEY) {
      console.error("OxaPay API keys are missing");
      return res.status(500).send("Payment configuration error");
    }

    const raw = await readRawBody(req);
    const matched = matchedKey(raw, req.headers["hmac"]);
    if (!matched) {
      return res.status(401).send("Invalid signature");
    }

    let data;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    if (data && data.type === "invoice") {
      // Deposits must be signed with the merchant key.
      if (matched !== "merchant") return res.status(401).send("Invalid signature");
      return await handleInvoice(data, res);
    }

    if (data && data.type === "payout") {
      return await handlePayout(data, res);
    }

    return res.status(400).send("Unknown webhook type");
  } catch (error) {
    console.error("OxaPay webhook error:", error.message);
    return res.status(500).send("Webhook processing failed");
  }
}
