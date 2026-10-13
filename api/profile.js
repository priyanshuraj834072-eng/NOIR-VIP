import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { randomBytes } from 'node:crypto';

const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://noir-7a864-default-rtdb.firebaseio.com';

function adminApp() {
  if (getApps().length) return getApps()[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin environment variables are missing');
  }

  privateKey = privateKey.replace(/\\n/g, '\n');

  return initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey
    }),
    databaseURL: DATABASE_URL
  });
}

function makeNoirId() {
  return `NR-${randomBytes(6).toString('hex').toUpperCase()}`;
}

async function reserveNoirId(db, uid) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const noirId = makeNoirId();

    const result = await db
      .ref(`publicIdIndex/${noirId}`)
      .transaction(current => {
        if (current === null) return uid;
        return;
      });

    if (result.committed && result.snapshot.val() === uid) {
      return noirId;
    }
  }

  throw new Error('Could not allocate a unique NOIR ID');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const match = (req.headers.authorization || '')
    .match(/^Bearer (.+)$/);

  if (!match) {
    return res.status(401).json({
      error: 'Missing Firebase ID token'
    });
  }

  let decoded;

  try {
    decoded = await getAuth(adminApp())
      .verifyIdToken(match[1], true);
  } catch (error) {
    console.error(
      'Profile authentication failed:',
      error.code || 'unknown'
    );

    return res.status(401).json({
      error: 'Invalid or expired Firebase ID token'
    });
  }

  try {
    const db = getDatabase(adminApp());
    const profileRef = db.ref(`users/${decoded.uid}`);
    const existing = await profileRef.get();

    let profile = existing.val();

    if (!profile || !profile.noirId) {
      const noirId = await reserveNoirId(db, decoded.uid);

      const result = await profileRef.transaction(current => {
        if (current && current.noirId) return current;

        return {
          ...(current || {}),
          uid: decoded.uid,
          noirId,
          name: decoded.name || current?.name || null,
          createdAt: current?.createdAt || Date.now(),
          status: current?.status || 'active'
        };
      });

      if (!result.committed) {
        throw new Error('Could not save user profile');
      }

      profile = result.snapshot.val();
    } else {
      const updates = {};

      if (decoded.name && profile.name !== decoded.name) {
        updates.name = decoded.name;
      }

      updates.lastSeenAt = Date.now();

      await profileRef.update(updates);
      profile = { ...profile, ...updates };
    }

    return res.status(200).json({
      uid: decoded.uid,
      name: profile.name || null,
      noirId: profile.noirId,
      createdAt: profile.createdAt,
      status: profile.status || 'active'
    });
  } catch (error) {
    console.error(
      'Profile database operation failed:',
      error.code || error.message || 'unknown'
    );

    return res.status(500).json({
      error: 'Could not load or create user profile'
    });
  }
}
