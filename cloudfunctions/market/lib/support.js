'use strict';
const {randomBytes}=require('node:crypto');
const {digest,fail}=require('./store');
const C=require('./common');
const ID=/^SUPPORT-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const SHOP=/^shop-[a-f0-9]{24}$/;
const KEY=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const THREAD_LIMIT=200,MESSAGE_LIMIT=200,THREAD_BYTES=512*1024,INDEX_BYTES=256*1024;
const threadKey=id=>'support-thread:'+id,INDEX='support-index';
const shopId=id=>'shop-'+digest(id).slice(0,24);
const clone=C.clone;
function invalid(){fail(503,'support_data_invalid','咨询记录暂时不可用，请保留填写内容后重试。');}
function bounded(value,max){if(Buffer.byteLength(JSON.stringify(value),'utf8')>max)fail(422,'support_capacity','本轮演示咨询容量已满，请联系平台管理员处理。');return value;}
function text(value){if(typeof value!=='string'||!value.trim()||value.length>600||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(400,'support_message_invalid','请填写1至600字咨询内容。');return value.trim();}
function requestKey(value){if(!KEY.test(value||''))fail(400,'idempotency_invalid','咨询提交编号无效，请重新进入后重试。');return value;}
function contextInput(value){C.V.fields(value,['kind','id'],'support_context_invalid');if(!['product','order','shop'].includes(value.kind)||typeof value.id!=='string'||!(value.kind==='product'?C.V.PRODUCT_ID:value.kind==='order'?C.V.ORDER_ID:SHOP).test(value.id))fail(400,'support_context_invalid','请从有效的商品、店铺或自己的订单发起咨询。');return {kind:value.kind,id:value.id};}
function loadIndex(value,appId){if(!value)return {schemaVersion:1,appId,threads:[]};if(value.schemaVersion!==1||value.appId!==appId||!Array.isArray(value.threads)||value.threads.length>THREAD_LIMIT||value.threads.some(row=>!ID.test(row.id)||!C.V.USER_ID.test(row.buyerId)||!C.V.USER_ID.test(row.sellerId)))invalid();return clone(value);}
function checkThread(row,id,appId){if(!row||row.id!==id||row.appId!==appId)return null;if(row.schemaVersion!==1||!C.V.USER_ID.test(row.buyerId)||!C.V.USER_ID.test(row.sellerId)||!['open','closed'].includes(row.status)||!Number.isSafeInteger(row.version)||row.version<1||!Array.isArray(row.messages)||!row.messages.length||row.messages.length>MESSAGE_LIMIT||row.lastSeq!==row.messages.length||!['buyerReadSeq','merchantReadSeq'].every(k=>Number.isSafeInteger(row[k])&&row[k]>=0&&row[k]<=row.lastSeq)||row.messages.some((m,i)=>m.seq!==i+1||typeof m.text!=='string'||m.text.length>600||!['buyer','merchant'].includes(m.side)||typeof m.id!=='string'||typeof m.createdAt!=='string'))invalid();return row;}
function unread(row,side){const read=row[side+'ReadSeq'];return row.messages.filter(message=>message.side!==side&&message.seq>read).length;}
function summary(row){return {id:row.id,appId:row.appId,buyerId:row.buyerId,sellerId:row.sellerId,context:clone(row.context),subject:row.subject,status:row.status,version:row.version,createdAt:row.createdAt,updatedAt:row.updatedAt,lastMessageAt:row.lastMessageAt,lastMessage:row.messages[row.messages.length-1].text.slice(0,120),lastSeq:row.lastSeq,buyerReadSeq:row.buyerReadSeq,merchantReadSeq:row.merchantReadSeq,buyerUnread:unread(row,'buyer'),merchantUnread:unread(row,'merchant'),createKey:row.createKey};}
function dto(row,side,full=false){const result={id:row.id,context:clone(row.context),subject:row.subject,status:row.status,version:row.version,createdAt:row.createdAt,updatedAt:row.updatedAt,lastMessageAt:row.lastMessageAt,lastMessage:full?row.messages[row.messages.length-1].text.slice(0,120):row.lastMessage,lastSeq:row.lastSeq,readSeq:row[side+'ReadSeq'],unreadCount:full?unread(row,side):row[side+'Unread'],canReply:row.status==='open',canManage:true,canReopen:row.status==='closed'};if(full)result.messages=row.messages.map(({id,seq,side,senderLabel,text,createdAt})=>({id,seq,side,senderLabel,text,createdAt}));return result;}
function accessible(row,user,admin){return row&&(admin?(user.role==='admin'||row.sellerId===user.id):row.buyerId===user.id);}
function createSupport({store,auth,now}){
 async function identity(docs,event,caller,admin,write=false){const user=await auth.identity(docs,event,caller,true,write);if(admin)C.requirePermission(user,'aftersales');return user;}
 async function owned(docs,id,user,caller,admin){const row=checkThread(await docs.get('meta',threadKey(id)),id,caller.appId);if(!accessible(row,user,admin))fail(404,'not_found','咨询不存在或当前账号无权访问。');return row;}
 async function save(tx,row){const index=loadIndex(await tx.get('meta',INDEX),row.appId);const position=index.threads.findIndex(item=>item.id===row.id);if(position<0){if(index.threads.length>=THREAD_LIMIT)fail(422,'support_capacity','当前演示咨询数量已满，请联系平台管理员处理。');index.threads.push(summary(row));}else index.threads[position]=summary(row);await tx.set('meta',threadKey(row.id),bounded(row,THREAD_BYTES));await tx.set('meta',INDEX,bounded(index,INDEX_BYTES));}
 async function seller(docs,id,appId){return C.sellerVisible(docs,id,appId,true);}
 async function resolveContext(tx,context,user,caller,witness){let sellerId,title,product;
  if(context.kind==='order'){const order=await tx.get('orders',context.id);if(!order||order.buyerId!==user.id)fail(404,'support_context_missing','这笔订单不存在或不属于当前买家。');sellerId=order.sellerId;title='订单 '+order.id;await seller(tx,sellerId,caller.appId);}
  else {product=await tx.get('products',context.kind==='product'?context.id:witness);if(!product||product.status!=='published'||context.kind==='shop'&&shopId(product.ownerId)!==context.id)fail(404,'support_context_missing','该商品或店铺暂时无法发起新咨询。');sellerId=product.ownerId;if(!await seller(tx,sellerId,caller.appId))fail(404,'support_context_missing','该商品或店铺暂时无法发起新咨询。');await tx.set('products',product.id,{...product,consultationFence:randomBytes(16).toString('hex')});title=product.product.name;}
  const profile=await tx.get('meta','shop-profile:'+sellerId),sellerUser=await tx.get('users',sellerId),merchant=sellerUser?.merchantId?await tx.get('merchants',sellerId):null;
  if(context.kind==='shop')title=profile?.name||merchant?.name||'景泰采购演示店';
  return {sellerId,context:{...context,title,shopId:shopId(sellerId)}};
 }
 async function create(ctx,user){C.V.fields(ctx.body,['context','text','idempotencyKey']);const context=contextInput(ctx.body.context),message=text(ctx.body.text),key=requestKey(ctx.body.idempotencyKey),fingerprint=digest(JSON.stringify({context,text:message})),createKey=digest(user.id+'\0'+key),id=C.uuid('SUPPORT'),time=now(),messageId=C.uuid('MESSAGE');let witness;
  if(context.kind==='shop')witness=(await C.allProducts(store,{status:'published'})).find(row=>shopId(row.ownerId)===context.id)?.id;
  const result=await store.transaction(async tx=>{const current=await identity(tx,ctx.event,ctx.caller,false,true),index=loadIndex(await tx.get('meta',INDEX),ctx.caller.appId),previous=index.threads.find(row=>row.createKey===createKey);
   if(previous){const row=await owned(tx,previous.id,current,ctx.caller,false);if(row.createFingerprint!==fingerprint)fail(409,'idempotency_conflict','咨询编号已用于其他内容，请核对已发送消息。');return {row,replayed:true};}
   const resolved=await resolveContext(tx,context,current,ctx.caller,witness),row={schemaVersion:1,id,appId:ctx.caller.appId,buyerId:current.id,sellerId:resolved.sellerId,context:resolved.context,subject:resolved.context.title,status:'open',version:1,createdAt:time,updatedAt:time,lastMessageAt:time,lastSeq:1,buyerReadSeq:1,merchantReadSeq:0,createKey,createFingerprint:fingerprint,messages:[{id:messageId,seq:1,side:'buyer',senderLabel:'买家',text:message,createdAt:time}]};await save(tx,row);return {row,replayed:false};
  });return {thread:dto(result.row,'buyer',true),replayed:result.replayed};
 }
 async function mutate(ctx,id,action,admin){const side=admin?'merchant':'buyer';let message,key,fingerprint,time=now(),messageId;
  if(action==='messages'){C.V.fields(ctx.body,['text','idempotencyKey']);message=text(ctx.body.text);key=requestKey(ctx.body.idempotencyKey);fingerprint=digest(JSON.stringify({text:message}));messageId=C.uuid('MESSAGE');}
  else if(action==='read'){C.V.fields(ctx.body,['lastReadSeq']);if(!Number.isSafeInteger(ctx.body.lastReadSeq)||ctx.body.lastReadSeq<0)fail(400,'support_read_invalid','已读位置无效，请重新读取会话。');}
  else {C.V.fields(ctx.body,['status','expectedVersion']);C.V.version(ctx.body.expectedVersion,1);if(!['open','closed'].includes(ctx.body.status))fail(400,'support_status_invalid','请选择有效的咨询状态。');}
  const result=await store.transaction(async tx=>{const current=await identity(tx,ctx.event,ctx.caller,admin,true),row=await owned(tx,id,current,ctx.caller,admin);await seller(tx,row.sellerId,ctx.caller.appId);
   if(action==='messages'){const requestHash=digest(current.id+'\0'+side+'\0'+key),previous=row.messages.find(m=>m.requestHash===requestHash);if(previous){if(previous.fingerprint!==fingerprint)fail(409,'idempotency_conflict','提交编号已用于其他消息，请核对已发送内容。');return {row,replayed:true};}if(row.status!=='open')fail(409,'support_closed','咨询已结束，请重新打开后发送。');if(row.messages.length>=MESSAGE_LIMIT)fail(422,'support_message_limit','该咨询已达到演示消息上限，请另发起一条新咨询。');const seq=row.lastSeq+1,next={...row,version:row.version+1,lastSeq:seq,updatedAt:time,lastMessageAt:time,messages:[...row.messages,{id:messageId,seq,side,senderLabel:admin?(current.role==='admin'?'平台客服':'采购者'):'买家',text:message,createdAt:time,requestHash,fingerprint}]};await save(tx,next);return {row:next,replayed:false};}
   if(action==='read'){if(ctx.body.lastReadSeq>row.lastSeq)fail(400,'support_read_invalid','已读位置超过当前消息，请重新读取。');const readKey=side+'ReadSeq',value=Math.max(row[readKey],ctx.body.lastReadSeq);if(value===row[readKey])return {row};const next={...row,[readKey]:value};await save(tx,next);return {row:next};}
   C.sameVersion(row,ctx.body.expectedVersion);if(row.status===ctx.body.status)return {row};const next={...row,status:ctx.body.status,version:row.version+1,updatedAt:time};await save(tx,next);return {row:next};
  });return {thread:dto(result.row,side,true),...(result.replayed===undefined?{}:{replayed:result.replayed})};
 }
 async function handle(ctx){const match=/^\/(admin\/)?support\/threads(?:\/([^/]+)(?:\/(messages|read|status))?)?$/.exec(ctx.path);if(!match)return null;const admin=!!match[1],id=match[2],action=match[3],side=admin?'merchant':'buyer';if(ctx.url.searchParams.has('cursor'))fail(400,'cursor_invalid','当前咨询列表无需分页，请重新读取。');if(id&&!ID.test(id))fail(404,'not_found','咨询不存在。');const user=await identity(store,ctx.event,ctx.caller,admin);
  if(!id){if(ctx.method==='POST'&&!admin)return create(ctx,user);C.requireMethod(ctx.method,'GET');C.V.fields(ctx.body,[]);const index=loadIndex(await store.get('meta',INDEX),ctx.caller.appId),threads=index.threads.filter(row=>accessible(row,user,admin)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id)).map(row=>dto(row,side));return {threads,nextCursor:null,unreadCount:threads.reduce((total,row)=>total+row.unreadCount,0)};}
  if(action){C.requireMethod(ctx.method,'POST');return mutate(ctx,id,action,admin);}C.requireMethod(ctx.method,'GET');C.V.fields(ctx.body,[]);return {thread:dto(await owned(store,id,user,ctx.caller,admin),side,true)};
 }
 return {handle};
}
module.exports={createSupport,ID,THREAD_LIMIT,MESSAGE_LIMIT,THREAD_BYTES,INDEX_BYTES,threadKey};
