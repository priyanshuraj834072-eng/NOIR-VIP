import { db } from "./_auth.js";
const round=n=>Math.round(n*1e6)/1e6;
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET"&&req.method!=="POST")return res.status(405).json({success:false,message:"Method not allowed"});
 const secret=process.env.CRON_SECRET;
 if(!secret||req.headers.authorization!==`Bearer ${secret}`)return res.status(401).json({success:false,message:"Unauthorized"});
 try{
  const database=db(), now=Date.now(), dayKey=new Date(now).toISOString().slice(0,10);
  const snap=await database.ref("purchases").get(); let checked=0,paid=0,amountTotal=0;
  if(snap.exists()){
   const jobs=[];
   snap.forEach(child=>{const p=child.val(); if(!p?.uid||!p.purchaseId||!Number.isFinite(Number(p.dailyProfit))||Number(p.dailyProfit)<=0)return;
    const start=Number(p.profitStartAt||p.purchasedAt||0), end=Number(p.expiresAt||0); if(now<start+86400000||now>=end||!["active","completed"].includes(String(p.status)))return;
    // One payout per purchase per India calendar day; a wallet transaction stores the ledger and balance atomically.
    const indiaDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(now));
    jobs.push({p,day:indiaDay});
   });
   for(const job of jobs){checked++;const p=job.p, key=`${p.purchaseId}_${job.day}`, walletRef=database.ref(`wallets/${p.uid}`), income=round(Number(p.dailyProfit));
    const tx=await walletRef.transaction(cur=>{cur=cur||{};const ledger=cur.projectEarnings||{};if(ledger[key])return;cur.balance=round(Number(cur.balance||0)+income);cur.totalProjectProfit=round(Number(cur.totalProjectProfit||0)+income);cur.projectEarnings={...ledger,[key]:{purchaseId:p.purchaseId,productId:p.productId,amount:income,day:job.day,createdAt:now}};cur.updatedAt=now;return cur;});
    if(tx.committed){paid++;amountTotal=round(amountTotal+income);await database.ref(`purchases/${p.purchaseId}/lastProfitAt`).set(now);}
   }
  }
  return res.status(200).json({success:true,dayKey,checked,paid,amountTotal});
 }catch(error){console.error("NOIR cron error:",error.code||error.message||"unknown");return res.status(500).json({success:false,message:"Daily payout failed"});}
}
