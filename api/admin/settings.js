import { getAuthenticatedUser, db } from "./_auth.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n) => Math.round(n * 1e6) / 1e6;
const createId = () => "pr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const pct = (v, d) => (v === undefined || v === null ? d : Math.min(100, Math.max(0, num(v))));

// Per-user lock: ek time par ek hi purchase (double click / parallel request block)
async function acquireLock(database, key, ttlMs = 20000) {
  const ref = database.ref(`locks/${key}`);
  const now = Date.now();
  let got = false;
  const r = await ref.transaction((cur) => {
    got = false;
    if (cur && now - num(cur) < ttlMs) return; // lock abhi active hai -> abort
    got = true;
    return now;
  });
  return r.committed && got ? ref : null;
}
const releaseLock = async (ref) => { try { await ref.remove(); } catch (_) {} };

// Atomic wallet debit: balance kam ho to false
async function debitWallet(database, uid, price) {
  let ok = false;
  await database.ref(`wallets/${uid}`).transaction((w) => {
    ok = false;
    const cur = w || {};
    const bal = num(cur.balance);
    if (bal < price) return w === null ? { balance: 0 } : undefined;
    ok = true;
    return { ...cur, balance: round(bal - price), totalInvested: round(num(cur.totalInvested) + price) };
  });
  return ok;
}

// Atomic wallet credit
async function creditWallet(database, uid, amount, extraField) {
  await database.ref(`wallets/${uid}`).transaction((w) => {
    const cur = w || {};
    const next = { ...cur, balance: round(num(cur.balance) + amount) };
    if (extraField) next[extraField] = round(num(cur[extraField]) + amount);
    return next;
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      const auth = await getAuthenticatedUser(req);
      const database = db();
      const [productsSnap, myProjectsSnap] = await Promise.all([
        database.ref("products").get(),
        auth ? database.ref(`user_projects/${auth.uid}`).get() : Promise.resolve({ exists: () => false }),
      ]);
      const products = [];
      if (productsSnap.exists()) {
        productsSnap.forEach((child) => {
          const p = child.val();
          if (p.active !== false && p.deleted !== true) products.push(p);
        });
      }
      const myProjects = myProjectsSnap.exists() ? Object.values(myProjectsSnap.val()) : [];
      return res.status(200).json({ success: true, products, myProjects });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to load projects" });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let lockRef = null;
  try {
    const auth = await getAuthenticatedUser(req);
    if (!auth || !auth.uid) return res.status(401).json({ success: false, message: "Please log in first" });

    const productId = String((req.body || {}).productId || "").trim();
    if (!productId) return res.status(400).json({ success: false, message: "Product ID required" });

    const database = db();
    const uid = auth.uid;

    lockRef = await acquireLock(database, `purchase_${uid}`);
    if (!lockRef) return res.status(429).json({ success: false, message: "Another purchase is in progress. Please wait." });

    const [productSnap, myProjectsSnap, settingsSnap] = await Promise.all([
      database.ref(`products/${productId}`).get(),
      database.ref(`user_projects/${uid}`).get(),
      database.ref("adminSettings/referral").get(),
    ]);

    if (!productSnap.exists()) return res.status(404).json({ success: false, message: "Project not found" });
    const product = productSnap.val();
    if (product.active === false || product.deleted === true) {
      return res.status(400).json({ success: false, message: "Project is currently unavailable" });
    }

    const price = num(product.price);
    const dailyProfit = num(product.dailyProfit);
    const validityDays = Math.floor(num(product.validityDays));
    const limit = Math.floor(num(product.purchaseLimit)) || 1;
    if (price <= 0 || validityDays < 1) return res.status(400).json({ success: false, message: "Invalid project configuration" });

    let activeCount = 0;
    if (myProjectsSnap.exists()) {
      myProjectsSnap.forEach((child) => {
        const p = child.val();
        if (p.productId === productId && num(p.daysRemaining) > 0) activeCount++;
      });
    }
    if (activeCount >= limit) {
      return res.status(400).json({ success: false, message: `Limit reached. You can only have ${limit} active at a time.` });
    }

    // 1) Atomic paisa katna
    const debited = await debitWallet(database, uid, price);
    if (!debited) return res.status(400).json({ success: false, message: "Insufficient USDT balance" });

    // 2) Project + history likhna (fail ho to refund)
    const purchaseId = createId();
    const timestamp = Date.now();
    try {
      await database.ref().update({
        [`user_projects/${uid}/${purchaseId}`]: {
          id: purchaseId, productId, name: product.name, price, dailyProfit,
          totalDays: validityDays, daysRemaining: validityDays, purchasedAt: timestamp,
        },
        [`depositOrders/${purchaseId}`]: {
          orderId: purchaseId, uid, type: "purchase", amount: -price, currency: "USDT", status: "completed", createdAt: timestamp,
        },
      });
    } catch (err) {
      console.error("Purchase write failed, refunding:", err);
      await database.ref(`wallets/${uid}`).transaction((w) => {
        const cur = w || {};
        return { ...cur, balance: round(num(cur.balance) + price), totalInvested: round(Math.max(0, num(cur.totalInvested) - price)) };
      });
      return res.status(500).json({ success: false, message: "Transaction failed" });
    }

    // 3) Referral commission: har level ko ek purchase par sirf ek baar
    try {
      const ref = settingsSnap.exists() ? settingsSnap.val() : {};
      const percents = [pct(ref.commissionPercent, 25), pct(ref.level2Percent, 3), pct(ref.level3Percent, 1)];
      const visited = new Set([uid]);
      let currentUid = uid;

      for (let i = 0; i < 3; i++) {
        const attrSnap = await database.ref(`referralAttributions/${currentUid}`).get();
        if (!attrSnap.exists()) break;
        const uplineUid = attrSnap.val().referrerUid;
        if (!uplineUid || visited.has(uplineUid)) break; // self-referral / loop block
        visited.add(uplineUid);
        currentUid = uplineUid;

        if (percents[i] <= 0) continue;
        const commAmount = round((price * percents[i]) / 100);
        if (commAmount <= 0) continue;

        const commLogId = `comm_${purchaseId}_L${i + 1}`;
        let claimed = false;
        await database.ref(`depositOrders/${commLogId}`).transaction((cur) => {
          claimed = false;
          if (cur !== null) return; // already paid
          claimed = true;
          return { orderId: commLogId, uid: uplineUid, type: "commission", amount: commAmount, currency: "USDT", status: "completed", fromUid: uid, level: i + 1, createdAt: timestamp };
        });
        if (claimed) await creditWallet(database, uplineUid, commAmount, "totalCommission");
      }
    } catch (err) {
      // Purchase ho chuka hai; commission error ko log karo, user ko fail mat dikhao
      console.error("Commission error for", purchaseId, err);
      await database.ref(`failedCommissions/${purchaseId}`).set({ uid, purchaseId, price, at: Date.now() }).catch(() => {});
    }

    return res.status(200).json({ success: true, message: "Project purchased successfully!" });
  } catch (error) {
    console.error("Purchase error:", error);
    return res.status(500).json({ success: false, message: "Transaction failed" });
  } finally {
    if (lockRef) await releaseLock(lockRef);
  }
}
