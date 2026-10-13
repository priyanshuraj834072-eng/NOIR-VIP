import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, normalizeIndianPhone, sha256 } from './_auth.js';
const scrypt = promisify(scryptCallback);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
async function passwordDigest(password, salt) { return (await scrypt(password, salt, 64)).toString('hex'); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0,100); }
async function rateLimit(database, ip) {
  const key = sha256(ip);
  const ref = database.ref(`loginRateLimits/${key}`);
  const now = Date.now();
  const tx = await ref.transaction(current => {
    if (!current || now - Number(current.windowStart || 0) > 15*60*1000) return {windowStart:now,count:1};
    if (Number(current.count || 0) >= 20) return;
    return {windowStart:current.windowStart,count:Number(current.count||0)+1};
  });
  return tx.committed;
}
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store, private');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({success:false,error:'Method not allowed'}); }
  const phoneNumber = normalizeIndianPhone(req.body?.phoneNumber ?? req.body?.phone);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!phoneNumber || !password || password.length > 128) return res.status(400).json({success:false,error:'Enter a valid mobile number and password.'});
  const database = db();
  if (!await rateLimit(database, clientIp(req))) return res.status(429).json({success:false,error:'Too many login attempts. Try again in 15 minutes.'});
  const uid = (await database.ref(`phoneIndex/${sha256(phoneNumber)}`).get()).val();
  if (!uid) return res.status(401).json({success:false,error:'Mobile number or password is incorrect.'});
  const [credentialSnap, profileSnap] = await Promise.all([database.ref(`authCredentials/${uid}`).get(),database.ref(`users/${uid}`).get()]);
  if (!credentialSnap.exists() || !profileSnap.exists()) return res.status(401).json({success:false,error:'Mobile number or password is incorrect.'});
  const credential = credentialSnap.val();
  if (credential.passwordScheme !== 'scrypt-64-v1' || !credential.salt || !credential.passwordHash) return res.status(401).json({success:false,error:'Account credentials need support. Contact NOIR support.'});
  const calculated = await passwordDigest(password, credential.salt);
  const a = Buffer.from(calculated,'hex'); const b = Buffer.from(String(credential.passwordHash),'hex');
  if (a.length !== b.length || !timingSafeEqual(a,b)) return res.status(401).json({success:false,error:'Mobile number or password is incorrect.'});
  const profile = profileSnap.val();
  if (profile.status !== 'active') return res.status(403).json({success:false,error:'This account is not active.'});
  const now = Date.now();
  const sessionToken = randomBytes(32).toString('base64url');
  await database.ref(`authSessions/${sha256(sessionToken)}`).set({uid,createdAt:now,expiresAt:now+SESSION_MS,ipHash:sha256(clientIp(req))});
  await database.ref(`users/${uid}/lastSeenAt`).set(now);
  return res.status(200).json({success:true,sessionToken,profile:{uid,name:profile.name||'NOIR Member',phoneNumber:profile.phoneNumber||phoneNumber,noirId:profile.noirId,createdAt:profile.createdAt,status:profile.status}});
}
