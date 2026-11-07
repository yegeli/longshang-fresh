'use strict';
// Run this file with the exact cloud runtime's node binary (Node 16.13.0 for
// the legacy WeChat CLI). No node:test or newer test-only globals are needed.
// All outbound SDK transports below are replaced; no real cloud calls occur.
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const Module=require('node:module');
const {createRequire}=Module;
const root=path.resolve(__dirname,'..');
// A function ships without the repository's root node_modules. Load the actual
// deployed entry points from isolated copies and reject all dependency escape.
// This catches SDK bundles with undeclared externals (wx-server-sdk 4.0.2's
// mime-db), even when npm happens to hoist them in the developer checkout.
const isolated=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'longshang-cloud-runtime-')));
const isolatedRoots=['market','provision'].map(name=>path.join(isolated,name));
for(const name of ['market','provision']) {
 const source=path.join(root,'cloudfunctions',name),target=path.join(isolated,name);
 fs.mkdirSync(target);
 for(const item of ['index.js','package.json','package-lock.json','collections.json','lib','node_modules'])
  fs.cpSync(path.join(source,item),path.join(target,item),{recursive:true,dereference:false});
}
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...rest) {
 const result=originalResolve.call(this,request,parent,...rest);
 const ownRoot=isolatedRoots.find(folder=>parent?.filename?.startsWith(folder+path.sep));
 if(ownRoot&&path.isAbsolute(result))assert.ok(result.startsWith(ownRoot+path.sep),'Function dependency escaped its package: '+request);
 return result;
};
const requireMarket=createRequire(path.join(isolated,'market/package.json'));
const requireProvision=createRequire(path.join(isolated,'provision/package.json'));
const {CloudbaseStore,digest,COLLECTIONS}=requireMarket('./lib/store');
const {createMarketApi}=requireMarket('./lib/api');
const {schemaVersion,manifestHash}=requireMarket('./lib/provision-contract');
const APPID='wx1111111111111111',ENV_ID='node16-smoke-environment';
const account=id=>'wechat:'+digest(APPID+'\0'+id);
async function sdkContract() {
 for(const [name,load] of [['market',requireMarket],['provision',requireProvision]]) {assert.equal(typeof load('./index.js').main,'function',name+' actual entry point');assert.equal(load('mime-db/package.json').version,'1.52.0');assert.equal(typeof load('mime-db')['image/jpeg'],'object');}
 const cloud=requireMarket('wx-server-sdk');assert.equal(requireMarket('wx-server-sdk/package.json').version,'4.0.2');cloud.init({env:ENV_ID});assert.equal(typeof cloud.database({throwOnNotFound:false}).startTransaction,'function');
 const CloudBase=requireProvision('@cloudbase/manager-node');assert.equal(typeof CloudBase,'function');assert.equal(requireProvision('@cloudbase/manager-node/package.json').version,'5.9.4');
 const managerRoot=path.dirname(requireProvision.resolve('@cloudbase/manager-node/package.json'));
 const {CloudService}=require(path.join(managerRoot,'lib/utils/cloud-api-request'));
 const original=CloudService.prototype.requestWithSign;let calls=0,runtimeTimeout=3;
 // Supplying fixed dummy credentials keeps the real SDK out of runtime secret
 // discovery. Replacing its outbound transport prevents ALL network requests.
 CloudService.prototype.requestWithSign=async function(){calls++;assert.equal(this.service,'tcb');assert.equal(this.version,'2018-06-08');assert.equal(this.data.EnvId,ENV_ID);if(this.action==='GetFunction'){assert.deepEqual(this.data,{EnvId:ENV_ID,FunctionName:'longshang-market'});return {Response:{FunctionName:'longshang-market',Timeout:runtimeTimeout,Status:'Active',Environment:{PRIVATE:'SECRET_TOKEN'},Role:'PRIVATE_ROLE',CodeInfo:'PRIVATE_CODE'}};}if(this.action==='UpdateFunctionConfiguration'){assert.deepEqual(this.data,{EnvId:ENV_ID,FunctionName:'longshang-market',Timeout:30});runtimeTimeout=30;return {Response:{RequestId:'STUB'}};}return {Response:this.action==='DescribeSafeRule'?{AclTag:'ADMINONLY',RequestId:'STUB'}:this.action==='CreateTable'?{RequestId:'STUB'}:{Tables:[],Pager:{Offset:0,Limit:100,Total:0},RequestId:'STUB'}};};
 try {const manager=new CloudBase({envId:ENV_ID,secretId:'smoke-dummy-id',secretKey:'smoke-dummy-key'}),api=manager.commonService('tcb','2018-06-08');const rule=await api.call({Action:'DescribeSafeRule',Param:{EnvId:ENV_ID,CollectionName:'lsf_meta'}});assert.deepEqual(rule,{AclTag:'ADMINONLY',RequestId:'STUB'});assert.equal(rule.Response,undefined);assert.equal((await api.call({Action:'CreateTable',Param:{EnvId:ENV_ID,TableName:'lsf_meta'}})).RequestId,'STUB');assert.deepEqual((await api.call({Action:'DescribeTables',Param:{EnvId:ENV_ID,Limit:100,Offset:0}})).Tables,[]);assert.equal(calls,3);
  const {createProvision}=requireProvision('./lib/provision'),provision=createProvision({getConfig:()=>({WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV_ID,PROVISION_OPERATOR_ACCOUNT_ID:account('operator')}),getContext:()=>({APPID,OPENID:'operator',ENV:ENV_ID}),createManager:()=>manager,getDatabase:()=>{throw Error('Runtime configuration must not use the database');}});
  const changed=await provision({operation:'runtime-configure',apply:true});assert.equal(changed.status,200);assert.equal(changed.body.configured,false);assert.equal(changed.body.needsVerification,true);const verified=await provision({operation:'runtime-inspect'});assert.equal(verified.body.configured,true);assert.ok(!/PRIVATE|SECRET_TOKEN|Environment|CodeInfo|Role/.test(JSON.stringify(verified)));assert.equal(calls,6);
 }finally{CloudService.prototype.requestWithSign=original;}
 const requireManager=createRequire(path.join(managerRoot,'package.json')),mime=requireManager('mime-types');assert.equal(requireManager('mime-types/package.json').version,'2.1.35');assert.equal(mime.lookup('example.jpg'),'image/jpeg');assert.equal(mime.lookup('example.mp4'),'video/mp4');assert.equal(mime.lookup('no-extension'),false);
 // The override is deliberately scoped to manager's storage helper. Provision
 // itself only calls JSON APIs above. All dependency engine ranges must include
 // Node16.13 before claiming the legacy runtime is supported.
 const semver=requireManager('semver');
 for(const folder of isolatedRoots) {const lock=JSON.parse(fs.readFileSync(path.join(folder,'package-lock.json')));for(const [name,pkg] of Object.entries(lock.packages)){const file=path.join(folder,name,'package.json');if(pkg.optional&&!fs.existsSync(file))continue;assert.ok(fs.existsSync(file),'Missing installed package: '+name);const actual=JSON.parse(fs.readFileSync(file));assert.equal(actual.version,pkg.version,'Installed version differs from lock: '+name);if(actual.engines?.node)assert.ok(semver.satisfies('16.13.0',actual.engines.node),name+' installed engine '+actual.engines.node);}}
}
async function marketFlow() {
 const {MemoryCloudbaseDB}=await import('./fixtures/cloudbase-db.mjs');const db=new MemoryCloudbaseDB(),store=new CloudbaseStore(db),env={WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV_ID,BOOTSTRAP_ADMIN_ACCOUNT_ID:account('admin')};let time=Date.parse('2026-11-02T08:00:00.000Z');
 function client(openid){let token;const api=createMarketApi({store,env,getContext:()=>({APPID,OPENID:openid,ENV:ENV_ID}),now:()=>new Date(time++).toISOString()});return {async call(path,method='GET',body){const result=await api({path:'/api/v1'+path,method,...(body===undefined?{}:{body}),...(token?{sessionToken:token,expectedUserId:account(openid)}:{})});assert.ok(result.status<400,JSON.stringify(result));return result.body;},async login(){const result=await this.call('/auth/wechat/login','POST',{});token=result.token;return result.session;}};}
 await store.set('meta','provision-ready',{id:'provision-ready',schemaVersion,manifestHash,appId:APPID,envId:ENV_ID,ready:true,verifiedAt:new Date(time).toISOString(),operatorAccountId:account('operator')});const admin=client('admin'),phone=client('buyer'),computer=client('buyer');assert.equal((await admin.login()).role,'admin');await phone.login();await computer.login();assert.equal((await admin.call('/admin/seed','POST',{})).inserted,6);
 const state={cart:[{productId:'jingtai-apple',variant:'small',quantity:2,selected:true}],favorites:['pear'],recent:['jingtai-apple'],preferredAddress:'gansu'};await phone.call('/me/shopping','PUT',{state,expectedVersion:0});assert.deepEqual((await computer.call('/me/shopping')).state,state);
 const items=[{productId:'jingtai-apple',variant:'small',quantity:1}],quote=(await phone.call('/orders/quote','POST',{items,address:'gansu'})).quote,payload={items,address:'gansu',expectedTotal:quote.total,productVersions:quote.productVersions,inventoryVersions:quote.inventoryVersions,idempotencyKey:'node16-smoke-order'};
 const created=(await phone.call('/orders','POST',payload)).order;assert.equal((await computer.call('/orders','POST',payload)).order.id,created.id);assert.equal((await store.get('inventory','jingtai-apple')).stocks.small,19);await phone.call('/me/shopping/consume-order','POST',{orderId:created.id,expectedVersion:1});assert.equal((await computer.call('/me/shopping/consume-order','POST',{orderId:created.id,expectedVersion:1})).state.cart[0].quantity,1);
 await admin.call('/admin/orders/'+created.id+'/ship','POST',{expectedVersion:1,carrier:'模拟快递',tracking:'DEMO-NODE16'});assert.equal((await computer.call('/orders/'+created.id)).order.fulfillment.status,'shipped');await computer.call('/orders/'+created.id+'/receive','POST',{expectedVersion:2});await phone.call('/orders/'+created.id+'/aftersale','POST',{expectedVersion:3,type:'refund',reason:'damaged',description:'仅用于运行时兼容验证',hasEvidence:false});await admin.call('/admin/orders/'+created.id+'/aftersale/resolve','POST',{expectedVersion:4,reply:'模拟处理完成'});assert.equal((await computer.call('/orders/'+created.id)).order.afterSale.status,'resolved');await phone.call('/auth/wechat/logout','POST',{});assert.equal((await computer.call('/session')).user.id,account('buyer'));assert.equal(db.dump(COLLECTIONS.orders).length,1);
}
async function mediaSdkContract() {
 // Exercise the actually installed wx -> node SDK adapters, replacing only
 // outbound I/O. No network, credential discovery, or root-package imports.
 const cloud=requireMarket('wx-server-sdk'),nodeRoot=path.dirname(requireMarket.resolve('@cloudbase/node-sdk/package.json'));
 const apiTransport=require(path.join(nodeRoot,'dist/utils/tcbapirequester.js')),objectTransport=require(path.join(nodeRoot,'dist/utils/request-core.js'));
 const originalApi=apiTransport.request,originalObject=objectTransport.request,{Writable,Readable}=require('node:stream'),{EventEmitter}=require('node:events');
 const fileId='cloud://fixture/lsf-media/sdk-test',data=Buffer.from('sdk-media-bytes');let metadata=0,uploaded=Buffer.alloc(0),urlCalls=0;
 apiTransport.request=async({params})=>{
  if(params.action==='storage.getUploadMetadata'){metadata++;assert.equal(params.path,'lsf-media/sdk-test');assert.equal(params.method,'put');assert.equal(params.openId,undefined);return {data:{url:'https://bucket.tcb.qcloud.la/lsf-media/sdk-test',authorization:'dummy-signature',token:'dummy-object-token',fileId,cosFileId:'dummy-file-meta'}};}
  if(params.action==='storage.batchGetDownloadUrl'){urlCalls++;assert.equal(params.file_list[0].max_age,300);return {data:{download_list:[{fileID:fileId,code:'SUCCESS',tempFileURL:'https://bucket.tcb.qcloud.la/lsf-media/sdk-test?sign=dummy',maxAge:300}]}};}
  if(params.action==='storage.batchDeleteFile')return {data:{delete_list:[{fileID:fileId,code:'SUCCESS'}]}};
  throw Error('Unexpected SDK media action '+params.action);
 };
 objectTransport.request=(options,callback)=>{assert.equal(options.method,'put');assert.equal(options.headers.authorization,'dummy-signature');assert.equal(options.headers['x-cos-meta-fileid'],'dummy-file-meta');return new Writable({write(chunk,encoding,next){uploaded=Buffer.concat([uploaded,chunk]);next();},final(next){callback(null,{statusCode:200},'');next();}});};
 const request=(url,callback)=>{const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};queueMicrotask(()=>{const response=Readable.from([data]);response.statusCode=200;response.headers={'content-length':String(data.length)};callback(response);});return req;};
 try {const {createMediaStorage}=requireMarket('./lib/media-storage'),adapter=createMediaStorage(cloud,{request});assert.equal(await adapter.write('lsf-media/sdk-test',data),fileId);assert.deepEqual(uploaded,data);assert.equal(metadata,1);assert.deepEqual(await adapter.readChunks([{fileId,size:data.length}]),[data]);assert.equal(urlCalls,1);await adapter.remove(fileId);}
 finally{apiTransport.request=originalApi;objectTransport.request=originalObject;}
}
(async()=>{assert.ok(process.versions.node.split('.').map(Number)[0]>=16);await sdkContract();await marketFlow();await mediaSdkContract();console.log('CloudBase runtime smoke PASS on '+process.version+': isolated real function entry points, SDK imports and response contract; deny-ready gate, login, two clients, shopping, atomic/idempotent stock, ship/receipt/aftersale, isolated logout; real wx/node SDK media upload, bounded media download and cleanup adapters. No cloud/network calls.');})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{Module._resolveFilename=originalResolve;fs.rmSync(isolated,{recursive:true,force:true});});
