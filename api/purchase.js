import { randomUUID } from "node:crypto";
import { getAuthenticatedUser, db } from "./_auth.js";
const round=n=>Math.round(n*1e6)/1e6;
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store, private");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({success:false,message:"Method not allowed"});}
 try{
  const auth=await getAuthenticatedUser(req); if(!auth?.uid)return res.status(401).json({success:false,message:"Please log in first"});
  const productId=String(req.body?.productId||"").trim(); if(!productId)return res.status(400).json({success:false,message:"Project ID is required"});
  const database=db(), snap=await database.ref(`products/${productId}`).get(); if(!snap.exists())return res.status(404).json({success:false,message:"Project not found"});
  const p=snap.val(), now=Date.now(); if(p.active===false)return res.status(400).json({success:false,message:"Project is not available"});
  const type=p.projectType||"normal"; let saleDeadlineAt=Number(p.saleDeadlineAt||0);
  if(type==="vip"){
   if(!saleDeadlineAt && Number(p.saleDeadlineDays)>0){saleDeadlineAt=Number(p.createdAt||now)+Number(p.saleDeadlineDays)*86400000; await database.ref(`products/${productId}/saleDeadlineAt`).set(saleDeadlineAt);}
   if(!saleDeadlineAt||now>=saleDeadlineAt)return res.status(400).json({success:false,message:"VIP sale deadline has passed"});
  }
  const price=Number(p.price), dailyProfit=Number(p.dailyProfit||0), validityDays=Math.floor(Number(p.validityDays||1)), purchaseLimit=Math.floor(Number(p.purchaseLimit||1));
  if(!Number.isFinite(price)||price<=0||!Number.isFinite(dailyProfit)||dailyProfit<0||!Number.isFinite(validityDays)||validityDays<1||!Number.isFinite(purchaseLimit)||purchaseLimit<1)return res.status(400).json({success:false,message:"Invalid project configuration"});
  const uid=auth.uid, ps=await database.ref("purchases").orderByChild("uid").equalTo(uid).get(); let count=0;
  if(ps.exists())ps.forEach(c=>{const x=c.val();if(x.productId===productId&&["active","completed"].includes(String(x.status)))count++;});
  if(count>=purchaseLimit)return res.status(400).json({success:false,message:"Purchase limit reached for this project"});
  const purchaseId="PUR_"+randomUUID(), walletRef=database.ref(`wallets/${uid}`);
  const debit=await walletRef.transaction(current=>{if(!current)return;const balance=Number(current.balance||0);if(!Number.isFinite(balance)||balance<price)return;current.balance=round(balance-price);current.updatedAt=now;return current;});
  if(!debit.committed)return res.status(400).json({success:false,message:"Insufficient wallet balance"});
  const purchase={purchaseId,uid,productId,productName:String(p.name||""),projectType:type,price:round(price),dailyProfit:round(dailyProfit),validityDays,totalProfit:round(dailyProfit*validityDays),purchaseLimit,status:"active",purchasedAt:now,profitStartAt:now,expiresAt:now+validityDays*86400000,createdAt:now,updatedAt:now};
  try{await database.ref(`purchases/${purchaseId}`).set(purchase);}catch(e){await walletRef.transaction(cur=>{if(!cur)return cur;const refunds=cur.purchaseRefunds||{};if(refunds[purchaseId])return;cur.balance=round(Number(cur.balance||0)+price);cur.purchaseRefunds={...refunds,[purchaseId]:{amount:price,at:Date.now()}};cur.updatedAt=Date.now();return cur;});throw e;}
  // Referral attribution is the canonical source used by the team API. Commission rates are configurable per level.
  const settingsSnap=await database.ref("adminSettings/referral").get(), settings=settingsSnap.val()||{};
  const attributionSnap=await database.ref(`referralAttributions/${uid}`).get(), attribution=attributionSnap.val();
  let currentRef=attribution?.referrerUid||null; const seen=new Set([uid]);
  const levels=[Number(settings.commissionPercent??25),Number(settings.level2Percent??3),Number(settings.level3Percent??1)]; const commissions=[];
  for(let level=1;level<=3&&currentRef;level++){
   if(seen.has(currentRef))break; seen.add(currentRef);
   const pct=levels[level-1];
   if(Number.isFinite(pct)&&pct>0&&pct<=100){const amount=round(price*pct/100);const wr=database.ref(`wallets/${currentRef}`);const tx=await wr.transaction(cur=>{cur=cur||{};const ledger=cur.referralCommissions||{};if(ledger[purchaseId+"_L"+level])return;cur.balance=round(Number(cur.balance||0)+amount);cur.referralCommissions={...ledger,[purchaseId+"_L"+level]:{purchaseId,fromUid:uid,amount,percent:pct,level,at:Date.now()}};cur.updatedAt=Date.now();return cur;});
    if(tx.committed){const record={purchaseId,fromUid:uid,toUid:currentRef,amount,percent:pct,level,createdAt:Date.now()};await database.ref(`referralCommissions/${purchaseId}_L${level}`).set(record);commissions.push(record);}}
   const a=await database.ref(`referralAttributions/${currentRef}`).get(); currentRef=a.val()?.referrerUid||null;
  }
  return res.status(200).json({success:true,message:"Project purchased successfully",purchase,commissions});
 }catch(error){console.error("NOIR purchase error:",error.code||error.message||"unknown");return res.status(500).json({success:false,message:"Unable to complete purchase"});}
}
