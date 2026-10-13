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

    // Test: fixed 1 USDT. Later: take from client and validate min/max here.
    const amount = 1;
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
