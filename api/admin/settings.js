import { db } from "../_auth.js";

const DEFAULT_SETTINGS = {
  payments: {
    depositEnabled: true, minDeposit: 1, maxDeposit: 100000,
    withdrawalEnabled: true, minWithdrawal: 1, maxWithdrawal: 100000,
  },
  referral: { commissionPercent: 25, level2Percent: 3, level3Percent: 1 },
};

function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAdmin(req) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return false;
  return safeEqual(req.headers["x-admin-username"], username) && safeEqual(req.headers["x-admin-password"], password);
}

function numberValue(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.round(n * 1000000) / 1000000;
}

function cleanProduct(product, existing = {}) {
  const projectType =
    product.projectType === "vip" || product.projectType === "normal"
      ? product.projectType
      : existing.projectType === "vip" ? "vip" : "normal";
  const deadlineDays = projectType === "vip"
    ? Math.floor(numberValue(product.saleDeadlineDays, existing.saleDeadlineDays ?? 0, 0))
    : 0;
  // Deadline wahi rahe to purani end-date, badli ya naya VIP ho to ab se ginti shuru
  const sameDeadline =
    existing.projectType === "vip" && Number(existing.saleEndsAt) > 0 &&
    Number(existing.saleDeadlineDays) === deadlineDays;
  const saleEndsAt = deadlineDays > 0
    ? (sameDeadline ? Number(existing.saleEndsAt) : Date.now() + deadlineDays * 86400000)
    : null;

  return {
    projectType,
    saleDeadlineDays: deadlineDays > 0 ? deadlineDays : null,
    saleEndsAt,
    name: String(product.name ?? existing.name ?? "").trim(),
    description: String(product.description ?? existing.description ?? "").trim(),
    price: numberValue(product.price, existing.price ?? 0, 0.01),
    dailyProfit: numberValue(product.dailyProfit, existing.dailyProfit ?? 0, 0),
    validityDays: Math.floor(numberValue(product.validityDays, existing.validityDays ?? 1, 1)),
    purchaseLimit: Math.floor(numberValue(product.purchaseLimit, existing.purchaseLimit ?? 1, 1)),
    active: typeof product.active === "boolean" ? product.active : existing.active !== false,
    updatedAt: Date.now(),
  };
}

function validateProduct(product) {
  if (!product.name) return "Product name is required";
  if (product.price <= 0) return "Product price must be greater than 0";
  if (product.dailyProfit < 0) return "Daily profit cannot be negative";
  return null;
}

