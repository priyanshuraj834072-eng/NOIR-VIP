import admin from "firebase-admin";

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://noir-7a864-default-rtdb.firebaseio.com";

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(
    /\\n/g,
    "\n"
  );

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase Admin environment variables are missing");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    databaseURL,
  });
}

const db = admin.database();
const auth = admin.auth();

function formatJoinDate(value) {
  if (!value) return "Date unavailable";

  let date;

  if (typeof value === "number") {
    date = new Date(value);
  } else if (/^\d+$/.test(String(value))) {
    date = new Date(Number(value));
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }

  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message,
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendError(res, 405, "Method not allowed");
  }

  try {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return sendError(res, 401, "Authentication required");
    }

    const decoded = await auth.verifyIdToken(match[1], true);
    const currentUid = decoded.uid;

    // Verify the logged-in user's NOIR profile.
    const currentSnapshot = await db
      .ref(`users/${currentUid}`)
      .get();

    if (!currentSnapshot.exists()) {
      return sendError(res, 404, "NOIR profile not found");
    }

    const currentProfile = currentSnapshot.val();

    if (
      !currentProfile.noirId ||
      currentProfile.status !== "active"
    ) {
      return sendError(res, 403, "Active NOIR profile required");
    }

    // Load referral attribution records.
    const attributionSnapshot = await db
      .ref("referralAttributions")
      .get();

    const attributions = attributionSnapshot.exists()
      ? attributionSnapshot.val()
      : {};

    const records = Object.values(attributions).filter(
      (record) =>
        record &&
        record.status === "attributed" &&
        record.referredUid &&
        record.referrerUid
    );

    // Map each verified referrer's UID to their referred members.
    const childrenByReferrer = new Map();

    for (const record of records) {
      if (!childrenByReferrer.has(record.referrerUid)) {
        childrenByReferrer.set(record.referrerUid, []);
      }

      childrenByReferrer.get(record.referrerUid).push(record);
    }

    const levels = {
      1: [],
      2: [],
      3: [],
    };

    const visited = new Set([currentUid]);
    let parentUids = [currentUid];

    // Build the first three referral levels.
    for (let level = 1; level <= 3; level++) {
      const nextUids = [];

      for (const parentUid of parentUids) {
        const children =
          childrenByReferrer.get(parentUid) || [];

        for (const record of children) {
          const memberUid = record.referredUid;

          // Prevent duplicates and referral cycles.
          if (visited.has(memberUid)) continue;
          visited.add(memberUid);

          // Verify the member's actual profile.
          const profileSnapshot = await db
            .ref(`users/${memberUid}`)
            .get();

          if (!profileSnapshot.exists()) continue;

          const profile = profileSnapshot.val();

          if (
            profile.status !== "active" ||
            !profile.noirId ||
            profile.noirId !== record.referredNoirId
          ) {
            continue;
          }

          levels[level].push({
            noirId: profile.noirId,
            createdAtText: formatJoinDate(
              profile.createdAt
            ),
          });

          nextUids.push(memberUid);
        }
      }

      parentUids = nextUids;

      if (parentUids.length === 0) break;
    }

    return res.status(200).json({
      success: true,
      level1: levels[1],
      level2: levels[2],
      level3: levels[3],
      totals: {
        level1: levels[1].length,
        level2: levels[2].length,
        level3: levels[3].length,
        all:
          levels[1].length +
          levels[2].length +
          levels[3].length,
      },
    });
  } catch (error) {
    console.error("NOIR team API error:", error.message);

    if (
      error.code === "auth/id-token-expired" ||
      error.code === "auth/argument-error" ||
      error.code === "auth/invalid-id-token" ||
      error.code === "auth/id-token-revoked"
    ) {
      return sendError(res, 401, "Please sign in again");
    }

    return sendError(res, 500, "Unable to load team data");
  }
}
