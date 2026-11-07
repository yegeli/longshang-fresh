import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryCloudbaseDB} from './fixtures/cloudbase-db.mjs';
const require=createRequire(import.meta.url);
const {CloudbaseStore,COLLECTIONS,digest,key}=require('../cloudfunctions/market/lib/store');
const {createMarketApi}=require('../cloudfunctions/market/lib/api');
const {BASE_CATALOG}=require('../cloudfunctions/market/lib/model.cjs');
const {schemaVersion,manifestHash}=require('../cloudfunctions/market/lib/provision-contract');
const {LIMIT,MAX_BYTES}=require('../cloudfunctions/market/lib/product-history');
const APPID='wx1111111111111111',ENV='product-history-test-environment';
const account=name=>'wechat:'+digest(APPID+'\0'+name);
const clone=value=>JSON.parse(JSON.stringify(value));
const product=id=>({...clone(BASE_CATALOG[0]),id,status:'draft',video:''});
async function setup() {
 const db=new MemoryCloudbaseDB(),store=new CloudbaseStore(db),env={WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV,BOOTSTRAP_ADMIN_ACCOUNT_ID:account('admin')};
 let ms=Date.parse('2026-11-07T08:00:00.000Z');
 const storage={urls:async ids=>Object.fromEntries(ids.map(id=>[id,'https://bucket.tcb.qcloud.la/display?signature=private-test-signature']))};
 await store.set('meta','provision-ready',{id:'provision-ready',schemaVersion,manifestHash,appId:APPID,envId:ENV,ready:true,verifiedAt:new Date(ms).toISOString(),operatorAccountId:account('operator')});
 await store.set('meta','media-storage-ready',{id:'media-storage-ready',appId:APPID,envId:ENV,ready:true,verifiedAt:new Date(ms).toISOString(),acl:'ADMINONLY',mediaPolicy:'server-owned-display-v1'});
 const client=name=>{
  const api=createMarketApi({store,storage,env,getContext:()=>({APPID,OPENID:name,ENV}),now:()=>new Date(ms++).toISOString()});let token;
  return {async call(path,method='GET',body){return api({path:'/api/v1'+path,method,...(body===undefined?{}:{body}),...(token?{sessionToken:token,expectedUserId:account(name)}:{})});},async login(){const result=await this.call('/auth/wechat/login','POST',{});assert.equal(result.status,200,JSON.stringify(result));token=result.body.token;}};
 };
 const admin=client('admin'),buyer=client('buyer');await admin.login();await buyer.login();
 return {db,store,client,admin,buyer};
}
async function seller(f,name,permissions=['products']) {
 const user=f.client(name);await user.login();
 const result=await f.admin.call('/admin/wechat/merchants','POST',{userId:account(name),name:'模拟采购者',region:'模拟产区',status:'enabled',permissions});
 assert.equal(result.status,200,JSON.stringify(result));return {user,profile:result.body.merchant};
}
const save=(client,value,expectedVersion)=>client.call('/admin/products/'+value.id,'PUT',{expectedVersion,product:value});
const history=(client,id)=>client.call('/admin/products/'+id+'/history');
async function beforeNextCommit(db,action) {
 const start=db.startTransaction.bind(db);let armed=true;
 db.startTransaction=async()=>{const tx=await start(),commit=tx.commit.bind(tx);tx.commit=async()=>{if(armed){armed=false;await action();}return commit();};return tx;};
}
test('product history records creation and actual multi-field edits without product bodies or identities',async()=>{
 const f=await setup(),p=product('history-apple');
 assert.equal((await save(f.admin,p,0)).status,200);
 const first=(await history(f.admin,p.id)).body;
 assert.equal(first.nextCursor,null);assert.equal(first.events.length,1);
 const created=first.events[0];assert.equal(created.action,'created');assert.equal(created.version,1);assert.equal(created.actorRole,'admin');assert.equal(created.before,null);assert.equal(created.after.name,p.name);assert.deepEqual(created.after.prices,{small:p.variants[0].price,family:p.variants[1].price});assert.ok(created.changedFields.includes('summary'));assert.ok(!created.changedFields.includes('id'));
 const changed=clone(p);changed.name='景泰模拟新苹果';changed.status='published';changed.variants[0].price+=200;changed.summary='一段新的模拟介绍';changed.image='assets/pear.jpg';
 assert.equal((await save(f.admin,changed,1)).status,200);
 const events=(await history(f.admin,p.id)).body.events;assert.deepEqual(events.map(e=>e.version),[2,1]);assert.deepEqual(events[0].changedFields,['name','status','image','summary','variants']);assert.equal(events[0].before.name,p.name);assert.equal(events[0].after.name,changed.name);assert.equal(events[0].after.image,'assets/pear.jpg');assert.equal(events[0].before.prices.small,p.variants[0].price);assert.equal(events[0].after.prices.small,changed.variants[0].price);
 const serialized=JSON.stringify(events);for(const forbidden of ['wechat:','ownerId','actorId','updatedBy','signature=','summary:','一段新的模拟介绍'])assert.ok(!serialized.includes(forbidden),forbidden);
 assert.equal((await history(f.client('anonymous'),p.id)).status,401);assert.equal((await history(f.buyer,p.id)).status,403);assert.equal((await f.admin.call('/admin/products/'+p.id+'/history?cursor=anything')).status,400);
});
test('product history enforces merchant product ownership and current products permission',async()=>{
 const f=await setup(),a=await seller(f,'seller-a'),b=await seller(f,'seller-b'),readless=await seller(f,'no-product-access',['orders']),p=product('seller-apple');
 assert.equal((await save(a.user,p,0)).status,200);const own=await history(a.user,p.id);assert.equal(own.status,200);assert.equal(own.body.events[0].actorRole,'merchant');assert.equal((await history(f.admin,p.id)).status,200);assert.equal((await history(b.user,p.id)).status,404);assert.equal((await history(readless.user,p.id)).status,403);assert.equal((await history(a.user,'absent-product')).status,404);
 const before=await f.store.get('meta','product-history:'+p.id);assert.equal((await save(b.user,{...p,name:'越权写入'},1)).status,404);assert.deepEqual(await f.store.get('meta','product-history:'+p.id),before);
});
test('product history does not fabricate records for seeded or older unchanged products',async()=>{
 const f=await setup();assert.equal((await f.admin.call('/admin/seed','POST',{})).status,200);
 assert.deepEqual((await history(f.admin,'jingtai-apple')).body,{events:[],nextCursor:null});assert.equal(await f.store.get('meta','product-history:jingtai-apple'),null);
 const row=await f.store.get('products','jingtai-apple');assert.equal((await save(f.admin,row.product,row.version)).status,200);const events=(await history(f.admin,row.id)).body.events;assert.equal(events.length,1);assert.equal(events[0].action,'updated');assert.equal(events[0].version,2);assert.deepEqual(events[0].changedFields,[]);
});
test('unknown and rejected fields cannot produce misleading changes, while normalized nested fields are ignored',async()=>{
 const f=await setup(),p=product('strict-history');assert.equal((await save(f.admin,p,0)).status,200);
 for(const invalid of [{...p,actorRole:'admin'},{...p,ownerId:account('buyer')},{...p,summary:'x'.repeat(2001)}])assert.equal((await save(f.admin,invalid,1)).status,400);
 assert.equal((await save(f.admin,{...p,version:7},1)).status,400);assert.equal((await history(f.admin,p.id)).body.events.length,1);
 const nested=clone(p);nested.variants[0].unknown='never-a-change';nested.harvestSteps[0].actorId=account('buyer');nested.name='  '+p.name+'  ';
 assert.equal((await save(f.admin,nested,1)).status,200);const events=(await history(f.admin,p.id)).body.events;assert.deepEqual(events[0].changedFields,[]);assert.ok(!JSON.stringify(events).includes('never-a-change'));
});
test('concurrent product edits only record the committed winner and version conflicts leave history untouched',async()=>{
 const f=await setup(),p=product('race-history');assert.equal((await save(f.admin,p,0)).status,200);
 const attempts=await Promise.all([save(f.admin,{...p,name:'并发苹果甲'},1),save(f.admin,{...p,name:'并发苹果乙'},1)]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);const saved=await f.store.get('products',p.id),events=(await history(f.admin,p.id)).body.events;assert.deepEqual(events.map(e=>e.version),[2,1]);assert.equal(events[0].after.name,saved.product.name);assert.equal(new Set(events.map(e=>e.id)).size,2);
 const before=await f.store.get('meta','product-history:'+p.id);assert.equal((await save(f.admin,p,1)).status,409);assert.deepEqual(await f.store.get('meta','product-history:'+p.id),before);assert.ok(f.db.rollbacks>0);
});
test('merchant revocation racing a product edit rolls back product and history together',async()=>{
 const f=await setup(),merchant=await seller(f,'revoke-seller'),p=product('revoke-history');assert.equal((await save(merchant.user,p,0)).status,200);const original=await f.store.get('products',p.id),events=await f.store.get('meta','product-history:'+p.id),m=merchant.profile;
 await beforeNextCommit(f.db,async()=>assert.equal((await f.admin.call('/admin/wechat/merchants/'+m.id,'PUT',{userId:m.userId,name:m.name,region:m.region,status:'disabled',permissions:m.permissions,expectedVersion:m.version})).status,200));
 assert.equal((await save(merchant.user,{...p,name:'撤权后不应保存'},1)).status,403);assert.deepEqual(await f.store.get('products',p.id),original);assert.deepEqual(await f.store.get('meta','product-history:'+p.id),events);
});
test('history failure rolls back new product counters and first media binding, then a retry records once',async()=>{
 const f=await setup(),p=product('rollback-history'),historyId=key('product-history:'+p.id);
 f.db.failWrite=({collection,id})=>collection===COLLECTIONS.meta&&id===historyId;
 assert.equal((await save(f.admin,p,0)).status,503);assert.equal(await f.store.get('products',p.id),null);assert.equal(await f.store.get('meta','product-count'),null);assert.equal(await f.store.get('meta','product-ever:'+p.id),null);assert.equal(await f.store.get('meta','product-history:'+p.id),null);
 f.db.failWrite=null;assert.equal((await save(f.admin,p,0)).status,200);
 const imageId='CLOUD-11111111-1111-4111-8111-111111111111',videoId='CLOUD-22222222-2222-4222-8222-222222222222';
 for(const [id,kind] of [[imageId,'image'],[videoId,'video']])await f.store.set('meta','media:'+id,{id,ownerId:account('admin'),productId:p.id,kind,state:'ready',everBound:false,fileId:'cloud://private-test/'+id,uploadedBy:account('admin'),source:'模拟素材'});
 const original=await f.store.get('products',p.id),oldHistory=await f.store.get('meta','product-history:'+p.id),withMedia={...p,imageMediaId:imageId,videoMediaId:videoId};
 f.db.failWrite=({collection,id})=>collection===COLLECTIONS.meta&&id===historyId;
 assert.equal((await save(f.admin,withMedia,1)).status,503);assert.deepEqual(await f.store.get('products',p.id),original);assert.deepEqual(await f.store.get('meta','product-history:'+p.id),oldHistory);for(const id of [imageId,videoId])assert.equal((await f.store.get('meta','media:'+id)).everBound,false);
 f.db.failWrite=null;const changed=await save(f.admin,withMedia,1);assert.equal(changed.status,200,JSON.stringify(changed));assert.ok(changed.body.product.imageUrl.includes('signature='));
 let events=(await history(f.admin,p.id)).body.events;assert.equal(events.length,2);assert.deepEqual(events[0].changedFields,['imageMediaId','videoMediaId']);assert.equal(events[0].before.imageMediaId,'');assert.equal(events[0].after.imageMediaId,imageId);assert.equal(events[0].after.videoMediaId,videoId);assert.ok(!JSON.stringify(events).includes('signature='));assert.ok(!JSON.stringify(events).includes('cloud://'));for(const id of [imageId,videoId])assert.equal((await f.store.get('meta','media:'+id)).everBound,true);
 assert.equal((await save(f.admin,p,2)).status,200);events=(await history(f.admin,p.id)).body.events;assert.equal(events[0].after.imageMediaId,'');assert.equal(events[0].before.videoMediaId,videoId);for(const id of [imageId,videoId])assert.equal((await f.store.get('meta','media:'+id)).everBound,true);
});
test('latest fifty product changes keep a compact byte budget even with maximum descriptions',async()=>{
 const f=await setup(),p=product('bounded-history');p.name='果'.repeat(40);p.summary='介'.repeat(2000);p.storage='存'.repeat(1000);p.facts=Array.from({length:20},()=>['资'.repeat(60),'料'.repeat(300)]);p.harvestSteps=Array.from({length:12},()=>({title:'采'.repeat(60),text:'摘'.repeat(1000)}));
 for(let expected=0;expected<55;expected++) {const value=clone(p);value.variants[0].price+=expected;value.summary=(expected%2?'新':'旧').repeat(2000);assert.equal((await save(f.admin,value,expected)).status,200);}
 const row=await f.store.get('meta','product-history:'+p.id),result=await history(f.admin,p.id);assert.equal(result.status,200);assert.equal(result.body.nextCursor,null);assert.equal(result.body.events.length,LIMIT);assert.deepEqual(result.body.events.map(e=>e.version),Array.from({length:LIMIT},(_,i)=>55-i));assert.ok(Buffer.byteLength(JSON.stringify(row),'utf8')<MAX_BYTES);assert.ok(Buffer.byteLength(JSON.stringify(row),'utf8')<80000);assert.ok(!JSON.stringify(row).includes(p.storage));assert.ok(!JSON.stringify(row).includes('harvestSteps":['));
});
test('history response whitelists compact DTOs and invalid history fails without partial product save',async()=>{
 const f=await setup(),p=product('safe-history');assert.equal((await save(f.admin,p,0)).status,200);const historyKey='product-history:'+p.id,row=await f.store.get('meta',historyKey);row.actorId=account('admin');row.events[0].actorId=account('admin');row.events[0].after.imageUrl='https://private.invalid?signature=secret';await f.store.set('meta',historyKey,row);
 const read=await history(f.admin,p.id);assert.equal(read.status,200);assert.ok(!JSON.stringify(read.body).includes('wechat:'));assert.ok(!JSON.stringify(read.body).includes('signature='));
 row.events[0].after.name='x'.repeat(41);await f.store.set('meta',historyKey,row);const before=await f.store.get('products',p.id);assert.equal((await history(f.admin,p.id)).status,503);assert.equal((await save(f.admin,{...p,name:'不应半成功'},1)).status,503);assert.deepEqual(await f.store.get('products',p.id),before);
});
