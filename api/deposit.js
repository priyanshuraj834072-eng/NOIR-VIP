const { getAuthenticatedUser, db } = require("./_auth");
const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    // Verify the logged-in NOIR user.
    const auth = await getAuthenticatedUser(req);

    if (!auth || !auth.uid) {
      return res.status(401).json({
        success: false,
        message: "Please log in first",
      });
    }

    const merchantKey = process.env.OXAPAY_MERCHANT_API_KEY;

    if (!merchantKey) {
      return res.status(500).json({
        success: false,
        message: "Payment configuration is missing",
      });
    }

    // First test with a fixed amount of 1 USDT.
    // The browser cannot choose a larger amount.
    const amount = 1;
    const orderId = "NRD_" + crypto.randomUUID();

    const baseUrl = "https://noir-vip.vercel.app";

    // Create a pending order before requesting the invoice.
    await db.ref("depositOrders/" + orderId).set({
      orderId,
      uid: auth.uid,
      amount,
      currency: "USDT",
      status: "creating",
      createdAt: Date.now(),
    });

    const response = await fetch(
      "https://api.oxapay.com/v1/payment/invoice",
      {
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
          sandbox: true,
        }),
      }
    );

    const result = await response.json();

    if (
      !response.ok ||
      !result.data ||
      !result.data.payment_url ||
      !result.data.track_id
    ) {
      await db.ref("depositOrders/" + orderId).update({
        status: "invoice_failed",
        updatedAt: Date.now(),
      });

      console.error("OxaPay invoice request failed", {
        httpStatus: response.status,
        error: result.error || result.message || "Unknown error",
      });

      return res.status(502).json({
        success: false,
        message: "Could not create payment invoice",
      });
    }

    // Save the invoice details against the authenticated user.
    await db.ref("depositOrders/" + orderId).update({
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

    return res.status(500).json({
      success: false,
      message: "Unable to create deposit invoice",
    });
  }
};
