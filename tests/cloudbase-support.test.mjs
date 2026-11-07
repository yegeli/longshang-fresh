import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryCloudbaseDB} from './fixtures/cloudbase-db.mjs';
const require=createRequire(import.meta.url);
const {CloudbaseStore,COLLECTIONS,digest,key}=require('../cloudfunctions/market/lib/store');
const {createMarketApi}=require('../cloudfunctions/market/lib/api');
const {schemaVersion,manifestHash}=require('../cloudfunctions/market/lib/provision-contract');
const {THREAD_LIMIT,MESSAGE_LIMIT,THREAD_BYTES,threadKey}=require('../cloudfunctions/market/lib/support');
const APPID='wx1111111111111111',ENV='support-test-environment';
const account=name=>'wechat:'+digest(APPID+'\0'+name),shop=name=>'shop-'+digest(account(name)).slice(0,24);
async function setup(){
 const db=new MemoryCloudbaseDB(),store=new CloudbaseStore(db),env={WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV,BOOTSTRAP_ADMIN_ACCOUNT_ID:account('admin')};let clock=Date.parse('2026-11-07T08:00:00.000Z');
 await store.set('meta','provision-ready',{id:'provision-ready',schemaVersion,manifestHash,appId:APPID,envId:ENV,ready:true,verifiedAt:new Date(clock).toISOString(),operatorAccountId:account('operator')});
 const client=name=>{let token;const api=createMarketApi({store,env,getContext:()=>({APPID,OPENID:name,ENV}),now:()=>new Date(clock++).toISOString()});return {async call(path,method='GET',body,extra={}){return api({path:'/api/v1'+path,method,...(body===undefined?{}:{body}),...(token?{sessionToken:token,expectedUserId:account(name)}:{}),...extra});},async login(){const r=await this.call('/auth/wechat/login','POST',{});assert.equal(r.status,200,JSON.stringify(r));token=r.body.token;}};};
 const admin=client('admin'),buyer=client('buyer');await admin.login();await buyer.login();assert.equal((await admin.call('/admin/seed','POST',{})).status,200);return {store,db,client,admin,buyer};
}
async function merchant(f,name,permissions=['products','orders','aftersales']){const client=f.client(name);await client.login();const r=await f.admin.call('/admin/wechat/merchants','POST',{userId:account(name),name:'模拟采购者'+name,region:'甘肃景泰（模拟）',status:'enabled',permissions});assert.equal(r.status,200,JSON.stringify(r));return {client,profile:r.body.merchant};}
async function sellerProduct(f,seller,id='seller-apple'){const p=await f.store.get('products','jingtai-apple');const r=await seller.client.call('/admin/products/'+id,'PUT',{expectedVersion:0,product:{...p.product,id}});assert.equal(r.status,200,JSON.stringify(r));return r.body.product;}
const create=(user,context={kind:'product',id:'jingtai-apple'},text='这款模拟苹果大小怎么样？',idempotencyKey='create-consultation-001')=>user.call('/support/threads','POST',{context,text,idempotencyKey});
const get=(user,id,admin=false)=>user.call((admin?'/admin':'')+'/support/threads/'+id);
const send=(user,id,text='模拟咨询补充',idempotencyKey='message-consultation-001',admin=false)=>user.call((admin?'/admin':'')+'/support/threads/'+id+'/messages','POST',{text,idempotencyKey});
const read=(user,id,lastReadSeq,admin=false)=>user.call((admin?'/admin':'')+'/support/threads/'+id+'/read','POST',{lastReadSeq});
const status=(user,id,expectedVersion,value,admin=false)=>user.call((admin?'/admin':'')+'/support/threads/'+id+'/status','POST',{expectedVersion,status:value});
async function beforeNextCommit(db,callback){const start=db.startTransaction.bind(db);let once=true;db.startTransaction=async()=>{const tx=await start(),commit=tx.commit.bind(tx);tx.commit=async()=>{if(once){once=false;await callback();}return commit();};return tx;};}
async function order(f,sellerId=account('admin')){const id='DEMO-00000000-0000-0000-0000-000000000001';await f.store.set('orders',id,{id,buyerId:account('buyer'),sellerId,data:{id,status:'created',merchantNote:'私密备注不能进入咨询',items:[{product:'历史模拟苹果'}]},version:1});return id;}
test('cloud consultations persist across clients, replay create once and expose only participant-safe DTOs',async()=>{
 const f=await setup(),inventory=await f.store.get('inventory','jingtai-apple');const [a,b]=await Promise.all([create(f.buyer),create(f.buyer)]);assert.equal(a.status,200,JSON.stringify(a));assert.equal(b.status,200);assert.equal(a.body.thread.id,b.body.thread.id);assert.equal(a.body.thread.messages.length,1);assert.equal(f.db.dump(COLLECTIONS.meta).filter(row=>row.id?.startsWith('SUPPORT-')).length,1);
 const phone=f.client('buyer');await phone.login();const detail=(await get(phone,a.body.thread.id)).body.thread;assert.equal(detail.context.title,'景泰红富士苹果');assert.equal(detail.context.shopId,shop('admin'));assert.equal(detail.unreadCount,0);assert.equal(detail.messages[0].side,'buyer');assert.equal(detail.canReply,true);assert.equal(detail.readSeq,1);
 const inbox=(await f.admin.call('/admin/support/threads')).body;assert.equal(inbox.threads.length,1);assert.equal(inbox.unreadCount,1);assert.ok(!('messages' in inbox.threads[0]));
 const serialized=JSON.stringify([detail,inbox]);for(const forbidden of ['wechat:','buyerId','sellerId','sessionToken','requestHash','createKey','merchantNote'])assert.ok(!serialized.includes(forbidden),forbidden);assert.deepEqual(await f.store.get('inventory','jingtai-apple'),inventory);
 assert.equal((await create(f.buyer,undefined,'修改的第一条')).body.error.code,'idempotency_conflict');
});
test('buyer, seller and administrator access stays scoped and context ownership is resolved on the server',async()=>{
 const f=await setup(),a=await merchant(f,'seller-a'),b=await merchant(f,'seller-b'),readless=await merchant(f,'only-products',['products']);const p=await sellerProduct(f,a),r=await create(f.buyer,{kind:'product',id:p.id}),id=r.body.thread.id;
 const outsider=f.client('outsider');await outsider.login();assert.equal((await get(outsider,id)).status,404);assert.equal((await send(outsider,id)).status,404);assert.equal((await get(b.client,id,true)).status,404);assert.deepEqual((await b.client.call('/admin/support/threads')).body.threads,[]);assert.equal((await get(readless.client,id,true)).status,403);assert.equal((await get(a.client,id,true)).status,200);assert.equal((await get(f.admin,id,true)).status,200);
 assert.equal((await f.client('anonymous').call('/support/threads')).status,401);assert.equal((await create(f.buyer,{kind:'shop',id:shop('seller-a')},'店铺模拟问题','shop-consultation-001')).status,200);
 const ownOrder=await order(f,account('seller-a'));assert.equal((await create(outsider,{kind:'order',id:ownOrder})).status,404);const orderThread=await create(f.buyer,{kind:'order',id:ownOrder},'历史订单问题','order-consultation-001');assert.equal(orderThread.status,200);assert.ok(!JSON.stringify(orderThread.body).includes('私密备注'));assert.equal(orderThread.body.thread.context.id,ownOrder);
 assert.equal((await f.buyer.call('/support/threads','POST',{context:{kind:'product',id:p.id,ownerId:account('seller-b')},text:'伪造所属',idempotencyKey:'forged-owner-id-001'})).status,400);
 assert.equal((await f.buyer.call('/admin/support/threads')).status,403);assert.equal((await f.admin.call('/admin/support/threads','POST',{})).status,405);
});
test('message retries and concurrent two-sided messages append exactly once without erasing unread state',async()=>{
 const f=await setup(),id=(await create(f.buyer)).body.thread.id;
 const duplicates=await Promise.all([send(f.buyer,id),send(f.buyer,id)]);assert.ok(duplicates.every(r=>r.status===200));assert.equal((await get(f.buyer,id)).body.thread.messages.length,2);assert.equal((await send(f.buyer,id,'同一编号的不同内容')).body.error.code,'idempotency_conflict');
 const results=await Promise.all([send(f.buyer,id,'买家并发文字','concurrent-buyer-001'),send(f.admin,id,'客服并发回复','concurrent-merchant-001',true)]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
 const buyer=(await get(f.buyer,id)).body.thread,staff=(await get(f.admin,id,true)).body.thread;assert.deepEqual(buyer.messages.map(m=>m.seq),[1,2,3,4]);assert.equal(buyer.messages.length,4);assert.equal(buyer.unreadCount,1);assert.equal(staff.unreadCount,3);assert.equal(staff.readSeq,0);
 const confirmed=await read(f.admin,id,2,true);assert.equal(confirmed.body.thread.unreadCount,1);assert.equal(confirmed.body.thread.version,4);assert.equal((await read(f.admin,id,1,true)).body.thread.readSeq,2);
});
test('read acknowledgements cannot clear messages arriving after the viewed sequence',async()=>{
 const f=await setup(),id=(await create(f.buyer)).body.thread.id;
 await send(f.admin,id,'第一个客服回复','staff-first-reply',true);await send(f.admin,id,'稍后到达的新回复','staff-second-reply',true);
 let shown=(await read(f.buyer,id,2)).body.thread;assert.equal(shown.readSeq,2);assert.equal(shown.unreadCount,1);assert.equal(shown.lastSeq,3);assert.equal(shown.version,3);
 assert.equal((await read(f.buyer,id,99)).status,400);assert.equal((await read(f.buyer,id,-1)).status,400);shown=(await get(f.buyer,id)).body.thread;assert.equal(shown.unreadCount,1);
 assert.equal((await read(f.buyer,id,3)).body.thread.unreadCount,0);assert.equal((await f.buyer.call('/support/threads')).body.unreadCount,0);
});
test('a new staff message racing a buyer read acknowledgement stays unread after transaction retry',async()=>{
 const f=await setup(),id=(await create(f.buyer)).body.thread.id;await send(f.admin,id,'最初可见回复','read-race-first-message',true);
 await beforeNextCommit(f.db,async()=>assert.equal((await send(f.admin,id,'读请求期间的新回复','read-race-second-message',true)).status,200));
 const ack=await read(f.buyer,id,2);assert.equal(ack.status,200);assert.equal(ack.body.thread.lastSeq,3);assert.equal(ack.body.thread.readSeq,2);assert.equal(ack.body.thread.unreadCount,1);assert.equal(ack.body.thread.version,3);
 assert.equal((await f.buyer.call('/support/threads')).body.unreadCount,1);assert.ok(f.db.rollbacks>0);
});
test('one admin account acting as buyer and staff has independent side-specific unread positions and message keys',async()=>{
 const f=await setup(),id=(await create(f.admin)).body.thread.id;assert.equal((await get(f.admin,id,true)).body.thread.unreadCount,1);
 assert.equal((await send(f.admin,id,'平台作为客服回复','same-key-different-side',true)).status,200);assert.equal((await get(f.admin,id)).body.thread.unreadCount,1);assert.equal((await read(f.admin,id,2)).body.thread.unreadCount,0);assert.equal((await get(f.admin,id,true)).body.thread.unreadCount,1);
 assert.equal((await send(f.admin,id,'平台作为买家补充','same-key-different-side')).status,200);const staff=(await read(f.admin,id,2,true)).body.thread;assert.equal(staff.unreadCount,1);assert.equal(staff.readSeq,2);assert.equal(staff.messages[1].side,'merchant');assert.equal(staff.messages[2].side,'buyer');
});
test('closed consultations require an explicit versioned reopen and idempotent old sends still replay',async()=>{
 const f=await setup(),id=(await create(f.buyer)).body.thread.id;const sent=await send(f.buyer,id,'已发送文字','close-replay-key');let version=sent.body.thread.version;
 const closed=await status(f.buyer,id,version,'closed');assert.equal(closed.status,200);assert.equal(closed.body.thread.canReply,false);assert.equal(closed.body.thread.canReopen,true);version++;
 assert.equal((await send(f.admin,id,'不该发送','closed-new-message',true)).body.error.code,'support_closed');assert.equal((await send(f.buyer,id,'已发送文字','close-replay-key')).body.replayed,true);
 assert.equal((await status(f.admin,id,1,'open',true)).body.error.code,'version_conflict');const reopened=await status(f.admin,id,version,'open',true);assert.equal(reopened.body.thread.status,'open');assert.equal(reopened.body.thread.canReopen,false);assert.equal((await send(f.admin,id,'重新接待','reopened-reply',true)).status,200);
});
test('disabled seller cannot read or reply; buyer can consult a past order and platform can take over',async()=>{
 const f=await setup(),a=await merchant(f,'stopped-seller'),p=await sellerProduct(f,a),id=(await create(f.buyer,{kind:'product',id:p.id})).body.thread.id,orderId=await order(f,account('stopped-seller'));
 const stopped=await f.admin.call('/admin/wechat/merchants/'+a.profile.id,'PUT',{userId:a.profile.userId,name:a.profile.name,region:a.profile.region,status:'disabled',permissions:a.profile.permissions,expectedVersion:a.profile.version});assert.equal(stopped.status,200);
 assert.equal((await get(a.client,id,true)).status,403);assert.equal((await send(a.client,id,'不能回复','stopped-seller-reply',true)).status,403);assert.equal((await create(f.buyer,{kind:'product',id:p.id},'新商品咨询','stopped-product-create')).status,404);assert.equal((await create(f.buyer,{kind:'shop',id:shop('stopped-seller')},'新店咨询','stopped-shop-create')).status,404);
 assert.equal((await create(f.buyer,{kind:'order',id:orderId},'历史订单需要平台接管','stopped-order-create')).status,200);assert.equal((await send(f.buyer,id,'补充历史问题','stopped-buyer-message')).status,200);assert.equal((await send(f.admin,id,'平台已接管','platform-takeover',true)).status,200);assert.equal((await get(f.buyer,id)).body.thread.messages.at(-1).senderLabel,'平台客服');
});
test('write failures roll back thread and inbox atomically; retry preserves its original idempotency key',async()=>{
 const f=await setup(),before=f.db.dump();f.db.failWrite=({collection,id})=>collection===COLLECTIONS.meta&&id===key('support-index');const failed=await create(f.buyer);assert.equal(failed.status,503);assert.deepEqual(f.db.dump(),before);f.db.failWrite=null;
 const id=(await create(f.buyer)).body.thread.id,thread=await f.store.get('meta',threadKey(id)),index=await f.store.get('meta','support-index');f.db.failWrite=({collection,id})=>collection===COLLECTIONS.meta&&id===key('support-index');assert.equal((await send(f.buyer,id)).status,503);assert.deepEqual(await f.store.get('meta',threadKey(id)),thread);assert.deepEqual(await f.store.get('meta','support-index'),index);f.db.failWrite=null;assert.equal((await send(f.buyer,id)).body.thread.messages.length,2);
});
test('concurrent session revocation and merchant permission shrink block staged writes under snapshot isolation',async()=>{
 const f=await setup(),a=await merchant(f,'revoked-seller'),p=await sellerProduct(f,a),id=(await create(f.buyer,{kind:'product',id:p.id})).body.thread.id;const before=await f.store.get('meta',threadKey(id));
 await beforeNextCommit(f.db,async()=>assert.equal((await f.admin.call('/admin/wechat/merchants/'+a.profile.id,'PUT',{userId:a.profile.userId,name:a.profile.name,region:a.profile.region,status:'enabled',permissions:['products'],expectedVersion:a.profile.version})).status,200));
 assert.equal((await send(a.client,id,'并发撤权不能回复','revoked-seller-message',true)).status,403);assert.deepEqual(await f.store.get('meta',threadKey(id)),before);
 await beforeNextCommit(f.db,async()=>assert.equal((await f.buyer.call('/auth/wechat/logout','POST',{})).status,200));assert.equal((await send(f.buyer,id)).status,401);assert.deepEqual(await f.store.get('meta',threadKey(id)),before);
});
test('concurrent product removal fences new consultations and cannot leave an orphan inbox entry',async()=>{
 const f=await setup(),product=await f.store.get('products','jingtai-apple');await beforeNextCommit(f.db,async()=>{const result=await f.admin.call('/admin/products/jingtai-apple','PUT',{expectedVersion:product.version,product:{...product.product,status:'offline'}});assert.equal(result.status,200);});
 const result=await create(f.buyer);assert.equal(result.status,404);assert.equal(await f.store.get('meta','support-index'),null);
});
test('consultation validation rejects forged fields, invalid read positions, controls and unsupported pagination',async()=>{
 const f=await setup(),id=(await create(f.buyer)).body.thread.id;
 for(const message of ['', ' ', '中'.repeat(601), 'text\u0000tail'])assert.equal((await send(f.buyer,id,message,'invalid-message-key')).status,400);
 assert.equal((await f.buyer.call('/support/threads/'+id+'/messages','POST',{text:'有效文字',idempotencyKey:'valid-key-forged',buyerId:account('outsider')})).status,400);
 assert.equal((await f.buyer.call('/support/threads?cursor=anything')).status,400);assert.equal((await f.admin.call('/admin/support/threads/'+id+'?cursor=anything')).status,400);assert.equal((await get(f.buyer,'SUPPORT-NOT-A-UUID')).status,404);
 assert.equal((await send(f.buyer,id,'两行\n模拟咨询','multiline-valid-message')).status,200);assert.equal((await status(f.buyer,id,1,'invalid')).status,400);
});
test('message and inbox bounds fail explicitly without trimming history or partly committing',async()=>{
 const f=await setup(),id=(await create(f.buyer)).body.thread.id;for(let i=1;i<MESSAGE_LIMIT;i++)assert.equal((await send(f.buyer,id,'中'.repeat(600),'bounded-message-'+String(i).padStart(6,'0'))).status,200);
 const before=await f.store.get('meta',threadKey(id));assert.equal(before.messages.length,MESSAGE_LIMIT);assert.ok(Buffer.byteLength(JSON.stringify(before))<THREAD_BYTES);assert.equal((await send(f.buyer,id,'超过上限','message-over-capacity')).body.error.code,'support_message_limit');assert.deepEqual(await f.store.get('meta',threadKey(id)),before);
 const index=await f.store.get('meta','support-index'),seed=index.threads[0];index.threads=Array.from({length:THREAD_LIMIT},(_,i)=>({...seed,id:'SUPPORT-00000000-0000-0000-0000-'+String(i).padStart(12,'0'),createKey:digest('capacity-'+i)}));await f.store.set('meta','support-index',index);
 const result=await create(f.buyer,undefined,'新的模拟咨询','thread-over-capacity');assert.equal(result.body.error.code,'support_capacity');assert.equal((await f.store.get('meta','support-index')).threads.length,THREAD_LIMIT);assert.equal(f.db.dump(COLLECTIONS.meta).filter(row=>row.id===id).length,1);
});
