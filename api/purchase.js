import { randomUUID } from "node:crypto";
import { getAuthenticatedUser, db } from "./_auth.js";

const round = (n) => Math.round(n * 1e6) / 1e6;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const auth = await getAuthenticatedUser(req);

    if (!auth?.uid) {
      return res.status(401).json({
        success: false,
        message: "Please log in first",
      });
    }

    const productId = String(req.body?.productId || "").trim();

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required",
      });
    }

    const database = db();

    const productSnap = await database
      .ref(`products/${productId}`)
      .get();

    if (!productSnap.exists()) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const product = productSnap.val();

    if (product.active === false) {
      return res.status(400).json({
        success: false,
        message: "This product is currently unavailable",
      });
    }

    const price = Number(product.price);
    const dailyProfit = Number(product.dailyProfit || 0);
    const validityDays = Math.floor(Number(product.validityDays || 1));
    const purchaseLimit = Math.floor(Number(product.purchaseLimit || 1));

    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(dailyProfit) ||
      dailyProfit < 0 ||
      !Number.isFinite(validityDays) ||
      validityDays < 1
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid product configuration",
      });
    }

    const uid = auth.uid;

    const walletRef = database.ref(`wallets/${uid}`);

    /*
      Count active purchases of this product.
      Purchase history is kept separate from the wallet.
    */
    const purchasesSnap = await database
      .ref("purchases")
      .orderByChild("uid")
      .equalTo(uid)
      .get();

    let productPurchaseCount = 0;

    if (purchasesSnap.exists()) {
      purchasesSnap.forEach((child) => {
        const purchase = child.val();

        if (
          purchase.productId === productId &&
          ["active", "completed"].includes(
            String(purchase.status)
          )
        ) {
          productPurchaseCount++;
        }
      });
    }

    if (productPurchaseCount >= purchaseLimit) {
      return res.status(400).json({
        success: false,
        message: "Purchase limit reached for this product",
      });
    }

    const purchaseId = "PUR_" + randomUUID();
    const now = Date.now();

    /*
      Wallet deduction is atomic.
      The purchase is only created after the deduction succeeds.
    */
    const debit = await walletRef.transaction((current) => {
      if (!current) return;

      const balance = Number(current.balance || 0);

      if (!Number.isFinite(balance) || balance < price) {
        return;
      }

      current.balance = round(balance - price);
      current.updatedAt = now;

      return current;
    });

    if (!debit.committed) {
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance",
      });
    }

    const purchase = {
      purchaseId,
      uid,
      productId,
      productName: String(product.name || ""),
      price: round(price),
      dailyProfit: round(dailyProfit),
      validityDays,
      totalProfit: round(dailyProfit * validityDays),
      purchaseLimit,
      status: "active",
      purchasedAt: now,
      profitStartAt: now,
      nextProfitAt: now,
      expiresAt:
        now + validityDays * 24 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await database
        .ref(`purchases/${purchaseId}`)
        .set(purchase);
    } catch (error) {
      /*
        If the purchase record cannot be written after
        the wallet was debited, refund the exact amount
        once using an idempotent transaction.
      */
      await walletRef.transaction((current) => {
        if (!current) return current;

        const refunds = current.purchaseRefunds || {};

        if (refunds[purchaseId]) return;

        current.balance = round(
          Number(current.balance || 0) + price
        );

        current.purchaseRefunds = {
          ...refunds,
          [purchaseId]: {
            amount: price,
            at: Date.now(),
          },
        };

        current.updatedAt = Date.now();

        return current;
      });

      throw error;
    }

    /*
      Referral commission is calculated from the purchase
      price. The referrer is read from the user's profile.
    */
    const settingsSnap = await database
      .ref("adminSettings")
      .get();

    const settings = settingsSnap.exists()
      ? settingsSnap.val()
      : {};

    const commissionPercent = Number(
      settings.referral?.commissionPercent || 0
    );

    let commission = 0;
    let referrerUid = null;

    if (
      Number.isFinite(commissionPercent) &&
      commissionPercent > 0 &&
      commissionPercent <= 100
    ) {
      const userSnap = await database
        .ref(`users/${uid}`)
        .get();

      const user = userSnap.exists()
        ? userSnap.val()
        : {};

      referrerUid =
        user.referrerUid ||
        user.referredBy ||
        user.referralUid ||
        null;

      if (
        referrerUid &&
        referrerUid !== uid
      ) {
        commission = round(
          (price * commissionPercent) / 100
        );

        const referrerWalletRef =
          database.ref(`wallets/${referrerUid}`);

        await referrerWalletRef.transaction(
          (current) => {
            const wallet = current || {};
            const commissions =
              wallet.referralCommissions || {};

            if (commissions[purchaseId]) {
              return;
            }

            wallet.balance = round(
              Number(wallet.balance || 0) +
                commission
            );

            wallet.referralCommissions = {
              ...commissions,
              [purchaseId]: {
                fromUid: uid,
                amount: commission,
                percent: commissionPercent,
                at: Date.now(),
              },
            };

            wallet.updatedAt = Date.now();

            return wallet;
          }
        );

        await database
          .ref(
            `referralCommissions/${purchaseId}`
          )
          .set({
            purchaseId,
            fromUid: uid,
            toUid: referrerUid,
            amount: commission,
            percent: commissionPercent,
            createdAt: Date.now(),
          });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Product purchased successfully",
      purchase: {
        purchaseId,
        productId,
        productName: purchase.productName,
        price: purchase.price,
        dailyProfit: purchase.dailyProfit,
        validityDays: purchase.validityDays,
        totalProfit: purchase.totalProfit,
        status: purchase.status,
        purchasedAt: purchase.purchasedAt,
        expiresAt: purchase.expiresAt,
      },
      referral: {
        commission,
        commissionPercent,
        referrerUid,
      },
    });
  } catch (error) {
    console.error(
      "NOIR purchase error:",
      error.code || error.message || "unknown"
    );

    return res.status(500).json({
      success: false,
      message: "Unable to complete purchase",
    });
  }
}
