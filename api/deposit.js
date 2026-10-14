import { randomUUID } from "node:crypto";
import { getAuthenticatedUser, db } from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const auth = await getAuthenticatedUser(req);

    if (!auth || !auth.uid) {
      return res.status(401).json({
        success: false,
        message: "Please log in first",
      });
    }

    const database = db();

    // Load admin payment settings
    const settingsSnap = await database
      .ref("adminSettings/payments")
      .get();

    const settings = settingsSnap.exists()
      ? settingsSnap.val()
      : {
          depositEnabled: true,
          minDeposit: 1,
          maxDeposit: 100000,
        };

    // Deposit ON/OFF
    if (settings.depositEnabled !== true) {
      return res.status(403).json({
        success: false,
        message: "Deposits are currently disabled",
      });
    }

    const minDeposit = Number(settings.minDeposit);
    const maxDeposit = Number(settings.maxDeposit);

    if (
      !Number.isFinite(minDeposit) ||
      !Number.isFinite(maxDeposit) ||
      minDeposit <= 0 ||
      maxDeposit < minDeposit
    ) {
      return res.status(500).json({
        success: false,
        message: "Deposit settings are invalid",
      });
    }

    const merchantKey = process.env.OXAPAY_MERCHANT_API_KEY;

    if (!merchantKey) {
      return res.status(500).json({
        success: false,
        message: "Payment configuration is missing",
      });
    }

    // Amount comes from client but is validated on server
    const requested = Number(req.body && req.body.amount);

    if (!Number.isFinite(requested)) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit amount",
      });
    }

    const amount = Math.round(requested * 100) / 100;

    // Admin-controlled minimum / maximum
    if (amount < minDeposit || amount > maxDeposit) {
      return res.status(400).json({
        success: false,
        message: `Deposit amount must be between ${minDeposit} and ${maxDeposit} USDT`,
      });
    }

    const orderId = "NRD_" + randomUUID();

    const baseUrl =
      process.env.SITE_URL || "https://noir-vip.vercel.app";

    const sandbox =
      process.env.OXAPAY_SANDBOX === "true";

    const orderRef = database.ref(
      "depositOrders/" + orderId
    );

    await orderRef.set({
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
          callback_url:
            baseUrl + "/api/oxapay-webhook",
          return_url: baseUrl,
          sandbox,
        }),
      }
    );

    const result = await response
      .json()
      .catch(() => ({}));

    if (
      !response.ok ||
      !result.data ||
      !result.data.payment_url ||
      !result.data.track_id
    ) {
      await orderRef.update({
        status: "invoice_failed",
        updatedAt: Date.now(),
      });

      console.error(
        "OxaPay invoice request failed",
        {
          httpStatus: response.status,
          error:
            result.error ||
            result.message ||
            "Unknown error",
        }
      );

      return res.status(502).json({
        success: false,
        message: "Could not create payment invoice",
      });
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
    console.error(
      "NOIR deposit error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Unable to create deposit invoice",
    });
  }
}
