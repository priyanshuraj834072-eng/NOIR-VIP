import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function adminApp() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  return initializeApp({ credential: cert(JSON.parse(raw)), databaseURL: 'https://noir-7a864-default-rtdb.firebaseio.com' });
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: 'Missing Firebase ID token' });
  try {
    const decoded = await getAuth(adminApp()).verifyIdToken(match[1], true);
    return res.status(200).json({ uid: decoded.uid, email: decoded.email || null, name: decoded.name || null });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired Firebase ID token' });
  }
}
