import { getAuthenticatedUser, db } from "./_auth.js";

const LEDGER_KINDS = ["purchase", "commission", "daily_profit"];

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

    // limitToLast(50) key ke hisaab se kaatta tha (time ke hisaab se nahi), isliye
    // profit/commission entries badhne par purane deposits gayab ho sakte the.
    // Ab user ki saari entries lekar time se sort karte hain.
    const [depSnap, wdrSnap] = await Promise.all([
      database.ref("depositOrders").orderByChild("uid").equalTo(auth.uid).get(),
      database.ref("withdrawalRequests").orderByChild("uid").equalTo(auth.uid).get(),
    ]);

    const items = [];

    if (depSnap.exists()) {
      depSnap.forEach((child) => {
        const o = child.val();
        if (o.status === "creating") return; // internal step
        const kind = LEDGER_KINDS.includes(o.type) ? o.type : "deposit";
        items.push({
          id: o.orderId,
          type: "deposit", // purane frontend ke liye same
          kind, // deposit | purchase | commission | daily_profit
          amount: Number(o.amount),
          currency: o.currency || "USDT",
          status: o.status,
          projectName: kind === "purchase" ? String(o.projectName || "") : "",
          level: kind === "commission" ? Number(o.level) || 0 : 0,
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
          kind: "withdrawal",
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

    return res.status(200).json({ success: true, items: items.slice(0, 100) });
  } catch (error) {
    console.error("NOIR history error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load history" });
  }
}
