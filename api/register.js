import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { db, normalizeIndianPhone, sha256 } from './_auth.js';
const scrypt = promisify(scryptCallback);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
async function passwordDigest(password, salt) { return (await scrypt(password, salt, 64)).toString('hex'); }
function makeNoirId() { return 'NR-' + randomBytes(6).toString('hex').toUpperCase(); }
async function reserveNoirId(database, uid) {
  for (let i=0; i<8; i++) {
    const id = makeNoirId();
    const tx = await database.ref(`publicIdIndex/${id}`).transaction(current => current === null ? uid : undefined);
    if (tx.committed && tx.snapshot.val() === uid) return id;
  }
  throw new Error('Could not allocate a unique NOIR ID');
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0,100); }
async function registrationRateLimit(database, ip) {
  const ref = database.ref(`registrationRateLimits/${sha256(ip)}`);
  const now = Date.now();
  const tx = await ref.transaction(current => {
    if (!current || now - Number(current.windowStart || 0) > 15*60*1000) return {windowStart:now,count:1};
    if (Number(current.count || 0) >= 10) return;
    return {windowStart:current.windowStart,count:Number(current.count||0)+1};
  });
  return tx.committed;
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control','no-store, private');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({success:false,error:'Method not allowed'}); }
  const phoneNumber = normalizeIndianPhone(req.body?.phoneNumber ?? req.body?.phone);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!phoneNumber) return res.status(400).json({success:false,error:'Enter a valid Indian mobile number (+91 and 10 digits).'});
  if (password.length < 8 || password.length > 128) return res.status(400).json({success:false,error:'Password must be 8–128 characters.'});
  const database = db();
  if (!await registrationRateLimit(database, clientIp(req))) return res.status(429).json({success:false,error:'Too many registration attempts. Try again in 15 minutes.'});
  const phoneHash = sha256(phoneNumber);
  const phoneIndexRef = database.ref(`phoneIndex/${phoneHash}`);
  const uid = 'nr_' + randomBytes(16).toString('hex');
  const reserve = await phoneIndexRef.transaction(current => current === null ? uid : undefined);
  if (!reserve.committed) return res.status(409).json({success:false,error:'This mobile number already has an account. Please sign in.'});
  let noirId = null;
  try {
    noirId = await reserveNoirId(database, uid);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = await passwordDigest(password, salt);
    const now = Date.now();
    const profile = { uid, phoneNumber, noirId, name:'NOIR Member', createdAt:now, lastSeenAt:now, status:'active', authType:'custom' };
    await database.ref().update({
      [`users/${uid}`]: profile,
      [`authCredentials/${uid}`]: { salt, passwordHash, passwordScheme:'scrypt-64-v1', createdAt:now },
      [`publicIdIndex/${noirId}`]: uid
    });
    const sessionToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256(sessionToken);
    await database.ref(`authSessions/${tokenHash}`).set({ uid, createdAt:now, expiresAt:now + SESSION_MS, ipHash:sha256(clientIp(req)) });
    return res.status(201).json({success:true,sessionToken,profile:{uid,name:profile.name,phoneNumber,noirId,createdAt:now,status:'active'}});
  } catch (error) {
    console.error('NOIR registration failed:', error.code || error.message || 'unknown');
    const current = await phoneIndexRef.get().catch(()=>null);
    if (current?.val() === uid) await phoneIndexRef.remove().catch(()=>{});
    if (noirId) {
      const idRef = database.ref(`publicIdIndex/${noirId}`);
      const idSnap = await idRef.get().catch(()=>null);
      if (idSnap?.val() === uid) await idRef.remove().catch(()=>{});
    }
    await database.ref(`users/${uid}`).remove().catch(()=>{});
    await database.ref(`authCredentials/${uid}`).remove().catch(()=>{});
    return res.status(500).json({success:false,error:'Could not create your account. Please try again.'});
  }
}

