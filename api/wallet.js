import { getAuthenticatedUser, db } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const auth = await getAuthenticatedUser(req);
    if (!auth || !auth.uid) {
      return res.status(401).json({ success: false, message: "Please log in first" });
    }

    const snap = await db().ref("wallets/" + auth.uid + "/balance").get();
    const balance = snap.exists() ? Number(snap.val()) : 0;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      success: true,
      balance: Number.isFinite(balance) ? balance : 0,
      currency: "USDT",
    });
  } catch (error) {
    console.error("NOIR wallet error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load wallet" });
  }
}
