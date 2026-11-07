import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryCloudbaseDB} from './fixtures/cloudbase-db.mjs';
const require=createRequire(import.meta.url),{CloudbaseStore,digest,key,COLLECTIONS}=require('../cloudfunctions/market/lib/store'),{createMarketApi}=require('../cloudfunctions/market/lib/api'),{schemaVersion,manifestHash}=require('../cloudfunctions/market/lib/provision-contract'),{shopIdFor,profileKey}=require('../cloudfunctions/market/lib/shops');
const APPID='wx1111111111111111',ENV='shop-isolated-cloud',account=name=>'wechat:'+digest(APPID+'\0'+name);
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9sAAAAASUVORK5CYII=','base64');
const input=values=>({name:'景泰采购者模拟店',description:'模拟店铺介绍\n不代表真实供货。',serviceNote:'模拟咨询，非实时在线。',image:'assets/orchard.jpg',imageMediaId:'',...values});
async function setup(){
 const db=new MemoryCloudbaseDB(),store=new CloudbaseStore(db),env={WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV,BOOTSTRAP_ADMIN_ACCOUNT_ID:account('admin')};let ms=Date.parse('2026-11-07T08:00:00.000Z'),serial=0,signFail=false;
 const objects=new Map();const storage={async write(path,bytes){const id='cloud://shop-fixture/'+path;objects.set(id,Buffer.from(bytes));return id;},async urls(ids){if(signFail)throw Error('Injected signing outage');return Object.fromEntries(ids.map(id=>[id,'https://bucket.tcb.qcloud.la/'+encodeURIComponent(id)+'?sign=shop-test']));},async remove(id){objects.delete(id);},async removeMany(ids){ids.forEach(id=>objects.delete(id));},async readChunks(rows){return rows.map(row=>{assert.equal(objects.get(row.fileId)?.length,row.size);return Buffer.from(objects.get(row.fileId));});}};
 await store.set('meta','provision-ready',{id:'provision-ready',schemaVersion,manifestHash,appId:APPID,envId:ENV,ready:true,verifiedAt:new Date(ms).toISOString(),operatorAccountId:account('operator')});
 await store.set('meta','media-storage-ready',{id:'media-storage-ready',appId:APPID,envId:ENV,ready:true,acl:'ADMINONLY',mediaPolicy:'server-owned-display-v1',verifiedAt:new Date(ms).toISOString()});
 const client=name=>{let token;const api=createMarketApi({store,env,storage,getContext:()=>({APPID,OPENID:name,ENV}),now:()=>new Date(ms++).toISOString()});return {async call(path,method='GET',body){return api({path:'/api/v1'+path,method,...(body!==undefined?{body}:{}),...(token?{sessionToken:token,expectedUserId:account(name)}:{})});},async login(){const r=await this.call('/auth/wechat/login','POST',{});assert.equal(r.status,200,JSON.stringify(r));token=r.body.token;}};};
 const admin=client('admin'),buyer=client('buyer');await admin.login();await buyer.login();assert.equal((await admin.call('/admin/seed','POST',{})).status,200);
 const save=(user,shop,expectedVersion)=>user.call('/admin/shop','PUT',{shop,expectedVersion});
 const begin=(user=admin,options={})=>user.call('/admin/media/uploads','POST',{shopId:shopIdFor(account('admin')),kind:'image',contentType:'image/png',size:PNG.length,source:'自制店铺图片，模拟资料',idempotencyKey:'shop-image-'+(++serial),...options});
 const upload=async(user=admin,options={})=>{const r=await begin(user,options);assert.equal(r.status,200,JSON.stringify(r));assert.equal((await user.call('/admin/media/'+r.body.mediaId+'/chunks','POST',{index:0,data:PNG.toString('base64')})).status,200);return user.call('/admin/media/'+r.body.mediaId+'/complete','POST',{});};
 const product=async(id='jingtai-apple')=>{const p=(await admin.call('/admin/products/'+id)).body.product;for(const k of ['shopId','updatedAt','imageUrl','videoUrl','imageExpiresAt','videoExpiresAt','mediaExpiresAt'])delete p[k];return p;};
 async function seller(name,permissions=['products']){const user=client(name);await user.login();const r=await admin.call('/admin/wechat/merchants','POST',{userId:account(name),name:'模拟采购者 '+name,region:'模拟景泰',status:'enabled',permissions});assert.equal(r.status,200,JSON.stringify(r));return {user,merchant:r.body.merchant};}
 return {db,store,admin,buyer,client,objects,storage,save,begin,upload,product,seller,failSigning:()=>{signFail=true;},advance:delta=>{ms+=delta;}};
}
async function beforeNextCommit(db,action){const start=db.startTransaction.bind(db);let armed=true;db.startTransaction=async()=>{const tx=await start(),commit=tx.commit.bind(tx);tx.commit=async()=>{if(armed){armed=false;await action();}return commit();};return tx;};}
test('shop profile is own-only, products-authorized, and never discloses identity or editable authorization fields',async()=>{
 const f=await setup(),a=await f.seller('seller-a'),b=await f.seller('seller-b'),noProducts=await f.seller('support-only',['aftersales']);
 assert.equal((await f.client('anonymous').call('/admin/shop')).status,401);assert.equal((await f.buyer.call('/admin/shop')).status,403);assert.equal((await noProducts.user.call('/admin/shop')).status,403);
 const empty=(await a.user.call('/admin/shop')).body.shop;assert.equal(empty.id,shopIdFor(account('seller-a')));assert.equal(empty.version,0);assert.equal(empty.regionLabel,a.merchant.region);assert.equal(empty.procurementName,a.merchant.name);
 const saved=await f.save(a.user,input(),0);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.body.shop.version,1);assert.equal((await b.user.call('/admin/shop')).body.shop.version,0);
 const serialized=JSON.stringify(saved.body);for(const value of ['wechat:','ownerId','uploadedBy','authorizationFence'])assert.ok(!serialized.includes(value));
 assert.equal((await f.save(a.user,{...input(),ownerId:account('seller-b')},1)).status,400);assert.equal((await a.user.call('/admin/shop?cursor=anything')).status,400);
});
test('saved shop copy synchronizes to another session and public storefront only through the real visible store',async()=>{
 const f=await setup(),second=f.client('admin');await second.login();const saved=await f.save(f.admin,input({name:'新的模拟景泰店',description:'完整模拟介绍\n苹果与土豆。',serviceNote:'请只发送模拟资料'}),0);assert.equal(saved.status,200);
 assert.equal((await second.call('/admin/shop')).body.shop.name,'新的模拟景泰店');
 const publicStore=(await f.buyer.call('/storefront')).body.shops.find(s=>s.id===shopIdFor(account('admin')));assert.equal(publicStore.name,'新的模拟景泰店');assert.equal(publicStore.description,'完整模拟介绍\n苹果与土豆。');assert.equal(publicStore.serviceNote,'请只发送模拟资料');assert.equal(publicStore.image,'assets/orchard.jpg');assert.ok(!JSON.stringify(publicStore).includes('wechat:'));
 const a=await f.seller('no-products');assert.equal((await f.save(a.user,input({name:'尚未上架店'}),0)).status,200);assert.ok(!(await f.buyer.call('/storefront')).body.shops.some(s=>s.id===shopIdFor(account('no-products'))));
});
test('shop writes reject unsafe URLs, unknown fields, invalid bounds and control text without changing the profile',async()=>{
 const f=await setup();const invalid=[{name:''},{name:'名'.repeat(61)},{description:'介'.repeat(2001)},{serviceNote:'服'.repeat(501)},{description:'bad\u0000text'},{image:'https://untrusted.invalid/image.jpg'},{imageMediaId:'cloud://raw-file-id'},{procurementName:'冒用采购者'},{regionLabel:'伪造授权地区'}];
 for(const patch of invalid)assert.equal((await f.save(f.admin,input(patch),0)).status,400,JSON.stringify(patch));assert.equal(await f.store.get('meta',profileKey(account('admin'))),null);
 assert.equal((await f.save(f.admin,input({name:'  模拟店  ',serviceNote:'  '}),0)).body.shop.name,'模拟店');
});
test('concurrent shop copy edits conflict rather than overwrite another device',async()=>{
 const f=await setup();assert.equal((await f.save(f.admin,input(),0)).status,200);const result=await Promise.all([f.save(f.admin,input({name:'设备甲模拟店'}),1),f.save(f.admin,input({name:'设备乙模拟店'}),1)]);assert.deepEqual(result.map(v=>v.status).sort(),[200,409]);assert.equal((await f.admin.call('/admin/shop')).body.shop.version,2);assert.equal((await f.save(f.admin,input(),1)).body.error.code,'version_conflict');
});
test('shop images can upload before first copy save and are public only after current visible-shop binding',async()=>{
 const f=await setup(),image=await f.upload();assert.equal(image.status,200,JSON.stringify(image));const id=image.body.mediaId;assert.equal((await f.buyer.call('/media/'+id)).status,404);assert.equal((await f.admin.call('/admin/media/'+id)).status,200);
 const saved=await f.save(f.admin,input({imageMediaId:id}),0);assert.equal(saved.status,200,JSON.stringify(saved));assert.ok(saved.body.shop.imageUrl.includes('?sign=shop-test'));assert.ok(saved.body.shop.imageExpiresAt);assert.equal((await f.buyer.call('/media/'+id)).status,200);
 const visible=(await f.buyer.call('/storefront')).body.shops.find(v=>v.id===shopIdFor(account('admin')));assert.equal(visible.imageMediaId,id);assert.ok(visible.imageUrl.includes('?sign=shop-test'));assert.ok(!JSON.stringify(visible).includes('cloud://'));assert.equal((await f.admin.call('/admin/media/'+id+'/cancel','POST',{})).status,409);
 const replacement=await f.upload();assert.equal((await f.save(f.admin,input({imageMediaId:replacement.body.mediaId}),1)).status,200);assert.equal((await f.buyer.call('/media/'+id)).status,404);assert.equal((await f.buyer.call('/media/'+replacement.body.mediaId)).status,200);assert.equal((await f.store.get('meta','media:'+id)).everBound,true);
});
test('shop media target and image-only limits prevent product, foreign-shop and video cross-binding',async()=>{
 const f=await setup(),a=await f.seller('isolation'),foreignId=shopIdFor(account('isolation'));
 assert.equal((await f.begin(f.admin,{shopId:foreignId})).status,404);assert.equal((await f.begin(f.admin,{productId:'jingtai-apple'})).status,400);assert.equal((await f.begin(f.admin,{shopId:'invalid-shop'})).status,400);assert.equal((await f.begin(f.admin,{kind:'video',contentType:'video/mp4'})).status,400);assert.equal((await f.begin(f.buyer)).status,403);
 const image=await f.upload(),p=await f.product();p.imageMediaId=image.body.mediaId;assert.equal((await f.admin.call('/admin/products/'+p.id,'PUT',{expectedVersion:p.version,product:p})).status,403);
 const productImage=await f.upload(f.admin,{shopId:undefined,productId:p.id});assert.equal(productImage.status,200,JSON.stringify(productImage));assert.equal((await f.save(f.admin,input({imageMediaId:productImage.body.mediaId}),0)).status,403);
 assert.equal((await f.save(a.user,input({imageMediaId:image.body.mediaId}),0)).status,403);assert.equal((await a.user.call('/admin/media/'+image.body.mediaId)).status,404);
});
test('image bind and shop write roll back together and cancellation cannot delete a concurrent first binding',async()=>{
 const f=await setup(),image=await f.upload(),id=image.body.mediaId;f.db.failWrite=({collection,id:doc})=>collection===COLLECTIONS.meta&&doc===key(profileKey(account('admin')));
 assert.equal((await f.save(f.admin,input({imageMediaId:id}),0)).status,503);assert.equal(await f.store.get('meta',profileKey(account('admin'))),null);assert.equal((await f.store.get('meta','media:'+id)).everBound,false);f.db.failWrite=null;
 await beforeNextCommit(f.db,async()=>assert.equal((await f.save(f.admin,input({imageMediaId:id}),0)).status,200));
 const cancelled=await f.admin.call('/admin/media/'+id+'/cancel','POST',{});assert.equal(cancelled.status,409);assert.equal((await f.store.get('meta','media:'+id)).everBound,true);assert.equal((await f.buyer.call('/media/'+id)).status,200);
});
test('concurrent merchant stop revokes shop save and leaves its image unbound',async()=>{
 const f=await setup(),a=await f.seller('revoke'),m=a.merchant,id=shopIdFor(account('revoke'));const image=await f.upload(a.user,{shopId:id});assert.equal(image.status,200);
 await beforeNextCommit(f.db,async()=>assert.equal((await f.admin.call('/admin/wechat/merchants/'+m.id,'PUT',{userId:m.userId,name:m.name,region:m.region,status:'disabled',permissions:m.permissions,expectedVersion:m.version})).status,200));
 assert.equal((await f.save(a.user,input({imageMediaId:image.body.mediaId}),0)).status,403);assert.equal(await f.store.get('meta',profileKey(account('revoke'))),null);assert.equal((await f.store.get('meta','media:'+image.body.mediaId)).everBound,false);
 assert.equal((await a.user.call('/admin/media/'+image.body.mediaId)).status,403);assert.equal((await a.user.call('/admin/shop')).status,403);
});
test('bound shop images of empty or disabled stores stay out of public business APIs while authorized preview remains',async()=>{
 const f=await setup(),a=await f.seller('empty-shop'),image=await f.upload(a.user,{shopId:shopIdFor(account('empty-shop'))});assert.equal((await f.save(a.user,input({imageMediaId:image.body.mediaId}),0)).status,200);assert.equal((await a.user.call('/admin/media/'+image.body.mediaId)).status,200);assert.equal((await f.buyer.call('/media/'+image.body.mediaId)).status,404);
 const p={...await f.product(),id:'empty-shop-apple',version:0};assert.equal((await a.user.call('/admin/products/'+p.id,'PUT',{expectedVersion:0,product:p})).status,200);assert.equal((await f.buyer.call('/media/'+image.body.mediaId)).status,200);
 const m=a.merchant;assert.equal((await f.admin.call('/admin/wechat/merchants/'+m.id,'PUT',{userId:m.userId,name:m.name,region:m.region,status:'disabled',permissions:m.permissions,expectedVersion:m.version})).status,200);assert.equal((await f.buyer.call('/media/'+image.body.mediaId)).status,404);assert.ok(!(await f.buyer.call('/storefront')).body.shops.some(s=>s.id===shopIdFor(account('empty-shop'))));
});
test('shop signing outage or expired proof keeps saved copy and fallback visible without leaking storage IDs',async()=>{
 const f=await setup(),image=await f.upload();assert.equal((await f.save(f.admin,input({imageMediaId:image.body.mediaId}),0)).status,200);f.failSigning();const privateDTO=(await f.admin.call('/admin/shop')).body.shop;assert.equal(privateDTO.mediaUnavailable,true);assert.equal(privateDTO.imageUrl,undefined);assert.equal(privateDTO.name,input().name);
 const visible=(await f.buyer.call('/storefront')).body.shops.find(s=>s.id===shopIdFor(account('admin')));assert.equal(visible.mediaUnavailable,true);assert.equal(visible.imageUrl,undefined);assert.equal(visible.image,'assets/orchard.jpg');assert.ok(!JSON.stringify(visible).includes('cloud://'));
 f.advance(8*24*60*60*1000);assert.equal((await f.begin()).status,503);
});
test('a merchant revoked during a shop image chunk commit cannot leave a committed chunk or orphan object',async()=>{
 const f=await setup(),a=await f.seller('chunk-revoke'),m=a.merchant,started=await f.begin(a.user,{shopId:shopIdFor(account('chunk-revoke'))});assert.equal(started.status,200);const id=started.body.mediaId;
 await beforeNextCommit(f.db,async()=>assert.equal((await f.admin.call('/admin/wechat/merchants/'+m.id,'PUT',{userId:m.userId,name:m.name,region:m.region,status:'disabled',permissions:m.permissions,expectedVersion:m.version})).status,200));
 assert.equal((await a.user.call('/admin/media/'+id+'/chunks','POST',{index:0,data:PNG.toString('base64')})).status,403);assert.deepEqual((await f.store.get('meta','media:'+id)).chunks,{});assert.equal(f.objects.size,0);
});
test('shop first binding racing a completed cancellation fails instead of referencing deleted image data',async()=>{
 const f=await setup(),image=await f.upload(),id=image.body.mediaId;
 await beforeNextCommit(f.db,async()=>assert.equal((await f.admin.call('/admin/media/'+id+'/cancel','POST',{})).status,200));
 assert.equal((await f.save(f.admin,input({imageMediaId:id}),0)).status,403);assert.equal(await f.store.get('meta',profileKey(account('admin'))),null);assert.equal((await f.store.get('meta','media:'+id)).everBound,false);assert.equal(f.objects.size,0);
});
test('public shop image checks use existing owner-sort index and unknown media targets are denied consistently',async()=>{
 const f=await setup(),shopImage=await f.upload();assert.equal((await f.save(f.admin,input({imageMediaId:shopImage.body.mediaId}),0)).status,200);
 const list=f.store.list.bind(f.store);f.store.list=async(collection,filter,options)=>{assert.ok(!(collection==='products'&&filter.ownerId&&filter.status),'no undeclared owner-status-sort compound index');return list(collection,filter,options);};
 assert.equal((await f.buyer.call('/media/'+shopImage.body.mediaId)).status,200);
 const product=await f.product(),image=await f.upload(f.admin,{shopId:undefined,productId:product.id});product.imageMediaId=image.body.mediaId;
 assert.equal((await f.admin.call('/admin/products/'+product.id,'PUT',{expectedVersion:product.version,product})).status,200);
 const media=await f.store.get('meta','media:'+image.body.mediaId);await f.store.set('meta','media:'+media.id,{...media,targetKind:'unrecognized'});
 assert.equal((await f.buyer.call('/media/'+media.id)).status,404);assert.equal((await f.admin.call('/admin/media/'+media.id)).status,404);
 const visible=(await f.buyer.call('/products')).body.products.find(row=>row.id===product.id);assert.equal(visible.imageUrl,undefined);assert.equal(visible.mediaUnavailable,true);
});
