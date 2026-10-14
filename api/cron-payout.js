import { db } from "./_auth.js";

export default async function handler(req, res) {
  // 1. Security Check: Vercel cronjob trigger karega is secret key ke sath
  // Taaki koi hacker/user is link ko open karke free me balance na badha le
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: "Unauthorized CRON request" });
  }

  try {
    const database = db();
    
    // 2. Ek sath sabhi users ke projects aur unke wallets uthao (Fast & optimized)
    const [projectsSnap, walletsSnap] = await Promise.all([
      database.ref("user_projects").get(),
      database.ref("wallets").get()
    ]);

    if (!projectsSnap.exists()) {
      return res.status(200).json({ success: true, message: "Koi active project nahi mila" });
    }

    const updates = {};
    const timestamp = Date.now();
    const wallets = walletsSnap.exists() ? walletsSnap.val() : {};

    // 3. Har user ke data par loop chalao
    projectsSnap.forEach(userNode => {
      const uid = userNode.key;
      let totalDailyProfit = 0;
      const userProjects = userNode.val();

      Object.keys(userProjects).forEach(projectId => {
        const project = userProjects[projectId];
        
        // Agar din bache hain (daysRemaining > 0), tabhi profit add karo
        if (project.daysRemaining > 0) {
          totalDailyProfit += Number(project.dailyProfit);
          // Din ko -1 kar do
          updates[`user_projects/${uid}/${projectId}/daysRemaining`] = project.daysRemaining - 1;
        }
      });

      // 4. Agar user ka aaj ka profit 0 se zyada hai, toh wallet update karo
      if (totalDailyProfit > 0) {
        const currentBalance = wallets[uid] && wallets[uid].balance ? Number(wallets[uid].balance) : 0;
        const currentTotalProfit = wallets[uid] && wallets[uid].totalProfit ? Number(wallets[uid].totalProfit) : 0;
        
        updates[`wallets/${uid}/balance`] = currentBalance + totalDailyProfit;
        updates[`wallets/${uid}/totalProfit`] = currentTotalProfit + totalDailyProfit;
        
        // History ke liye ek entry depositOrders table me (Taaki History page me dikhe)
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

    // 5. Ek hi baar me poora database update (Firebase rate limit se bachne ke liye)
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
