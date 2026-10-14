import { db } from "../_auth.js";

const DEFAULT_SETTINGS = {
  payments: { depositsEnabled: true, withdrawalsEnabled: true },
  referral: { level1Percent: 25, level2Percent: 3, level3Percent: 1, commissionPercent: 25 },
};
const round = (n) => Math.round(n * 1e6) / 1e6;
const safeNumber = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const cleanProduct = (input = {}, old = {}) => {
  const name = String(input.name ?? old.name ?? "").trim().slice(0, 120);
  const description = String(input.description ?? old.description ?? "").trim().slice(0, 2000);
  const price = safeNumber(input.price ?? old.price, 0, 0.000001, 1e12);
  const dailyProfit = safeNumber(input.dailyProfit ?? old.dailyProfit, 0, 0, 1e9);
  const validityDays = Math.floor(safeNumber(input.validityDays ?? input.earningDurationDays ?? old.validityDays ?? old.earningDurationDays, 1, 1, 36500));
  const purchaseLimit = Math.floor(safeNumber(input.purchaseLimit ?? old.purchaseLimit, 1, 1, 100000));
  const projectType = String(input.projectType ?? old.projectType ?? input.type ?? old.type ?? "normal").toLowerCase() === "vip" ? "vip" : "normal";
  let saleEndsAt = null;
  const rawDeadline = input.saleEndsAt ?? input.purchaseDeadline ?? old.saleEndsAt ?? old.purchaseDeadline ?? null;
  if (projectType === "vip" && rawDeadline !== null && rawDeadline !== "") {
    const parsed = typeof rawDeadline === "number" ? rawDeadline : Date.parse(rawDeadline);
    if (Number.isFinite(parsed)) saleEndsAt = parsed;
  }
  return {
    ...old,
    name,
    description,
    price: round(price),
    dailyProfit: round(dailyProfit),
    validityDays,
    earningDurationDays: validityDays,
    purchaseLimit,
    projectType,
    type: projectType,
    saleEndsAt: projectType === "vip" ? saleEndsAt : null,
    purchaseDeadline: projectType === "vip" ? saleEndsAt : null,
    active: input.active === undefined ? (old.active !== false) : input.active === true || input.active === "true" || input.active === 1,
    updatedAt: Date.now(),
  };
};
const cleanPercent = (value, fallback) => safeNumber(value, fallback, 0, 100);
function isAdmin(req) {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  return Boolean(expectedUser && expectedPass &&
    req.headers["x-admin-username"] === expectedUser &&
    req.headers["x-admin-password"] === expectedPass);
}
function response(res, status, body) { return res.status(status).json(body); }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return response(res, 405, { success: false, message: "Method not allowed" });
  }
  if (!isAdmin(req)) return response(res, 401, { success: false, message: "Unauthorized" });
  try {
    const database = db();
    if (req.method === "GET") {
      const [settingsSnap, productsSnap] = await Promise.all([
        database.ref("adminSettings").get(), database.ref("products").get(),
      ]);
      const settings = { ...DEFAULT_SETTINGS, ...(settingsSnap.exists() ? settingsSnap.val() : {}) };
      settings.payments = { ...DEFAULT_SETTINGS.payments, ...(settings.payments || {}) };
      settings.referral = { ...DEFAULT_SETTINGS.referral, ...(settings.referral || {}) };
      return response(res, 200, { success: true, settings, products: productsSnap.exists() ? productsSnap.val() : {} });
    }

    const body = req.body || {};
    const action = String(body.action || "");
    const settingsRef = database.ref("adminSettings");
    if (action === "updatePayments") {
      const payments = {
        depositsEnabled: body.depositsEnabled === true || body.depositsEnabled === "true",
        withdrawalsEnabled: body.withdrawalsEnabled === true || body.withdrawalsEnabled === "true",
      };
      await settingsRef.child("payments").update(payments);
      return response(res, 200, { success: true, payments });
    }
    if (action === "updateReferral") {
      const input = body.referral || body;
      const referral = {
        level1Percent: cleanPercent(input.level1Percent ?? input.commissionPercent, 25),
        level2Percent: cleanPercent(input.level2Percent, 3),
        level3Percent: cleanPercent(input.level3Percent, 1),
      };
      // Keep the legacy field for older frontend/API compatibility.
      referral.commissionPercent = referral.level1Percent;
      await settingsRef.child("referral").update(referral);
      return response(res, 200, { success: true, referral });
    }
    if (action === "addProduct") {
      const product = cleanProduct(body.product || body);
      if (!product.name || product.price <= 0 || product.dailyProfit < 0) {
        return response(res, 400, { success: false, message: "Valid project name and price are required" });
      }
      if (product.projectType === "vip" && product.saleEndsAt === null) {
        return response(res, 400, { success: false, message: "VIP project needs a valid sale deadline" });
      }
      const ref = database.ref("products").push();
      await ref.set({ ...product, id: ref.key, createdAt: Date.now() });
      return response(res, 200, { success: true, product: { ...product, id: ref.key } });
    }
    if (action === "updateProduct") {
      const productId = String(body.productId || body.id || "").trim();
      if (!productId) return response(res, 400, { success: false, message: "Project ID is required" });
      const ref = database.ref(`products/${productId}`);
      const snap = await ref.get();
      if (!snap.exists()) return response(res, 404, { success: false, message: "Project not found" });
      const product = cleanProduct(body.product || body, snap.val());
      if (!product.name || product.price <= 0) return response(res, 400, { success: false, message: "Valid project name and price are required" });
      if (product.projectType === "vip" && product.saleEndsAt === null) return response(res, 400, { success: false, message: "VIP project needs a valid sale deadline" });
      await ref.update(product);
      return response(res, 200, { success: true, product: { ...product, id: productId } });
    }
    if (action === "deleteProduct") {
      const productId = String(body.productId || body.id || "").trim();
      if (!productId) return response(res, 400, { success: false, message: "Project ID is required" });
      const ref = database.ref(`products/${productId}`);
      const snap = await ref.get();
      if (!snap.exists()) return response(res, 404, { success: false, message: "Project not found" });
      // Archive/deactivate instead of deleting so purchase history stays meaningful.
      await ref.update({ active: false, archived: true, updatedAt: Date.now() });
      return response(res, 200, { success: true, message: "Project deactivated" });
    }
    return response(res, 400, { success: false, message: "Unknown action" });
  } catch (error) {
    console.error("NOIR admin settings error:", error.code || error.message || "unknown");
    return response(res, 500, { success: false, message: "Unable to update admin settings" });
  }
}
