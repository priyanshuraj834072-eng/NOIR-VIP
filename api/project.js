import { getAuthenticatedUser, db } from "./_auth.js";

function createId() {
  return "pr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  
  // GET: Available products aur user ke My Projects load karne ke liye
  if (req.method === "GET") {
    try {
      const auth = await getAuthenticatedUser(req);
      const database = db();
      
      const [productsSnap, myProjectsSnap] = await Promise.all([
        database.ref("products").get(),
        auth ? database.ref(`user_projects/${auth.uid}`).get() : Promise.resolve({ exists: () => false })
      ]);
      
      const products = [];
      if (productsSnap.exists()) {
        productsSnap.forEach(child => {
          const p = child.val();
          if (p.active !== false) products.push(p);
        });
      }
      
      const myProjects = myProjectsSnap.exists() ? Object.values(myProjectsSnap.val()) : [];
      return res.status(200).json({ success: true, products, myProjects });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to load projects" });
    }
  }

  // POST: Project kharidne ke liye
  if (req.method === "POST") {
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

      // Purchase limit check (Normal aur VIP)
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
      
      // User ke wallet se paisa kato aur usko project de do
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

      // History ke liye Purchase record
      updates[`depositOrders/${purchaseId}`] = {
        orderId: purchaseId, uid: auth.uid, type: "purchase", amount: -product.price, currency: "USDT", status: "completed", createdAt: timestamp
      };

      // 3-Level Instant Referral Commission (25%, 3%, 1%)
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
        if (!attrSnap.exists()) break; // Koi referrer nahi hai, chain break
        
        const uplineUid = attrSnap.val().referrerUid;
        if (!uplineUid) break;

        const commAmount = (product.price * levels[i].percent) / 100;
        
        const uplineWalletSnap = await database.ref(`wallets/${uplineUid}/balance`).get();
        const uplineBalance = uplineWalletSnap.exists() ? Number(uplineWalletSnap.val()) : 0;
        
        // Upline ke wallet me commission add karo
        updates[`wallets/${uplineUid}/balance`] = uplineBalance + commAmount;
        
        // Upline ki history entry
        const commLogId = `comm_${purchaseId}_L${i+1}`;
        updates[`depositOrders/${commLogId}`] = { 
          orderId: commLogId, uid: uplineUid, type: "commission", amount: commAmount, currency: "USDT", status: "completed", createdAt: timestamp 
        };
        currentUid = uplineUid; // Agle level ke liye ID update
      }

      await database.ref().update(updates);
      return res.status(200).json({ success: true, message: "Project purchased successfully!" });

    } catch (error) {
      console.error("Purchase error:", error);
      return res.status(500).json({ success: false, message: "Transaction failed" });
    }
  }
}
