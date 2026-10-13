import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { createHash } from 'node:crypto';

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://noir-7a864-default-rtdb.firebaseio.com';

export function adminApp() {
  if (getApps().length) return getApps()[0];
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase Admin environment variables are missing');
  privateKey = privateKey.replace(/\\n/g, '\n');
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL });
}
export function db() { return getDatabase(adminApp()); }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function normalizeIndianPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/[\s()-]/g, '').replace(/^\+/, '');
  let national = digits;
  if (digits.startsWith('91') && digits.length === 12) national = digits.slice(2);
  if (!/^[6-9]\d{9}$/.test(national)) return null;
  return '+91' + national;
}
export async function getAuthenticatedUser(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token || token.length > 4096) return null;
  const database = db();
  const tokenHash = sha256(token);
  const sessionRef = database.ref(`authSessions/${tokenHash}`);
  const sessionSnap = await sessionRef.get();
  if (sessionSnap.exists()) {
    const session = sessionSnap.val();
    if (session && session.uid && Number(session.expiresAt) > Date.now()) {
      return { uid: session.uid, authType: 'custom', token, tokenHash, session };
    }
    await sessionRef.remove().catch(() => {});
    return null;
  }
  // Keep existing Firebase-authenticated accounts/API clients compatible during migration.
  if (token.split('.').length === 3) {
    try {
      const decoded = await getAuth(adminApp()).verifyIdToken(token, true);
      return { uid: decoded.uid, authType: 'firebase', token, decoded };
    } catch { return null; }
  }
  return null;
}
