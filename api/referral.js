import { db, getAuthenticatedUser } from './_auth.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'Method not allowed'});}
  let user;
  try { user=await getAuthenticatedUser(req); } catch(error) { console.error('Referral auth failed:',error.code||error.message||'unknown'); }
  if(!user) return res.status(401).json({error:'Invalid session. Please sign in again.'});
  try {
    const database=db(); const referrerNoirId=String(req.body?.referrerNoirId||'').trim().toUpperCase();
    if(!/^NR-[A-Z0-9]{6,20}$/.test(referrerNoirId)) return res.status(400).json({error:'Invalid referral ID'});
    const newUserUid=user.uid;
    const newUserProfile=(await database.ref(`users/${newUserUid}`).get()).val();
    if(!newUserProfile?.noirId) return res.status(409).json({error:'Create your NOIR profile before applying a referral'});
    if(newUserProfile.noirId===referrerNoirId) return res.status(400).json({error:'Self-referrals are not allowed'});
    const referrerUid=(await database.ref(`publicIdIndex/${referrerNoirId}`).get()).val();
    if(!referrerUid||referrerUid===newUserUid) return res.status(404).json({error:'Referral account not found'});
    const referrerProfile=(await database.ref(`users/${referrerUid}`).get()).val();
    if(!referrerProfile||referrerProfile.noirId!==referrerNoirId||referrerProfile.status!=='active') return res.status(404).json({error:'Referral account is unavailable'});
    const attributionRef=database.ref(`referralAttributions/${newUserUid}`);
    const tx=await attributionRef.transaction(current=>current===null?{referredUid:newUserUid,referredNoirId:newUserProfile.noirId,referrerUid,referrerNoirId,createdAt:Date.now(),status:'attributed'}:undefined);
    if(!tx.committed) return res.status(409).json({error:'Referral has already been assigned'});
    return res.status(200).json({success:true,message:'Referral recorded successfully'});
  } catch(error) { console.error('Referral DB operation failed:',error.code||error.message||'unknown'); return res.status(500).json({error:'Could not record referral'}); }
}
