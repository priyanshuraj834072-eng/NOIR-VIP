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

function validHmac(raw, received, keys) {
  if (typeof received !== "string" || !/^[a-f0-9]{128}$/i.test(received)) return false;
  const supplied = Buffer.from(received, "hex");
  return keys.filter(Boolean).some((key) => {
    const calc = crypto.createHmac("sha512", key).update(raw).digest();
    return calc.length === supplied.length && crypto.timingSafeEqual(calc, supplied);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  try {
    const keys = [process.env.OXAPAY_PAYOUT_API_KEY, process.env.OXAPAY_MERCHANT_API_KEY];
    if (!keys.some(Boolean)) {
      console.error("Payout webhook: API keys missing");
      return res.status(500).send("Payment configuration error");
    }

    // 1. Verify signature on the raw body
    const raw = await readRawBody(req);
    if (!validHmac(raw, req.headers["hmac"], keys)) {
      return res.status(401).send("Invalid signature");
    }

    // 2. Parse payload
    let data;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    if (!data || data.type !== "payout" || !data.track_id) {
      return res.status(400).send("Invalid payout data");
    }

    const trackId = String(data.track_id);
    const status = String(data.status || "").toLowerCase();
    console.log("PAYOUT WEBHOOK:", { trackId, status });

    const database = db();

    // 3. Find our withdrawal for this payout
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

    // Already final -> nothing to do
    if (FINAL.includes(request.status)) {
      return res.status(200).send("ok");
    }

    // 4a. Confirming
    if (status === "confirming") {
      await requestRef.update({ status: "confirming", updatedAt: Date.now() });
      return res.status(200).send("ok");
    }

    // 4b. Completed
    if (status === "confirmed" || status === "complete" || status === "completed") {
      const update = { status: "completed", completedAt: Date.now(), updatedAt: Date.now() };
      if (data.tx_hash) update.txHash = String(data.tx_hash);
      await requestRef.update(update);
      console.log("PAYOUT WEBHOOK: completed", withdrawalId);
      return res.status(200).send("ok");
    }

    // 4c. Failed -> refund once
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

    // Other statuses (e.g. processing): ignore
    return res.status(200).send("ok");
  } catch (error) {
    console.error("Payout webhook error:", error.message);
    return res.status(500).send("Webhook processing failed");
  }
}
