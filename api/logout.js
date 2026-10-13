import { db, sha256 } from './_auth.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store, private');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({success:false,error:'Method not allowed'}); }
  const match = String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(200).json({success:true});
  await db().ref(`authSessions/${sha256(match[1].trim())}`).remove();
  return res.status(200).json({success:true});
}
