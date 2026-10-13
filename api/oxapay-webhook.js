import crypto from "node:crypto";
import { db } from "./_auth.js";

// Vercel: disable body parsing so we can read the raw body for HMAC.
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  try {
    const merchantKey = process.env.OXAPAY_MERCHANT_API_KEY;
    if (!merchantKey) {
      console.error("OxaPay Merchant API key is missing");
      return res.status(500).send("Payment configuration error");
    }

    // 1. Raw body + HMAC verification
    const raw = await readRawBody(req);

    const receivedHmac = req.headers["hmac"];
    if (typeof receivedHmac !== "string" || !/^[a-f0-9]{128}$/i.test(receivedHmac)) {
      return res.status(401).send("Invalid signature");
    }

    const calculated = crypto.createHmac("sha512", merchantKey).update(raw).digest();
    const supplied = Buffer.from(receivedHmac, "hex");

    if (supplied.length !== calculated.length || !crypto.timingSafeEqual(calculated, supplied)) {
      return res.status(401).send("Invalid signature");
    }

    // 2. Parse + validate payload
    let data;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    if (!data || data.type !== "invoice" || !data.order_id || !data.track_id) {
      return res.status(400).send("Invalid invoice data");
    }

    const orderId = String(data.order_id);
    if (!/^NRD_[a-f0-9-]{36}$/i.test(orderId)) {
      return res.status(400).send("Invalid order ID");
    }

    // Ignore non-final statuses
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

    // Already processed (duplicate webhook)
    if (order.status !== "pending") {
      return res.status(200).send("ok");
    }

    // 3. Amount / currency check
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

    // 4. Atomic + idempotent wallet credit.
    const walletRef = database.ref("wallets/" + order.uid);

    await walletRef.transaction((current) => {
      const wallet = current || {};
      const credited = wallet.credited || {};

      if (credited[orderId]) {
        return; // already credited -> abort, no change
      }

      wallet.balance = round(Number(wallet.balance || 0) + expectedAmount);
      wallet.credited = {
        ...credited,
        [orderId]: { amount: expectedAmount, trackId: String(data.track_id), at: Date.now() },
      };
      wallet.updatedAt = Date.now();
      return wallet;
    });

    // 5. Mark order paid
    await orderRef.transaction((current) => {
      if (!current || current.status !== "pending") return;
      current.status = "paid";
      current.paidAt = Date.now();
      current.updatedAt = Date.now();
      current.providerAmount = paidAmount;
      current.providerCurrency = String(data.currency).toUpperCase();
      return current;
    });

    return res.status(200).send("ok");
  } catch (error) {
    console.error("OxaPay webhook error:", error.message);
    return res.status(500).send("Webhook processing failed");
  }
}
