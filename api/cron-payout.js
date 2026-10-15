import { db } from "./_auth.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n) => Math.round(n * 1e6) / 1e6;

// India (IST) ki date, taaki "aaj" ka matlab 7 PM IST wala din ho
const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // secret set na ho to sab block
  const got = String(req.headers.authorization || "");
  const want = `Bearer ${secret}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function acquireLock(database, key, ttlMs) {
  const ref = database.ref(`locks/${key}`);
  const now = Date.now();
  let got = false;
  const r = await ref.transaction((cur) => {
    got = false;
    if (cur && now - num(cur) < ttlMs) return;
    got = true;
    return now;
  });
  return r.committed && got ? ref : null;
}

async function payUser(database, uid, projects, today) {
  let total = 0;

  for (const [pid, p] of Object.entries(projects || {})) {
    if (!p || num(p.daysRemaining) <= 0) continue;

    // Atomic claim: ek project ek din me sirf ek baar paid hoga
    let claimed = false;
    let amount = 0;
    await database.ref(`user_projects/${uid}/${pid}`).transaction((cur) => {
      claimed = false;
      if (cur === null) return null;
      if (num(cur.daysRemaining) <= 0 || cur.lastPaidDate === today) return;
      claimed = true;
      amount = num(cur.dailyProfit);
      return { ...cur, daysRemaining: num(cur.daysRemaining) - 1, lastPaidDate: today };
    });
    if (claimed) total = round(total + amount);
  }

  if (total <= 0) return 0;

  try {
    await database.ref(`wallets/${uid}`).transaction((w) => {
      const cur = w || {};
      return { ...cur, balance: round(num(cur.balance) + total), totalProfit: round(num(cur.totalProfit) + total) };
    });
    const logId = `profit_${uid}_${today}_${Date.now()}`;
    await database.ref(`depositOrders/${logId}`).set({
      orderId: logId, uid, type: "daily_profit", amount: total, currency: "USDT", status: "completed", createdAt: Date.now(),
    });
  } catch (err) {
    // Claim ho chuka par wallet credit fail: manual retry ke liye record
    console.error("Profit credit failed", uid, total, err);
    await database.ref(`failedPayouts/${uid}_${today}`).set({ uid, amount: total, date: today, at: Date.now() }).catch(() => {});
  }
  return total;
}

export default async function handler(req, res) {
  if (!authorized(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized CRON request" });
  }

  const database = db();
  const lock = await acquireLock(database, "cron_profit", 10 * 60 * 1000);
  if (!lock) return res.status(200).json({ success: true, message: "Another run in progress" });

  try {
    const today = istDate();
    const snap = await database.ref("user_projects").get();
    if (!snap.exists()) return res.status(200).json({ success: true, message: "No projects found" });

    const entries = Object.entries(snap.val());
    let paidUsers = 0;
    let totalPaid = 0;

    for (let i = 0; i < entries.length; i += 10) {
      const chunk = entries.slice(i, i + 10);
      const results = await Promise.allSettled(chunk.map(([uid, projects]) => payUser(database, uid, projects, today)));
      results.forEach((r) => {
        if (r.status === "fulfilled" && r.value > 0) { paidUsers++; totalPaid = round(totalPaid + r.value); }
        else if (r.status === "rejected") console.error("User payout error:", r.reason);
      });
    }

    return res.status(200).json({ success: true, date: today, paidUsers, totalPaid });
  } catch (error) {
    console.error("Cron payout error:", error);
    return res.status(500).json({ success: false, error: "Cron execution failed" });
  } finally {
    try { await lock.remove(); } catch (_) {}
  }
}
