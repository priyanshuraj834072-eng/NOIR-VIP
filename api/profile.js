import { randomBytes } from 'node:crypto';
import { db, getAuthenticatedUser } from './_auth.js';
function makeNoirId() { return `NR-${randomBytes(6).toString('hex').toUpperCase()}`; }
async function reserveNoirId(database, uid) {
  for (let attempt=0; attempt<8; attempt++) {
    const noirId=makeNoirId();
    const tx=await database.ref(`publicIdIndex/${noirId}`).transaction(current=>current===null?uid:undefined);
    if(tx.committed && tx.snapshot.val()===uid) return noirId;
  }
  throw new Error('Could not allocate a unique NOIR ID');
}
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
  let user;
  try { user=await getAuthenticatedUser(req); } catch(error) { console.error('Profile auth check failed:',error.code||error.message||'unknown'); }
  if(!user) return res.status(401).json({error:'Missing or invalid session. Please sign in again.'});
  try {
    const database=db(); const profileRef=database.ref(`users/${user.uid}`); const snap=await profileRef.get(); let profile=snap.val();
    if(!profile || !profile.noirId) {
      // This branch preserves compatibility for older Firebase-authenticated accounts.
      if(user.authType==='custom') return res.status(409).json({error:'NOIR profile is missing for this account.'});
      const noirId=await reserveNoirId(database,user.uid);
      const result=await profileRef.transaction(current=>current&&current.noirId?current:{...(current||{}),uid:user.uid,noirId,name:user.decoded?.name||current?.name||null,createdAt:current?.createdAt||Date.now(),status:current?.status||'active'});
      if(!result.committed) throw new Error('Could not save user profile');
      profile=result.snapshot.val();
    } else {
      const updates={lastSeenAt:Date.now()};
      if(user.decoded?.name && profile.name!==user.decoded.name) updates.name=user.decoded.name;
      await profileRef.update(updates); profile={...profile,...updates};
    }
    if(profile.status!=='active') return res.status(403).json({error:'Account is not active'});
    return res.status(200).json({uid:user.uid,name:profile.name||'NOIR Member',phoneNumber:profile.phoneNumber||null,noirId:profile.noirId,createdAt:profile.createdAt,status:profile.status||'active'});
  } catch(error) {
    console.error('Profile database operation failed:',error.code||error.message||'unknown');
    return res.status(500).json({error:'Could not load or create user profile'});
  }
}
