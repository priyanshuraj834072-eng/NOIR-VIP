import { db, getAuthenticatedUser } from "../_auth.js";

const DEFAULT_SETTINGS = {
  payments: {
    depositEnabled: true,
    minDeposit: 1,
    maxDeposit: 100000,

    withdrawalEnabled: true,
    minWithdrawal: 1,
    maxWithdrawal: 100000,
  },
};

function isAdmin(user) {
  // Admin UID ko Vercel Environment Variable me rakhenge.
  const adminUid = process.env.ADMIN_UID;

  return Boolean(
    adminUid &&
    user &&
    user.uid &&
    user.uid === adminUid
  );
}

function cleanNumber(value, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }

  return Math.round(n * 100) / 100;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");

  try {
    const user = await getAuthenticatedUser(req);

    if (!user || !user.uid) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!isAdmin(user)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    const database = db();
    const settingsRef = database.ref("adminSettings");

    // GET = current settings
    if (req.method === "GET") {
      const snap = await settingsRef.get();

      if (!snap.exists()) {
        await settingsRef.set(DEFAULT_SETTINGS);

        return res.status(200).json({
          success: true,
          settings: DEFAULT_SETTINGS,
        });
      }

      return res.status(200).json({
        success: true,
        settings: snap.val(),
      });
    }

    // POST = update settings
    if (req.method === "POST") {
      const currentSnap = await settingsRef.get();
      const current = currentSnap.exists()
        ? currentSnap.val()
        : DEFAULT_SETTINGS;

      const body = req.body || {};
      const payments = body.payments || {};

      const minDeposit = cleanNumber(
        payments.minDeposit,
        current.payments?.minDeposit ?? 1
      );

      const maxDeposit = cleanNumber(
        payments.maxDeposit,
        current.payments?.maxDeposit ?? 100000
      );

      const minWithdrawal = cleanNumber(
        payments.minWithdrawal,
        current.payments?.minWithdrawal ?? 1
      );

      const maxWithdrawal = cleanNumber(
        payments.maxWithdrawal,
        current.payments?.maxWithdrawal ?? 100000
      );

      if (minDeposit <= 0 || maxDeposit < minDeposit) {
        return res.status(400).json({
          success: false,
          message: "Invalid deposit limits",
        });
      }

      if (minWithdrawal <= 0 || maxWithdrawal < minWithdrawal) {
        return res.status(400).json({
          success: false,
          message: "Invalid withdrawal limits",
        });
      }

      const updatedSettings = {
        payments: {
          depositEnabled:
            typeof payments.depositEnabled === "boolean"
              ? payments.depositEnabled
              : Boolean(current.payments?.depositEnabled ?? true),

          minDeposit,
          maxDeposit,

          withdrawalEnabled:
            typeof payments.withdrawalEnabled === "boolean"
              ? payments.withdrawalEnabled
              : Boolean(current.payments?.withdrawalEnabled ?? true),

          minWithdrawal,
          maxWithdrawal,
        },

        updatedAt: Date.now(),
        updatedBy: user.uid,
      };

      await settingsRef.set(updatedSettings);

      return res.status(200).json({
        success: true,
        message: "Payment settings updated",
        settings: updatedSettings,
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
      message: "Unable to manage admin settings",
    });
  }
}
