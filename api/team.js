import { db, getAuthenticatedUser } from './_auth.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n) => Math.round(n * 1e6) / 1e6;

function formatJoinDate(value) {
  if (!value) return 'Date unavailable';
  let date = typeof value === 'number' ? new Date(value) : (/^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(value));
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return sendError(res, 405, 'Method not allowed'); }

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return sendError(res, 401, 'Authentication required');

    const database = db();
    const currentSnapshot = await database.ref(`users/${user.uid}`).get();
    if (!currentSnapshot.exists()) return sendError(res, 404, 'NOIR profile not found');
    const currentProfile = currentSnapshot.val();
    if (!currentProfile.noirId || currentProfile.status !== 'active') return sendError(res, 403, 'Active NOIR profile required');

    const [attributionSnapshot, commissionSnap] = await Promise.all([
      database.ref('referralAttributions').get(),
      database.ref('depositOrders').orderByChild('uid').equalTo(user.uid).get(),
    ]);

    // Is user ko har member se kitni commission mili (fromUid = kharidne wala member)
    const commissionBySource = new Map();
    if (commissionSnap.exists()) {
      commissionSnap.forEach((child) => {
        const o = child.val();
        if (o && o.type === 'commission' && o.fromUid) {
          commissionBySource.set(o.fromUid, round((commissionBySource.get(o.fromUid) || 0) + num(o.amount)));
        }
      });
    }

    const attributions = attributionSnapshot.exists() ? attributionSnapshot.val() : {};
    const records = Object.values(attributions).filter((r) => r && r.status === 'attributed' && r.referredUid && r.referrerUid);
    const childrenByReferrer = new Map();
    for (const record of records) {
      if (!childrenByReferrer.has(record.referrerUid)) childrenByReferrer.set(record.referrerUid, []);
      childrenByReferrer.get(record.referrerUid).push(record);
    }

    const levels = { 1: [], 2: [], 3: [] };
    const visited = new Set([user.uid]);
    let parentUids = [user.uid];

    for (let level = 1; level <= 3; level++) {
      const candidates = [];
      for (const parentUid of parentUids) {
        for (const record of (childrenByReferrer.get(parentUid) || [])) {
          if (visited.has(record.referredUid)) continue;
          visited.add(record.referredUid);
          candidates.push(record);
        }
      }

      // Profiles ek-ek karke nahi, 100-100 ke group me ek saath (badi team par timeout na ho)
      const nextUids = [];
      for (let i = 0; i < candidates.length; i += 100) {
        const chunk = candidates.slice(i, i + 100);
        const snaps = await Promise.all(chunk.map((r) => database.ref(`users/${r.referredUid}`).get()));
        chunk.forEach((record, idx) => {
          const snap = snaps[idx];
          if (!snap.exists()) return;
          const profile = snap.val();
          if (profile.status !== 'active' || !profile.noirId || profile.noirId !== record.referredNoirId) return;
          levels[level].push({
            noirId: profile.noirId,
            createdAtText: formatJoinDate(profile.createdAt),
            joinedAt: num(profile.createdAt),
            commission: round(commissionBySource.get(record.referredUid) || 0),
          });
          nextUids.push(record.referredUid);
        });
      }
      parentUids = nextUids;
      if (!parentUids.length) break;
    }

    const totalCommission = round(
      [...levels[1], ...levels[2], ...levels[3]].reduce((sum, m) => sum + m.commission, 0)
    );

    return res.status(200).json({
      success: true,
      level1: levels[1],
      level2: levels[2],
      level3: levels[3],
      totals: {
        level1: levels[1].length,
        level2: levels[2].length,
        level3: levels[3].length,
        all: levels[1].length + levels[2].length + levels[3].length,
        commission: totalCommission,
      },
    });
  } catch (error) {
    console.error('NOIR team API error:', error.code || error.message || 'unknown');
    return sendError(res, 500, 'Unable to load team data');
  }
}
