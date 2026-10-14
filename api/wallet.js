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

    const database = db();

    // Ab sirf balance nahi, poora wallet fetch kar rahe hain
    const [walletSnap, wdrSnap] = await Promise.all([
      database.ref("wallets/" + auth.uid).get(),
      database.ref("withdrawalRequests").orderByChild("uid").equalTo(auth.uid).get(),
    ]);

    const walletData = walletSnap.exists() ? walletSnap.val() : {};
    
    // Balance, Invested aur Profit values nikalna (agar nahi hai toh 0)
    const balance = Number(walletData.balance) || 0;
    const totalInvested = Number(walletData.totalInvested) || 0;
    const totalProfit = Number(walletData.totalProfit) || 0;

    // Withdrawals count karna
    let totalWithdrawn = 0;
    if (wdrSnap.exists()) {
      wdrSnap.forEach((child) => {
        const w = child.val();
        if (w.status === "completed" || w.status === "sent") {
          totalWithdrawn += Number(w.amount) || 0;
        }
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      success: true,
      balance: Number.isFinite(balance) ? balance : 0,
      totalInvested: Math.round(totalInvested * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      totalWithdrawn: Math.round(totalWithdrawn * 100) / 100,
      currency: "USDT",
    });
  } catch (error) {
    console.error("NOIR wallet error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load wallet" });
  }
}
