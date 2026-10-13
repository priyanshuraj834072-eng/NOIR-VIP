import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

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
    })
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);

  if (!match) {
    return res.status(401).json({
      error: 'Missing Firebase ID token'
    });
  }

  try {
    const decoded = await getAuth(adminApp()).verifyIdToken(match[1], true);

    return res.status(200).json({
      uid: decoded.uid,
      name: decoded.name || null
    });
  } catch (error) {
    console.error('Profile authentication failed:', error.code || 'unknown');

    return res.status(401).json({
      error: 'Invalid or expired Firebase ID token'
    });
  }
}
