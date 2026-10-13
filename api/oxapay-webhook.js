export const config = {
  api: {
    bodyParser: false,
  },
};
const crypto = require("node:crypto");
const { db } = require("./_auth");

module.exports = async function handler(req, res) {
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

    // Verify HMAC against the exact raw request body.
    const rawBody = req.body;

    if (
      !Buffer.isBuffer(rawBody) &&
      typeof rawBody !== "string"
    ) {
      console.error(
        "Raw request body unavailable; configure raw body parsing"
      );
      return res.status(400).send("Invalid request body");
    }

    const raw = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody, "utf8");

    const receivedHmac = req.headers["hmac"];

    if (
      typeof receivedHmac !== "string" ||
      !/^[a-f0-9]{128}$/i.test(receivedHmac)
    ) {
      return res.status(401).send("Invalid signature");
    }

    const calculatedHmac = crypto
      .createHmac("sha512", merchantKey)
      .update(raw)
      .digest();

    const suppliedHmac = Buffer.from(receivedHmac, "hex");

    if (
      suppliedHmac.length !== calculatedHmac.length ||
      !crypto.timingSafeEqual(calculatedHmac, suppliedHmac)
    ) {
      return res.status(401).send("Invalid signature");
    }

    let data;

    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    if (
      !data ||
      data.type !== "invoice" ||
      !data.order_id ||
      !data.track_id
    ) {
      return res.status(400).send("Invalid invoice data");
    }

    const orderId = String(data.order_id);

    if (!/^NRD_[a-f0-9-]{36}$/i.test(orderId)) {
      return res.status(400).send("Invalid order ID");
    }

    const orderRef = db().ref("depositOrders/" + orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists()) {
      console.error("Webhook order not found:", orderId);
      return res.status(404).send("Order not found");
    }

    const order = orderSnap.val();

    // Never credit a payment based on a non-final status.
    if (String(data.status || "").toLowerCase() !== "paid") {
      return res.status(200).send("ok");
    }

    // Check the provider invoice ID against the saved invoice.
    if (
      !order.trackId ||
      String(order.trackId) !== String(data.track_id)
    ) {
      console.error("OxaPay track ID mismatch:", orderId);
      return res.status(400).send("Invoice mismatch");
    }

    // This endpoint records verified payment only.
    // Wallet crediting must be implemented with an atomic,
    // idempotent ledger transaction before production use.
    if (order.status === "paid") {
      return res.status(200).send("ok");
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
      String(data.currency || "").toUpperCase() !==
        String(order.currency || "").toUpperCase()
    ) {
      console.error("OxaPay amount/currency mismatch:", orderId);
      await orderRef.update({
        status: "review_required",
        updatedAt: Date.now(),
      });
      return res.status(200).send("ok");
    }

    // Record confirmation without crediting wallet yet.
    await orderRef.transaction((current) => {
      if (!current || current.status !== "pending") {
        return;
      }

      if (
        String(current.trackId) !== String(data.track_id) ||
        Number(current.amount) !== expectedAmount
      ) {
        return;
      }

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
};
