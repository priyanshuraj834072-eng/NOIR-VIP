import { randomUUID } from "node:crypto";
import { getAuthenticatedUser, db } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const auth = await getAuthenticatedUser(req);
    if (!auth || !auth.uid) {
      return res.status(401).json({ success: false, message: "Please log in first" });
    }

    const merchantKey = process.env.OXAPAY_MERCHANT_API_KEY;
    if (!merchantKey) {
      return res.status(500).json({ success: false, message: "Payment configuration is missing" });
    }

    // Amount comes from the client but is validated on the server.
    const requested = Number(req.body && req.body.amount);
    if (!Number.isFinite(requested) || requested < 1 || requested > 100000) {
      return res.status(400).json({
        success: false,
        message: "Amount must be between 1 and 100,000 USDT",
      });
    }
    const amount = Math.round(requested * 100) / 100;
    const orderId = "NRD_" + randomUUID();

    const baseUrl = process.env.SITE_URL || "https://noir-vip.vercel.app";
    const sandbox = process.env.OXAPAY_SANDBOX === "true";

    const database = db();
    const orderRef = database.ref("depositOrders/" + orderId);

    await orderRef.set({
      orderId,
      uid: auth.uid,
      amount,
      currency: "USDT",
      status: "creating",
      createdAt: Date.now(),
    });

    const response = await fetch("https://api.oxapay.com/v1/payment/invoice", {
      method: "POST",
      headers: {
        merchant_api_key: merchantKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "USDT",
        lifetime: 30,
        order_id: orderId,
        description: "NOIR wallet deposit",
        callback_url: baseUrl + "/api/oxapay-webhook",
        return_url: baseUrl,
        sandbox,
      }),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.data || !result.data.payment_url || !result.data.track_id) {
      await orderRef.update({ status: "invoice_failed", updatedAt: Date.now() });
      console.error("OxaPay invoice request failed", {
        httpStatus: response.status,
        error: result.error || result.message || "Unknown error",
      });
      return res.status(502).json({ success: false, message: "Could not create payment invoice" });
    }

    await orderRef.update({
      status: "pending",
      trackId: String(result.data.track_id),
      paymentUrl: result.data.payment_url,
      updatedAt: Date.now(),
    });

    return res.status(200).json({
      success: true,
      orderId,
      amount,
      currency: "USDT",
      paymentUrl: result.data.payment_url,
    });
  } catch (error) {
    console.error("NOIR deposit error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to create deposit invoice" });
  }
}
