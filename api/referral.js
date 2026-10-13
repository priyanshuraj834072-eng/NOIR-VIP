import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://noir-7a864-default-rtdb.firebaseio.com';

function adminApp() {
  if (getApps().length) {
    return getApps()[0];
  }

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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
      'Referral authentication failed:',
      error.code || 'unknown'
    );

    return res.status(401).json({
      error: 'Invalid or expired Firebase ID token'
    });
  }

  try {
    const db = getDatabase(adminApp());

    const body = req.body || {};
    const referrerNoirId = String(body.referrerNoirId || '')
      .trim()
      .toUpperCase();

    if (!/^NR-[A-Z0-9]{6,20}$/.test(referrerNoirId)) {
      return res.status(400).json({
        error: 'Invalid referral ID'
      });
    }

    const newUserUid = decoded.uid;
    const newUserRef = db.ref(`users/${newUserUid}`);

    const newUserSnapshot = await newUserRef.get();
    const newUserProfile = newUserSnapshot.val();

    if (!newUserProfile || !newUserProfile.noirId) {
      return res.status(409).json({
        error: 'Create your NOIR profile before applying a referral'
      });
    }

    if (newUserProfile.noirId === referrerNoirId) {
      return res.status(400).json({
        error: 'Self-referrals are not allowed'
      });
    }

    const referrerIndexSnapshot = await db
      .ref(`publicIdIndex/${referrerNoirId}`)
      .get();

    const referrerUid = referrerIndexSnapshot.val();

    if (!referrerUid || referrerUid === newUserUid) {
      return res.status(404).json({
        error: 'Referral account not found'
      });
    }

    const referrerProfileSnapshot = await db
      .ref(`users/${referrerUid}`)
      .get();

    const referrerProfile = referrerProfileSnapshot.val();

    if (
      !referrerProfile ||
      referrerProfile.noirId !== referrerNoirId ||
      referrerProfile.status !== 'active'
    ) {
      return res.status(404).json({
        error: 'Referral account is unavailable'
      });
    }

    const attributionRef = db.ref(
      `referralAttributions/${newUserUid}`
    );

    const result = await attributionRef.transaction(current => {
      if (current !== null) {
        return;
      }

      return {
        referredUid: newUserUid,
        referredNoirId: newUserProfile.noirId,
        referrerUid,
        referrerNoirId,
        createdAt: Date.now(),
        status: 'attributed'
      };
    });

    if (!result.committed) {
      return res.status(409).json({
        error: 'Referral has already been assigned'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Referral recorded successfully'
    });
  } catch (error) {
    console.error(
      'Referral database operation failed:',
      error.code || error.message || 'unknown'
    );

    return res.status(500).json({
      error: 'Could not record referral'
    });
  }
}
