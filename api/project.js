import { getAuthenticatedUser, db } from "./_auth.js";

function createId() {
  return "pr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const auth = await getAuthenticatedUser(req);
    if (!auth || !auth.uid) return res.status(401).json({ success: false, message: "Please log in first" });
    
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ success: false, message: "Product ID required" });

    const database = db();
    const [productSnap, walletSnap, myProjectsSnap, settingsSnap] = await Promise.all([
      database.ref(`products/${productId}`).get(),
      database.ref(`wallets/${auth.uid}`).get(),
      database.ref(`user_projects/${auth.uid}`).get(),
      database.ref("adminSettings/referral").get()
    ]);

    if (!productSnap.exists()) return res.status(404).json({ success: false, message: "Project not found" });
    const product = productSnap.val();
    
    if (product.active === false) return res.status(400).json({ success: false, message: "Project is currently unavailable" });
    
    const wallet = walletSnap.exists() ? walletSnap.val() : { balance: 0, totalInvested: 0 };
    const balance = Number(wallet.balance) || 0;
    if (balance < product.price) return res.status(400).json({ success: false, message: "Insufficient USDT balance" });

    // Purchase limit check
    let activeCount = 0;
    if (myProjectsSnap.exists()) {
      myProjectsSnap.forEach(child => {
        if (child.val().productId === productId && child.val().daysRemaining > 0) activeCount++;
      });
    }
    if (activeCount >= (product.purchaseLimit || 1)) {
      return res.status(400).json({ success: false, message: `Limit reached. You can only have ${product.purchaseLimit} active at a time.` });
    }

    const updates = {};
    const purchaseId = createId();
    const timestamp = Date.now();
    
    // Deduct balance & add to user_projects
    updates[`wallets/${auth.uid}/balance`] = balance - product.price;
    updates[`wallets/${auth.uid}/totalInvested`] = (Number(wallet.totalInvested) || 0) + product.price;
    
    updates[`user_projects/${auth.uid}/${purchaseId}`] = {
      id: purchaseId,
      productId: product.productId,
      name: product.name,
      price: product.price,
      dailyProfit: product.dailyProfit,
      totalDays: product.validityDays,
      daysRemaining: product.validityDays,
      purchasedAt: timestamp
    };

    // Purchase History Log
    updates[`depositOrders/${purchaseId}`] = {
      orderId: purchaseId, uid: auth.uid, type: "purchase", amount: -product.price, currency: "USDT", status: "completed", createdAt: timestamp
    };

    // 3-Level Referral Commission Distribution
    const refSettings = settingsSnap.exists() ? settingsSnap.val() : { commissionPercent: 25, level2Percent: 3, level3Percent: 1 };
    const levels = [
      { percent: Number(refSettings.commissionPercent) || 0 },
      { percent: Number(refSettings.level2Percent) || 0 },
      { percent: Number(refSettings.level3Percent) || 0 }
    ];

    let currentUid = auth.uid;
    for (let i = 0; i < 3; i++) {
      if (levels[i].percent <= 0) continue;
      const attrSnap = await database.ref(`referralAttributions/${currentUid}`).get();
      if (!attrSnap.exists()) break; // No more uplines
      
      const uplineUid = attrSnap.val().referrerUid;
      const commAmount = (product.price * levels[i].percent) / 100;
      
      const uplineWalletSnap = await database.ref(`wallets/${uplineUid}/balance`).get();
      const uplineBalance = uplineWalletSnap.exists() ? Number(uplineWalletSnap.val()) : 0;
      
      updates[`wallets/${uplineUid}/balance`] = uplineBalance + commAmount;
      updates[`depositOrders/comm_${purchaseId}_L${i+1}`] = { 
        orderId: `comm_${purchaseId}_L${i+1}`, uid: uplineUid, type: "commission", amount: commAmount, currency: "USDT", status: "completed", createdAt: timestamp 
      };
      currentUid = uplineUid;
    }

    await database.ref().update(updates);
    return res.status(200).json({ success: true, message: "Project purchased successfully!" });

  } catch (error) {
    console.error("Purchase error:", error);
    return res.status(500).json({ success: false, message: "Transaction failed" });
  }
}
