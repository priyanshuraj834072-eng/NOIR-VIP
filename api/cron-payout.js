import { db } from "./_auth.js";

export default async function handler(req, res) {
  // CRON_SECRET security check
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: "Unauthorized CRON request" });
  }

  try {
    const database = db();
    
    // Ek saath projects aur wallets ka data fetch karna
    const [projectsSnap, walletsSnap] = await Promise.all([
      database.ref("user_projects").get(),
      database.ref("wallets").get()
    ]);

    if (!projectsSnap.exists()) {
      return res.status(200).json({ success: true, message: "No active projects found" });
    }

    const updates = {};
    const timestamp = Date.now();
    const wallets = walletsSnap.exists() ? walletsSnap.val() : {};

    projectsSnap.forEach(userNode => {
      const uid = userNode.key;
      let totalDailyProfit = 0;
      const userProjects = userNode.val();

      Object.keys(userProjects).forEach(projectId => {
        const project = userProjects[projectId];
        
        // Jiske din bache hain, uska profit jodo
        if (project.daysRemaining > 0) {
          totalDailyProfit += Number(project.dailyProfit);
          updates[`user_projects/${uid}/${projectId}/daysRemaining`] = project.daysRemaining - 1;
        }
      });

      // Agar total profit 0 se jyada hai toh wallet me update karo
      if (totalDailyProfit > 0) {
        const currentBalance = wallets[uid] && wallets[uid].balance ? Number(wallets[uid].balance) : 0;
        const currentTotalProfit = wallets[uid] && wallets[uid].totalProfit ? Number(wallets[uid].totalProfit) : 0;
        
        updates[`wallets/${uid}/balance`] = currentBalance + totalDailyProfit;
        updates[`wallets/${uid}/totalProfit`] = currentTotalProfit + totalDailyProfit;
        
        // History tab me dikhane ke liye log
        const logId = "profit_" + uid + "_" + timestamp;
        updates[`depositOrders/${logId}`] = {
          orderId: logId,
          uid: uid,
          type: "daily_profit",
          amount: totalDailyProfit,
          currency: "USDT",
          status: "completed",
          createdAt: timestamp
        };
      }
    });

    // Database par ek single write me saara kaam
    if (Object.keys(updates).length > 0) {
      await database.ref().update(updates);
    }

    return res.status(200).json({ 
      success: true, 
      message: "Daily profit distributed successfully", 
      processedUpdates: Object.keys(updates).length 
    });

  } catch (error) {
    console.error("Cron payout error:", error);
    return res.status(500).json({ success: false, error: "Cron execution failed" });
  }
}
