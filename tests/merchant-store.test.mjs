import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=(await readFile(new URL('../public/merchant-store.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.subject={loadMerchants,loadMerchant,saveMerchant,loadMerchantAudit};';
function harness() {
  const cloud={mode:'cloud',session:{user:{id:'admin-one'},role:'admin',canManage:true},error:''},calls=[];
  const behavior={respond:async path=>path.endsWith('/audit')?{events:[]}:{merchants:[],merchant:{id:'MERCHANT-ONE',version:2}}};
  const context=vm.createContext({getCloudState:()=>cloud,managementScopeKey:()=>JSON.stringify(cloud),CloudError:class extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}},apiRequest:async(path,options)=>{calls.push({path,options});return await behavior.respond(path,options);},localStorage:{getItem(){throw new Error('Private merchant data must not read local storage');},setItem(){throw new Error('Private merchant data must not write local storage');}}});
  new vm.Script(source).runInContext(context);
  return {...context.subject,cloud,calls,behavior};
}
const input={name:'景泰采购员',email:'jingtai@example.test',region:'甘肃景泰',permissions:['products','orders'],status:'enabled'};

test('merchant store sends create, versioned update and audit through cloud endpoints only',async()=>{
  const h=harness(); await h.loadMerchants(); await h.saveMerchant({...input,unexpected:'discarded'}); await h.saveMerchant(input,{id:'MERCHANT-ONE',expectedVersion:7}); await h.loadMerchant('MERCHANT/a'); await h.loadMerchantAudit('MERCHANT-ONE');
  assert.deepEqual(h.calls.map(call=>call.path),['/api/v1/admin/merchants','/api/v1/admin/merchants','/api/v1/admin/merchants/MERCHANT-ONE','/api/v1/admin/merchants/MERCHANT%2Fa','/api/v1/admin/merchants/MERCHANT-ONE/audit']);
  assert.equal(h.calls[1].options.method,'POST'); assert.equal(h.calls[2].options.method,'PUT');
  assert.deepEqual(JSON.parse(h.calls[1].options.body),input); assert.equal(JSON.parse(h.calls[2].options.body).expectedVersion,7);
});

test('merchant store rejects buyers, purchasers, revoked managers and local mode before any cloud request',async()=>{
  for(const change of [{session:{user:{id:'purchaser'},role:'merchant',canManage:true}},{session:{user:{id:'buyer'},role:'buyer',canManage:false}},{session:{user:{id:'admin'},role:'admin',canManage:false}},{mode:'local'},{error:'session unavailable'}]) {
    const h=harness();Object.assign(h.cloud,change);
    await assert.rejects(h.loadMerchants(),error=>error.status===403); await assert.rejects(h.saveMerchant(input),error=>error.status===403); assert.equal(h.calls.length,0);
  }
});

test('merchant store discards an in-flight response after the admin identity or management scope changes',async()=>{
  for(const mutate of [h=>{h.cloud.session.user.id='admin-two';},h=>{h.cloud.session.permissions=['products'];},h=>{h.cloud.session.role='merchant';}]) {
    const h=harness();let finish;h.behavior.respond=()=>new Promise(resolve=>{finish=resolve;});
    const pending=h.loadMerchants();mutate(h);finish({merchants:[{id:'PRIVATE-OLD-ADMIN'}]});
    await assert.rejects(pending,error=>error.code==='account_changed'||error.status===403);
  }
});

test('merchant store preserves conflict errors and rejects malformed private list or audit responses',async()=>{
  const h=harness(),conflict=Object.assign(new Error('版本冲突'),{status:409});h.behavior.respond=async()=>{throw conflict;};
  await assert.rejects(h.saveMerchant(input,{id:'MERCHANT-ONE',expectedVersion:1}),error=>error===conflict);
  h.behavior.respond=async()=>({merchants:Array.from({length:201},()=>({})),events:null});
  await assert.rejects(h.loadMerchants(),error=>error.code==='INVALID_RESPONSE'); await assert.rejects(h.loadMerchantAudit('MERCHANT-ONE'),error=>error.code==='INVALID_RESPONSE');
});
