import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=(await readFile(new URL('../public/inventory-store.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.subject={loadInventories,saveInventory,loadInventoryHistory};';
const record=(changes={})=>({productId:'apple',configured:true,stocks:{small:20,family:12},batchId:'BATCH-ONE',batchCode:'DEMO-ONE',harvestDate:'2026-11-01',note:'模拟批次',version:1,updatedAt:'2026-11-01T03:00:00.000Z',...changes});
const input={stocks:{small:20,family:12},batchCode:'DEMO-ONE',harvestDate:'2026-11-01',note:'模拟批次',reason:'模拟调整'};
function harness() {
  const cloud={mode:'cloud',session:{user:{id:'purchaser-one'},role:'merchant',canManage:true,permissions:['products']},error:''},calls=[];
  class CloudError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
  const scope=()=>JSON.stringify(cloud);
  const permission=()=>{if(cloud.mode!=='cloud'||cloud.error||!cloud.session?.user||!cloud.session.canManage||!(cloud.session.role==='admin'||cloud.session.permissions?.includes('products')))throw new CloudError('拒绝',403,'FORBIDDEN');};
  const behavior={respond:async path=>path.endsWith('/history')?{events:[]}:{inventories:[record()],inventory:record()}};
  const context=vm.createContext({getCloudState:()=>cloud,managementScopeKey:scope,requirePermission:permission,requireUnchangedScope:previous=>{if(previous!==scope())throw new CloudError('账号变化',409,'account_changed');},CloudError,apiRequest:async(path,options)=>{calls.push({path,options});return await behavior.respond(path,options);},localStorage:{getItem(){throw new Error('Cloud inventory must not read local storage');},setItem(){throw new Error('Cloud inventory must not write local storage');}}});
  new vm.Script(source).runInContext(context);
  return {...context.subject,cloud,calls,behavior};
}

test('public stock reads need cloud connectivity but no merchant permission',async()=>{
  const h=harness();h.cloud.session=null;await h.loadInventories();assert.equal(h.calls[0].path,'/api/v1/inventory');
  await assert.rejects(h.loadInventories({admin:true}),error=>error.status===403);assert.equal(h.calls.length,1);
  h.cloud.mode='local';await assert.rejects(h.loadInventories(),error=>error.status===403);assert.equal(h.calls.length,1);
});

test('inventory management uses scoped cloud routes, exact allowed body fields and expected versions',async()=>{
  const h=harness();await h.loadInventories({admin:true});await h.saveInventory('apple/a',{...input,ownerId:'not-sent'},{expectedVersion:7});await h.loadInventoryHistory('apple/a');
  assert.deepEqual(h.calls.map(call=>call.path),['/api/v1/admin/inventory','/api/v1/admin/inventory/apple%2Fa','/api/v1/admin/inventory/apple%2Fa/history']);
  assert.equal(h.calls[1].options.method,'PUT');assert.deepEqual(JSON.parse(h.calls[1].options.body),{expectedVersion:7,...input});
});

test('orders-only, disabled, unauthenticated and local callers cannot request private inventories or mutate',async()=>{
  for(const change of [{session:{user:{id:'orders'},role:'merchant',canManage:true,permissions:['orders']}},{session:null},{error:'unavailable'},{mode:'local'}]) {
    const h=harness();Object.assign(h.cloud,change);
    await assert.rejects(h.loadInventories({admin:true}),error=>error.status===403);await assert.rejects(h.saveInventory('apple',input,{expectedVersion:0}),error=>error.status===403);await assert.rejects(h.loadInventoryHistory('apple'),error=>error.status===403);assert.equal(h.calls.length,0);
  }
});

test('private in-flight stock and history responses are discarded after identity or grant changes',async()=>{
  for(const type of ['list','save','history'])for(const changed of ['identity','permission','version']) {
    const h=harness();let finish;h.behavior.respond=()=>new Promise(resolve=>{finish=resolve;});
    const pending=type==='list'?h.loadInventories({admin:true}):type==='save'?h.saveInventory('apple',input,{expectedVersion:1}):h.loadInventoryHistory('apple');
    if(changed==='identity')h.cloud.session.user.id='purchaser-two';else if(changed==='permission')h.cloud.session.permissions=['orders'];else h.cloud.session.merchant={version:2};
    finish({inventories:[record()],inventory:record(),events:[]});await assert.rejects(pending,error=>error.code==='account_changed'||error.status===403);
  }
});

test('inventory responses reject malformed or duplicate counts, preserve server errors, and accept large cancellation returns',async()=>{
  const h=harness();
  for(const result of [{inventories:null},{inventories:[record(),record()]},{inventories:[record({stocks:{small:-1,family:12}})]},{inventories:[record({version:'1'})]}]) {
    h.behavior.respond=async()=>result;await assert.rejects(h.loadInventories({admin:true}),error=>error.code==='INVALID_RESPONSE');
  }
  h.behavior.respond=async()=>({inventories:[record({stocks:{small:1000001,family:12}})]});assert.equal((await h.loadInventories()).inventories[0].stocks.small,1000001);
  h.behavior.respond=async()=>({events:Array.from({length:51},()=>({}))});await assert.rejects(h.loadInventoryHistory('apple'),error=>error.code==='INVALID_RESPONSE');
  const conflict=Object.assign(new Error('库存版本变化'),{status:409,code:'version_conflict'});h.behavior.respond=async()=>{throw conflict;};await assert.rejects(h.saveInventory('apple',input,{expectedVersion:1}),error=>error===conflict);
});
