import { db, getAuthenticatedUser } from './_auth.js';
function formatJoinDate(value) {
  if(!value) return 'Date unavailable';
  let date=typeof value==='number'?new Date(value):(/^\d+$/.test(String(value))?new Date(Number(value)):new Date(value));
  if(Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
}
function sendError(res,status,message){return res.status(status).json({success:false,error:message});}
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET'){res.setHeader('Allow','GET');return sendError(res,405,'Method not allowed');}
  try {
    const user=await getAuthenticatedUser(req);
    if(!user) return sendError(res,401,'Authentication required');
    const database=db(); const currentSnapshot=await database.ref(`users/${user.uid}`).get();
    if(!currentSnapshot.exists()) return sendError(res,404,'NOIR profile not found');
    const currentProfile=currentSnapshot.val();
    if(!currentProfile.noirId||currentProfile.status!=='active') return sendError(res,403,'Active NOIR profile required');
    const attributionSnapshot=await database.ref('referralAttributions').get();
    const attributions=attributionSnapshot.exists()?attributionSnapshot.val():{};
    const records=Object.values(attributions).filter(r=>r&&r.status==='attributed'&&r.referredUid&&r.referrerUid);
    const childrenByReferrer=new Map();
    for(const record of records){if(!childrenByReferrer.has(record.referrerUid))childrenByReferrer.set(record.referrerUid,[]);childrenByReferrer.get(record.referrerUid).push(record);}
    const levels={1:[],2:[],3:[]}; const visited=new Set([user.uid]); let parentUids=[user.uid];
    for(let level=1;level<=3;level++){
      const nextUids=[];
      for(const parentUid of parentUids){
        for(const record of (childrenByReferrer.get(parentUid)||[])){
          const memberUid=record.referredUid; if(visited.has(memberUid))continue; visited.add(memberUid);
          const profileSnap=await database.ref(`users/${memberUid}`).get(); if(!profileSnap.exists())continue;
          const profile=profileSnap.val();
          if(profile.status!=='active'||!profile.noirId||profile.noirId!==record.referredNoirId)continue;
          levels[level].push({noirId:profile.noirId,createdAtText:formatJoinDate(profile.createdAt)}); nextUids.push(memberUid);
        }
      }
      parentUids=nextUids; if(!parentUids.length)break;
    }
    return res.status(200).json({success:true,level1:levels[1],level2:levels[2],level3:levels[3],totals:{level1:levels[1].length,level2:levels[2].length,level3:levels[3].length,all:levels[1].length+levels[2].length+levels[3].length}});
  } catch(error) { console.error('NOIR team API error:',error.code||error.message||'unknown'); return sendError(res,500,'Unable to load team data'); }
}
