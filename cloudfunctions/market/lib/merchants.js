'use strict';
const {fail}=require('./store');
const {merchantDTO}=require('./auth');
const C=require('./common');
function createMerchants({store,auth,now}) {
 async function handle(ctx) {
  const {path,method,body,event,caller,url}=ctx,base='/admin/wechat/merchants';if(path!==base&&!path.startsWith(base+'/'))return null;
  const user=await auth.identity(store,event,caller);if(user.role!=='admin')fail(403,'forbidden','只有平台管理员可管理采购者账号。');
  async function target(docs,id) {const index=await docs.get('merchantIds',id),row=index?await docs.get('merchants',index.userId):null;if(!row||row.id!==id)fail(404,'not_found','采购者不存在。');return row;}
  if(path===base&&method==='GET'){const rows=await store.list('merchants',{}, {limit:100});const rest=rows.length===100?await store.list('merchants',{}, {limit:100,cursor:rows.at(-1).sortKey}):[];return {merchants:[...rows,...rest].map(merchantDTO),updatedAt:now()};}
  const match=/^\/admin\/wechat\/merchants\/([^/]+)(?:\/(audit))?$/.exec(path);if(path!==base&&(!match||!C.V.MERCHANT_ID.test(match[1])))fail(404,'not_found','采购者接口不存在。');
  if(match&&method==='GET'){const row=await target(store,match[1]);if(match[2]){const page=await C.page(store,'merchantAudit',{merchantId:row.id},C.decodeCursor(url.searchParams.get('cursor')));return {events:page.rows.map(({sortKey,actorId,...event})=>event),nextCursor:page.nextCursor};}return {merchant:merchantDTO(row)};}
  if(match?.[2])fail(405,'method_not_allowed','此接口只支持读取。');C.requireMethod(method,path===base?'POST':'PUT');const input=C.V.merchant(body,path!==base),id=path===base?C.uuid('MERCHANT'):match[1],auditId=C.uuid('AUDIT'),time=now();
  return store.transaction(async tx=>{const current=await auth.identity(tx,event,caller,true,true);if(current.role!=='admin')fail(403,'forbidden','只有平台管理员可管理采购者。');const account=await tx.get('users',input.userId);if(!account||account.appId!==caller.appId)fail(422,'merchant_user_unbound','采购者须先从本小程序登录，再提供其账号编号。');if(account.role==='admin')fail(409,'merchant_admin_conflict','不能把平台管理员变为采购者。');const previous=path===base?await tx.get('merchants',input.userId):await target(tx,id);
   if(path===base&&previous)fail(409,'merchant_exists','此账号已有采购者档案。');if(path!==base){if(previous.userId!==input.userId)fail(409,'merchant_user_immutable','采购者绑定账号不能变更。');C.sameVersion(previous,input.expectedVersion);}if(account.role==='merchant'&&account.merchantId!==id)fail(409,'merchant_exists','此账号已绑定另一采购者。');if(!['buyer','merchant'].includes(account.role))fail(409,'merchant_user_invalid','当前账号不能绑定采购者。');
   if(!previous){const count=await tx.get('meta','merchant-count');if((count?.count||0)>=200)fail(422,'merchant_limit','演示云环境最多支持200位采购者。');await tx.set('meta','merchant-count',{count:(count?.count||0)+1});}
   const row={id,userId:input.userId,name:input.name,region:input.region,status:input.status,permissions:input.permissions,version:(previous?.version||0)+1,createdAt:previous?.createdAt||time,updatedAt:time,sortKey:previous?.sortKey||time+'|'+id};await tx.set('merchants',input.userId,row);await tx.set('merchantIds',id,{id,userId:input.userId});await tx.set('users',input.userId,{...account,role:'merchant',merchantId:id,updatedAt:time});await tx.set('merchantAudit',auditId,{id:auditId,merchantId:id,userId:input.userId,actorId:current.id,action:previous?'updated':'created',before:merchantDTO(previous),after:merchantDTO(row),createdAt:time,sortKey:time+'|'+auditId});return {merchant:merchantDTO(row)};
  });
 }
 return {handle};
}
module.exports={createMerchants};
