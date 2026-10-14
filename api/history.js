import { getAuthenticatedUser, db } from "./_auth.js";

function maskAddress(address) {
  const a = String(address || "");
  if (a.length <= 10) return a;
  return a.slice(0, 6) + "..." + a.slice(-4);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

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

    const [depSnap, wdrSnap] = await Promise.all([
      database.ref("depositOrders").orderByChild("uid").equalTo(auth.uid).limitToLast(50).get(),
      database.ref("withdrawalRequests").orderByChild("uid").equalTo(auth.uid).limitToLast(50).get(),
    ]);

    const items = [];

    if (depSnap.exists()) {
      depSnap.forEach((child) => {
        const o = child.val();
        // "creating" is an internal step; skip it
        if (o.status === "creating") return;
        items.push({
          id: o.orderId,
          type: "deposit",
          amount: Number(o.amount),
          currency: o.currency || "USDT",
          status: o.status,
          createdAt: o.createdAt || 0,
        });
      });
    }

    if (wdrSnap.exists()) {
      wdrSnap.forEach((child) => {
        const w = child.val();
        if (w.status === "creating") return;
        items.push({
          id: w.withdrawalId,
          type: "withdrawal",
          amount: Number(w.amount),
          currency: w.currency || "USDT",
          status: w.status,
          network: w.network || "",
          address: maskAddress(w.address),
          createdAt: w.createdAt || 0,
        });
      });
    }

    items.sort((a, b) => b.createdAt - a.createdAt);

    return res.status(200).json({ success: true, items: items.slice(0, 50) });
  } catch (error) {
    console.error("NOIR history error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load history" });
  }
}
