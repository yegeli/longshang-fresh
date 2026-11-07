import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {runInThisContext} from 'node:vm';
import {MemoryCloudbaseDB} from './fixtures/cloudbase-db.mjs';
const entry=fileURLToPath(new URL('../cloudfunctions/market/index.js',import.meta.url));
const require=createRequire(entry);
const {CloudbaseStore,digest}=require('./lib/store');
const {schemaVersion,manifestHash}=require('./lib/provision-contract');
const APPID='wx1111111111111111',ENV='entry-cloudbase-test';
const account=openid=>'wechat:'+digest(APPID+'\0'+openid);
async function fixture() {
 const db=new MemoryCloudbaseDB(),store=new CloudbaseStore(db),env={WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV,BOOTSTRAP_ADMIN_ACCOUNT_ID:account('admin')};
 let context={APPID,OPENID:'buyer',ENV},contextReads=0;
 await store.set('meta','provision-ready',{id:'provision-ready',schemaVersion,manifestHash,appId:APPID,envId:ENV,ready:true,verifiedAt:'2026-11-07T08:00:00.000Z',operatorAccountId:account('operator')});
 // Execute the real deployed entry point with only the platform SDK boundary
 // replaced. The production store, validators, readiness gate and auth run.
 const sdk={DYNAMIC_CURRENT_ENV:'DYNAMIC',init(){},database(){return db;},getWXContext(){contextReads++;return context;}};
 const module={exports:{}};
 const load=id=>id==='wx-server-sdk'?sdk:id==='./lib/config'?{runtimeConfig:()=>env}:require(id);
 runInThisContext('(function(exports,require,module,__filename,__dirname){'+readFileSync(entry,'utf8')+'\n})',{filename:entry})(module.exports,load,module,entry,dirname(entry));
 return {main:module.exports.main,setContext:value=>{context=value;},reads:()=>contextReads,store};
}
test('CloudBase market entry accepts platform userInfo and tcbContext while trusted context alone establishes identity and role',async()=>{
 const f=await fixture(),event={path:'/api/v1/auth/wechat/login',method:'POST',body:{},userInfo:{appId:'wx2222222222222222',openId:'admin',APPID,OPENID:'admin',role:'admin',envId:'forged'},tcbContext:{APPID,OPENID:'admin',role:'admin'}};
 const login=await f.main(event);assert.equal(login.status,200,JSON.stringify(login));assert.equal(login.body.session.user.id,account('buyer'));assert.equal(login.body.session.role,'buyer');assert.equal(event.userInfo.role,'admin','entry does not mutate incoming metadata');assert.equal(event.tcbContext.role,'admin');
 const token=login.body.token,request={sessionToken:token,expectedUserId:account('buyer'),userInfo:{APPID,OPENID:'admin',role:'admin',permissions:['products','orders','aftersales']},tcbContext:{appid:APPID,openid:'admin',role:'admin'}};
 assert.equal((await f.main({...request,path:'/api/v1/session'})).body.role,'buyer');
 const seed=await f.main({...request,path:'/api/v1/admin/seed',method:'POST',body:{}});assert.equal(seed.status,403);assert.equal(await f.store.get('users',account('admin')),null);assert.equal(f.reads(),3);
});
test('CloudBase market entry strips only known transport fields and preserves strict rejection of other fields and bad context',async()=>{
 const f=await fixture(),base={path:'/api/v1/session',userInfo:{appId:APPID,openId:'admin',envId:ENV,role:'admin'},tcbContext:{APPID,OPENID:'admin',ENV,role:'admin'}};
 for(const extra of [{OPENID:'admin'},{APPID},{role:'admin'},{envId:ENV},{ready:true},{unexpected:true}]) {
  const result=await f.main({...base,...extra});assert.equal(result.status,400);assert.equal(result.body.error.code,'event_invalid');
 }
 for(const invalid of [null,[],42,'request',Object.assign(Object.create(null),base),Object.assign(Object.create({inherited:'untrusted'}),base),Object.assign(new Date(),base)])assert.equal((await f.main(invalid)).status,400);
 assert.equal((await f.main({...base,userInfo:null,tcbContext:null})).status,200);
 const onlyTcb={path:'/api/v1/auth/wechat/login',method:'POST',body:{},tcbContext:{APPID,OPENID:'admin',role:'admin'}};
 const login=await f.main(onlyTcb);assert.equal(login.status,200);assert.equal(login.body.session.user.id,account('buyer'));assert.equal(login.body.session.role,'buyer');
 f.setContext({APPID:'wx2222222222222222',OPENID:'buyer',ENV});const wrongApp=await f.main(base);assert.equal(wrongApp.status,401);assert.equal(wrongApp.body.error.code,'wechat_context_invalid');
 f.setContext({APPID,OPENID:'buyer',ENV:'wrong-environment'});const wrongEnv=await f.main(base);assert.equal(wrongEnv.status,503);assert.equal(wrongEnv.body.error.code,'cloudbase_not_ready');
});