const createProductId = () =>
  ("product_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).toUpperCase();

const fail = (res, code, message) => res.status(code).json({ success: false, message });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");

  try {
    if (req.method === "GET") {
      if (!isAdmin(req)) return fail(res, 403, "Admin access required");
      const database = db();
      const [settingsSnap, productsSnap] = await Promise.all([
        database.ref("adminSettings").get(),
        database.ref("products").get(),
      ]);
      const settings = settingsSnap.exists() ? settingsSnap.val() : DEFAULT_SETTINGS;
      const all = productsSnap.exists() ? productsSnap.val() : {};
      const products = {};
      Object.keys(all).forEach((id) => { if (all[id] && !all[id].deleted) products[id] = all[id]; }); // soft-deleted hide
      return res.status(200).json({ success: true, settings, products });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return fail(res, 405, "Method not allowed");
    }
    if (!isAdmin(req)) return fail(res, 403, "Admin access required");

    const database = db();
    const body = req.body || {};
    const action = String(body.action || "").trim();

    if (action === "updatePayments") {
      const currentSnap = await database.ref("adminSettings").get();
      const current = currentSnap.exists() ? currentSnap.val() : DEFAULT_SETTINGS;
      const p = body.payments || {};
      const c = current.payments || {};

      const minDeposit = numberValue(p.minDeposit, c.minDeposit ?? 1, 0.01);
      const maxDeposit = numberValue(p.maxDeposit, c.maxDeposit ?? 100000, 0.01);
      const minWithdrawal = numberValue(p.minWithdrawal, c.minWithdrawal ?? 1, 0.01);
      const maxWithdrawal = numberValue(p.maxWithdrawal, c.maxWithdrawal ?? 100000, 0.01);

      if (maxDeposit < minDeposit) return fail(res, 400, "Maximum deposit cannot be lower than minimum deposit");
      if (maxWithdrawal < minWithdrawal) return fail(res, 400, "Maximum withdrawal cannot be lower than minimum withdrawal");

      const updated = {
        ...current,
        payments: {
          depositEnabled: typeof p.depositEnabled === "boolean" ? p.depositEnabled : Boolean(c.depositEnabled ?? true),
          minDeposit, maxDeposit,
          withdrawalEnabled: typeof p.withdrawalEnabled === "boolean" ? p.withdrawalEnabled : Boolean(c.withdrawalEnabled ?? true),
          minWithdrawal, maxWithdrawal,
        },
        updatedAt: Date.now(),
      };
      await database.ref("adminSettings").set(updated);
      return res.status(200).json({ success: true, message: "Payment settings saved", settings: updated });
    }

    if (action === "updateReferral") {
      const currentSnap = await database.ref("adminSettings").get();
      const current = currentSnap.exists() ? currentSnap.val() : DEFAULT_SETTINGS;
      const r = current.referral || {};

      // Pehle level2/level3 overwrite hokar delete ho jaate the; ab preserve hote hain
      const l1 = numberValue(body.commissionPercent, r.commissionPercent ?? 25, 0);
      const l2 = numberValue(body.level2Percent, r.level2Percent ?? 3, 0);
      const l3 = numberValue(body.level3Percent, r.level3Percent ?? 1, 0);

      if (l1 > 100 || l2 > 100 || l3 > 100) return fail(res, 400, "Commission cannot exceed 100%");
      if (l1 + l2 + l3 > 100) return fail(res, 400, "Total commission cannot exceed 100%");

      const updated = {
        ...current,
        referral: { commissionPercent: l1, level2Percent: l2, level3Percent: l3 },
        updatedAt: Date.now(),
      };
      await database.ref("adminSettings").set(updated);
      return res.status(200).json({ success: true, message: "Referral settings saved", settings: updated });
    }

    if (action === "updateSalary") {
      const currentSnap = await database.ref("adminSettings").get();
      const current = currentSnap.exists() ? currentSnap.val() : DEFAULT_SETTINGS;

      const payDay = Math.floor(Number(body.payDay));
      if (!Number.isFinite(payDay) || payDay < 1 || payDay > 28) {
        return fail(res, 400, "Pay day must be between 1 and 28");
      }

      const rawTiers = Array.isArray(body.tiers) ? body.tiers : [];
      if (rawTiers.length > 20) return fail(res, 400, "Maximum 20 salary levels allowed");

      const seen = new Set();
      const tiers = [];
      for (const t of rawTiers) {
        const referrals = Math.floor(Number(t && t.referrals));
        const amount = Number(t && t.amount);
        if (!Number.isFinite(referrals) || referrals < 1 || referrals > 1000000) return fail(res, 400, "Each level needs a valid referral count");
        if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return fail(res, 400, "Each level needs a valid salary amount");
        if (seen.has(referrals)) return fail(res, 400, "Two levels have the same referral count: " + referrals);
        seen.add(referrals);
        tiers.push({ referrals, amount: Math.round(amount * 100) / 100 });
      }
      tiers.sort((a, b) => a.referrals - b.referrals);

      const updated = {
        ...current,
        salary: { enabled: body.enabled === true, payDay, tiers },
        updatedAt: Date.now(),
      };
      await database.ref("adminSettings").set(updated);
      return res.status(200).json({ success: true, message: "Salary settings saved", settings: updated });
    }

    if (action === "updateSupport") {
      const currentSnap = await database.ref("adminSettings").get();
      const current = currentSnap.exists() ? currentSnap.val() : DEFAULT_SETTINGS;

      let telegramUsername = String(body.telegramUsername || "").trim()
        .replace(/^https?:\/\/(t|telegram)\.me\//i, "").replace(/^@/, "");
      if (telegramUsername && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegramUsername)) {
        return fail(res, 400, "Telegram username must be 5-32 characters: letters, numbers or underscore");
      }

      const channelLink = String(body.channelLink || "").trim();
      if (channelLink && !/^https:\/\/(t|telegram)\.me\/[A-Za-z0-9_+\-\/]{3,100}$/i.test(channelLink)) {
        return fail(res, 400, "Channel link must look like https://t.me/your_channel");
      }

      const updated = {
        ...current,
        support: { telegramUsername, channelLink },
        updatedAt: Date.now(),
      };
      await database.ref("adminSettings").set(updated);
      return res.status(200).json({ success: true, message: "Support settings saved", settings: updated });
    }

    if (action === "addProduct") {
      const product = cleanProduct(body.product || {});
      const err = validateProduct(product);
      if (err) return fail(res, 400, err);
      const productId = createProductId();
      await database.ref(`products/${productId}`).set({ productId, ...product, createdAt: Date.now() });
      return res.status(200).json({ success: true, message: "Product added", productId, product });
    }

    if (action === "updateProduct") {
      const productId = String(body.productId || "").trim();
      if (!productId) return fail(res, 400, "Product ID is required");
      const productRef = database.ref(`products/${productId}`);
      const snap = await productRef.get();
      if (!snap.exists() || snap.val().deleted) return fail(res, 404, "Product not found");
      const product = cleanProduct(body.product || {}, snap.val());
      const err = validateProduct(product);
      if (err) return fail(res, 400, err);
      await productRef.update(product);
      return res.status(200).json({ success: true, message: "Product updated", productId, product });
    }

    // SOFT DELETE: product hide hota hai, par user_projects (users ki purchases) bilkul touch nahi hoti
    if (action === "deleteProduct") {
      const productId = String(body.productId || "").trim();
      if (!productId) return fail(res, 400, "Product ID is required");
      const productRef = database.ref(`products/${productId}`);
      const snap = await productRef.get();
      if (!snap.exists()) return fail(res, 404, "Product not found");
      await productRef.update({ active: false, deleted: true, deletedAt: Date.now() });
      return res.status(200).json({ success: true, message: "Product deleted" });
    }

    return fail(res, 400, "Unknown admin action");
  } catch (error) {
    console.error("NOIR admin settings error:", error.code || error.message || "unknown");
    return fail(res, 500, "Unable to process admin request");
  }
}
