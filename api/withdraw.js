import crypto, { randomUUID } from "node:crypto";
import { getAuthenticatedUser, db } from "./_auth.js";

const round = (n) => Math.round(n * 1e6) / 1e6;

function detectNetwork(address) {
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return "TRC20";
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return "BEP20";
  return null;
}

function addressKey(address, network) {
  const normalized = network === "BEP20" ? address.toLowerCase() : address;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const auth = await getAuthenticatedUser(req);
    if (!auth || !auth.uid) {
      return res.status(401).json({ success: false, message: "Please log in first" });
    }

    const sandbox = process.env.OXAPAY_SANDBOX === "true";
    const payoutKey = process.env.OXAPAY_PAYOUT_API_KEY;
    const baseUrl = process.env.SITE_URL || "https://noir-vip.vercel.app";

    // Real payouts need the payout key. Sandbox never sends real money.
    if (!sandbox && !payoutKey) {
      return res.status(500).json({ success: false, message: "Payout configuration is missing" });
    }

    const requested = Number(req.body && req.body.amount);
    const address = String((req.body && req.body.address) || "").trim();

    if (!Number.isFinite(requested) || requested < 1) {
      return res.status(400).json({ success: false, message: "Minimum withdrawal is 1 USDT" });
    }
    const amount = Math.round(requested * 100) / 100;

    const network = detectNetwork(address);
    if (!network) {
      return res.status(400).json({ success: false, message: "Enter a valid USDT address (TRC20 or BEP20)" });
    }

    const database = db();

    // 1. One address can belong to only one account.
    const lockRef = database.ref("addressLocks/" + addressKey(address, network));
    const lock = await lockRef.transaction((current) => {
      if (current === null) return { uid: auth.uid, network, at: Date.now() };
      if (current.uid !== auth.uid) return; // belongs to someone else -> abort
      return current;
    });
    if (!lock.committed) {
      return res.status(409).json({ success: false, message: "This address is already linked to another account" });
    }

    // 2. Save the request
    const withdrawalId = "WDR_" + randomUUID();
    const requestRef = database.ref("withdrawalRequests/" + withdrawalId);
    await requestRef.set({
      withdrawalId,
      uid: auth.uid,
      amount,
      currency: "USDT",
      address,
      network,
      sandbox,
      status: "creating",
      createdAt: Date.now(),
    });

    // 3. Deduct balance atomically
    const walletRef = database.ref("wallets/" + auth.uid);
    const debit = await walletRef.transaction((current) => {
      if (current === null) return current;
      const balance = Number(current.balance || 0);
      const debited = current.debited || {};
      if (debited[withdrawalId]) return;
      if (balance < amount) return;
      current.balance = round(balance - amount);
      current.debited = { ...debited, [withdrawalId]: { amount, at: Date.now() } };
      current.updatedAt = Date.now();
      return current;
    });

    const after = debit.snapshot.val();
    if (!debit.committed || !after || !after.debited || !after.debited[withdrawalId]) {
      await requestRef.update({ status: "rejected", reason: "insufficient_balance", updatedAt: Date.now() });
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // 4a. Sandbox: simulate only, no real money leaves OxaPay.
    if (sandbox) {
      await requestRef.update({ status: "sandbox_simulated", updatedAt: Date.now() });
      return res.status(200).json({
        success: true,
        withdrawalId,
        amount,
        currency: "USDT",
        status: "sandbox_simulated",
      });
    }

    await requestRef.update({ status: "processing", updatedAt: Date.now() });

    // 4b. Live: send the payout through OxaPay
    let response;
    let result;
    try {
      response = await fetch("https://api.oxapay.com/v1/payout", {
        method: "POST",
        headers: { payout_api_key: payoutKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          currency: "USDT",
          amount,
          network,
          description: withdrawalId,
          callback_url: baseUrl + "/api/oxapay-webhook",
        }),
      });
      result = await response.json().catch(() => ({}));
    } catch (networkError) {
      // Unknown outcome: the payout may have gone through. Do NOT refund automatically.
      console.error("OxaPay payout network error:", networkError.message);
      await requestRef.update({ status: "review_required", reason: "payout_unknown", updatedAt: Date.now() });
      return res.status(202).json({ success: true, withdrawalId, status: "review_required" });
    }

    if (!response.ok || !result.data || !result.data.track_id) {
      // Clear failure from OxaPay -> refund once.
      console.error("OxaPay payout failed: HTTP " + response.status + " | " + JSON.stringify(result.error || result.message || result));

      await walletRef.transaction((current) => {
        if (current === null) return current;
        const refunded = current.refunded || {};
        if (refunded[withdrawalId]) return;
        if (!(current.debited || {})[withdrawalId]) return;
        current.balance = round(Number(current.balance || 0) + amount);
        current.refunded = { ...refunded, [withdrawalId]: { amount, at: Date.now() } };
        current.updatedAt = Date.now();
        return current;
      });

      await requestRef.update({
        status: "failed",
        reason: String((result.error && result.error.message) || result.message || "payout_failed"),
        updatedAt: Date.now(),
      });
      return res.status(502).json({ success: false, message: "Payout failed, balance returned" });
    }

    // 5. Payout accepted by OxaPay. Final status arrives on the webhook.
    const trackId = String(result.data.track_id);
    await database.ref("payoutTracks/" + trackId).set(withdrawalId);
    await requestRef.update({
      status: "processing",
      trackId,
      payoutStatus: String(result.data.status || ""),
      updatedAt: Date.now(),
    });

    return res.status(200).json({
      success: true,
      withdrawalId,
      amount,
      currency: "USDT",
      status: "processing",
    });
  } catch (error) {
    console.error("NOIR withdraw error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to process withdrawal" });
  }
}
