import { db } from "../_auth.js";

const DEFAULT_SETTINGS = {
  payments: {
    depositEnabled: true,
    minDeposit: 1,
    maxDeposit: 100000,

    withdrawalEnabled: true,
    minWithdrawal: 1,
    maxWithdrawal: 100000,
  },

  referral: {
    commissionPercent: 25,
  },
};

function isAdmin(req) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) return false;

  const receivedUsername = String(
    req.headers["x-admin-username"] || ""
  );

  const receivedPassword = String(
    req.headers["x-admin-password"] || ""
  );

  return (
    receivedUsername === username &&
    receivedPassword === password
  );
}

function numberValue(value, fallback, min = 0) {
  const n = Number(value);

  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }

  return Math.round(n * 1000000) / 1000000;
}

function cleanProduct(product, existing = {}) {
  const name = String(
    product.name ?? existing.name ?? ""
  ).trim();

  const description = String(
    product.description ?? existing.description ?? ""
  ).trim();

  const price = numberValue(
    product.price,
    existing.price ?? 0,
    0
  );

  const dailyProfit = numberValue(
    product.dailyProfit,
    existing.dailyProfit ?? 0,
    0
  );

  const validityDays = Math.floor(
    numberValue(
      product.validityDays,
      existing.validityDays ?? 1,
      1
    )
  );

  const purchaseLimit = Math.floor(
    numberValue(
      product.purchaseLimit,
      existing.purchaseLimit ?? 1,
      1
    )
  );

  const active =
    typeof product.active === "boolean"
      ? product.active
      : existing.active !== false;

  return {
    name,
    description,
    price,
    dailyProfit,
    validityDays,
    purchaseLimit,
    active,
    updatedAt: Date.now(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");

  try {
    /*
      GET:
      Publicly returns only safe configuration/product data.
      No admin credentials or secrets are returned.
    */

    if (req.method === "GET") {
      const database = db();

      const [settingsSnap, productsSnap] = await Promise.all([
        database.ref("adminSettings").get(),
        database.ref("products").get(),
      ]);

      const settings = settingsSnap.exists()
        ? settingsSnap.val()
        : DEFAULT_SETTINGS;

      const products = productsSnap.exists()
        ? productsSnap.val()
        : {};

      return res.status(200).json({
        success: true,
        settings,
        products,
      });
    }

    /*
      POST:
      Only admin can modify settings/products.
    */

    if (req.method === "POST") {
      if (!isAdmin(req)) {
        return res.status(403).json({
          success: false,
          message: "Admin access required",
        });
      }

      const database = db();
      const body = req.body || {};
      const action = String(body.action || "").trim();

      /*
        PAYMENT SETTINGS
      */

      if (action === "updatePayments") {
        const currentSnap =
          await database.ref("adminSettings").get();

        const current = currentSnap.exists()
          ? currentSnap.val()
          : DEFAULT_SETTINGS;

        const payments = body.payments || {};

        const minDeposit = numberValue(
          payments.minDeposit,
          current.payments?.minDeposit ?? 1,
          0.01
        );

        const maxDeposit = numberValue(
          payments.maxDeposit,
          current.payments?.maxDeposit ?? 100000,
          0.01
        );

        const minWithdrawal = numberValue(
          payments.minWithdrawal,
          current.payments?.minWithdrawal ?? 1,
          0.01
        );

        const maxWithdrawal = numberValue(
          payments.maxWithdrawal,
          current.payments?.maxWithdrawal ?? 100000,
          0.01
        );

        if (maxDeposit < minDeposit) {
          return res.status(400).json({
            success: false,
            message: "Maximum deposit cannot be lower than minimum deposit",
          });
        }

        if (maxWithdrawal < minWithdrawal) {
          return res.status(400).json({
            success: false,
            message:
              "Maximum withdrawal cannot be lower than minimum withdrawal",
          });
        }

        const updated = {
          ...current,

          payments: {
            depositEnabled:
              typeof payments.depositEnabled === "boolean"
                ? payments.depositEnabled
                : Boolean(
                    current.payments?.depositEnabled ?? true
                  ),

            minDeposit,
            maxDeposit,

            withdrawalEnabled:
              typeof payments.withdrawalEnabled === "boolean"
                ? payments.withdrawalEnabled
                : Boolean(
                    current.payments?.withdrawalEnabled ?? true
                  ),

            minWithdrawal,
            maxWithdrawal,
          },

          updatedAt: Date.now(),
        };

        await database.ref("adminSettings").set(updated);

        return res.status(200).json({
          success: true,
          message: "Payment settings saved",
          settings: updated,
        });
      }

      /*
        REFERRAL SETTINGS
      */

      if (action === "updateReferral") {
        const currentSnap =
          await database.ref("adminSettings").get();

        const current = currentSnap.exists()
          ? currentSnap.val()
          : DEFAULT_SETTINGS;

        const percent = numberValue(
          body.commissionPercent,
          current.referral?.commissionPercent ?? 25,
          0
        );

        if (percent > 100) {
          return res.status(400).json({
            success: false,
            message: "Commission cannot exceed 100%",
          });
        }

        const updated = {
          ...current,

          referral: {
            commissionPercent: percent,
          },

          updatedAt: Date.now(),
        };

        await database.ref("adminSettings").set(updated);

        return res.status(200).json({
          success: true,
          message: "Referral settings saved",
          settings: updated,
        });
      }

      /*
        ADD PRODUCT
      */

      if (action === "addProduct") {
        const productId =
          "product_" +
          cryptoRandomId();

        const product = cleanProduct(body.product || {});

        if (!product.name) {
          return res.status(400).json({
            success: false,
            message: "Product name is required",
          });
        }

        if (product.price <= 0) {
          return res.status(400).json({
            success: false,
            message: "Product price must be greater than 0",
          });
        }

        await database
          .ref(`products/${productId}`)
          .set({
            productId,
            ...product,
            createdAt: Date.now(),
          });

        return res.status(200).json({
          success: true,
          message: "Product added",
          productId,
          product,
        });
      }

      /*
        EDIT PRODUCT
      */

      if (action === "updateProduct") {
        const productId = String(body.productId || "").trim();

        if (!productId) {
          return res.status(400).json({
            success: false,
            message: "Product ID is required",
          });
        }

        const productRef =
          database.ref(`products/${productId}`);

        const snap = await productRef.get();

        if (!snap.exists()) {
          return res.status(404).json({
            success: false,
            message: "Product not found",
          });
        }

        const product = cleanProduct(
          body.product || {},
          snap.val()
        );

        if (!product.name) {
          return res.status(400).json({
            success: false,
            message: "Product name is required",
          });
        }

        if (product.price <= 0) {
          return res.status(400).json({
            success: false,
            message: "Product price must be greater than 0",
          });
        }

        await productRef.update(product);

        return res.status(200).json({
          success: true,
          message: "Product updated",
          productId,
          product,
        });
      }

      /*
        DELETE PRODUCT
      */

      if (action === "deleteProduct") {
        const productId = String(body.productId || "").trim();

        if (!productId) {
          return res.status(400).json({
            success: false,
            message: "Product ID is required",
          });
        }

        const productRef =
          database.ref(`products/${productId}`);

        const snap = await productRef.get();

        if (!snap.exists()) {
          return res.status(404).json({
            success: false,
            message: "Product not found",
          });
        }

        await productRef.remove();

        return res.status(200).json({
          success: true,
          message: "Product deleted",
        });
      }

      return res.status(400).json({
        success: false,
        message: "Unknown admin action",
      });
    }

    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  } catch (error) {
    console.error(
      "NOIR admin settings error:",
      error.code || error.message || "unknown"
    );

    return res.status(500).json({
      success: false,
      message: "Unable to process admin request",
    });
  }
}

/*
  Small server-side ID generator.
  No external package required.
*/
function cryptoRandomId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  ).toUpperCase();
}
