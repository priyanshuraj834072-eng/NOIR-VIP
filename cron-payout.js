import { db } from "./_auth.js";

export default async function handler(req, res) {
  // CRON_SECRET security to prevent unauthorized payouts
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: "Unauthorized Request" });
  }

  try {
    const database = db();
    const [projectsSnap, walletsSnap] = await Promise.all([
      database.ref("user_projects").get(),
      database.ref("wallets").get()
    ]);

    if (!projectsSnap.exists()) return res.status(200).json({ success: true, message: "No active projects" });

    const updates = {};
    const timestamp = Date.now();
    const wallets = walletsSnap.exists() ? walletsSnap.val() : {};

    projectsSnap.forEach(userNode => {
      const uid = userNode.key;
      let userDailyProfit = 0;
      const userProjects = userNode.val();

      Object.keys(userProjects).forEach(projectId => {
        const p = userProjects[projectId];
        if (p.daysRemaining > 0) {
          userDailyProfit += Number(p.dailyProfit);
          updates[`user_projects/${uid}/${projectId}/daysRemaining`] = p.daysRemaining - 1;
        }
      });

      // Single combined wallet update per user
      if (userDailyProfit > 0) {
        const currentBal = wallets[uid] && wallets[uid].balance ? Number(wallets[uid].balance) : 0;
        const currentProfit = wallets[uid] && wallets[uid].totalProfit ? Number(wallets[uid].totalProfit) : 0;
        
        updates[`wallets/${uid}/balance`] = currentBal + userDailyProfit;
        updates[`wallets/${uid}/totalProfit`] = currentProfit + userDailyProfit;
        
        const logId = "payout_" + uid + "_" + timestamp;
        updates[`depositOrders/${logId}`] = {
          orderId: logId, uid, type: "daily_profit", amount: userDailyProfit, currency: "USDT", status: "completed", createdAt: timestamp
        };
      }
    });

    if (Object.keys(updates).length > 0) {
      await database.ref().update(updates);
    }

    return res.status(200).json({ success: true, processedUpdates: Object.keys(updates).length });
  } catch (error) {
    console.error("Cron payout error:", error);
    return res.status(500).json({ success: false, error: "Cron execution failed" });
  }
}
