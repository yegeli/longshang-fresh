import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { ADDRESSES } from '../public/model.js';

const source=(await readFile(new URL('../public/buyer-state-store.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.subject={getBuyerState,refreshBuyerState,mutateBuyerState,consumeBuyerOrder,clearBuyerState};';
const copy=value=>JSON.parse(JSON.stringify(value));
const domain=(change={})=>({cart:[],favorites:[],recent:[],preferredAddress:'gansu',...change});
const record=(version=1,change={})=>({state:domain(change),version,updatedAt:'2026-11-01T01:00:00.000Z'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const ORDER='DEMO-11111111-1111-4111-8111-111111111111';
function harness({mode='cloud',user='buyer-one'}={}){
  const cloud={mode,session:user?{user:{id:user}}:null,error:''},calls=[];
  let stored=record();
  class CloudError extends Error{constructor(message,status=0,code=''){super(message);Object.assign(this,{status,code});}}
  const behavior={respond:async(path,options={})=>{
    if(!options.method)return copy(stored);
    const body=JSON.parse(options.body);
    if(body.expectedVersion!==stored.version)throw new CloudError('其他设备已更新',409,'version_conflict');
    if(options.method==='PUT'){stored=record(stored.version+1,body.state);return copy(stored);}
    stored=record(stored.version+1);return {...copy(stored),consumed:true};
  }};
  const context=vm.createContext({structuredClone,ADDRESSES,CloudError,getCloudState:()=>copy(cloud),
    apiRequest:async(path,options)=>{calls.push({path,options:options?copy(options):undefined});return behavior.respond(path,options);},
    localStorage:{getItem(){throw new Error('Cloud buyer state must not import browser records');},setItem(){throw new Error('Cloud buyer state must not fall back to browser records');}},
    sessionStorage:{getItem(){throw new Error('Buyer state must not persist account data locally');},setItem(){throw new Error('Buyer state must not persist account data locally');}}});
  new vm.Script(source).runInContext(context);
  return {...context.subject,cloud,calls,behavior,setServer:value=>{stored=copy(value);},server:()=>copy(stored)};
}

test('only authenticated cloud accounts load shopping state; local or anonymous sessions never import browser records',async()=>{
  for(const options of [{mode:'local'},{mode:'uninitialized'},{user:null}]){
    const h=harness(options),state=await h.refreshBuyerState();
    assert.equal(state.ready,false);assert.equal(state.accountId,'');assert.deepEqual(copy(state.cart),[]);assert.equal(h.calls.length,0);
    await assert.rejects(h.mutateBuyerState(draft=>{draft.favorites=['goji'];}),error=>error.status===401);
    await assert.rejects(h.consumeBuyerOrder(ORDER),error=>error.status===401);assert.equal(h.calls.length,0);
  }
});

test('cloud writes are serialized transforms of the latest confirmed revision and never update optimistically',async()=>{
  const h=harness();await h.refreshBuyerState();let finish;
  h.behavior.respond=async(path,options)=>{
    const body=JSON.parse(options.body);
    if(body.expectedVersion===1)return new Promise(resolve=>{finish=()=>resolve(record(2,body.state));});
    return record(body.expectedVersion+1,body.state);
  };
  const first=h.mutateBuyerState(draft=>{draft.favorites=['goji'];});
  const second=h.mutateBuyerState(draft=>{draft.recent=['removed-public-product'];draft.preferredAddress='other';});
  await tick();assert.equal(h.calls.length,2);assert.equal(h.getBuyerState().saving,true);assert.deepEqual(copy(h.getBuyerState().favorites),[]);
  finish();await first;await second;
  const state=h.getBuyerState();assert.equal(state.version,3);assert.equal(state.saving,false);assert.deepEqual(copy(state.favorites),['goji']);assert.deepEqual(copy(state.recent),['removed-public-product']);assert.equal(state.preferredAddress,'other');
  const writes=h.calls.slice(1);assert.deepEqual(writes.map(call=>JSON.parse(call.options.body).expectedVersion),[1,2]);
  assert.deepEqual(Object.keys(JSON.parse(writes[1].options.body)).sort(),['expectedVersion','state']);
  assert.deepEqual(Object.keys(JSON.parse(writes[1].options.body).state).sort(),['cart','favorites','preferredAddress','recent']);
  state.favorites.length=0;assert.deepEqual(copy(h.getBuyerState().favorites),['goji']);
});

test('a late read or late read failure cannot erase a newer confirmed write',async()=>{
  for(const failedRead of [false,true]){
    const h=harness();await h.refreshBuyerState();let finish,reject;
    h.behavior.respond=async(path,options)=>options?.method?record(2,JSON.parse(options.body).state):new Promise((resolve,rejectPromise)=>{finish=resolve;reject=rejectPromise;});
    const read=h.refreshBuyerState();await h.mutateBuyerState(draft=>{draft.favorites=['goji'];});
    if(failedRead)reject(new Error('old read failed'));else finish(record(1));
    await read;assert.equal(h.getBuyerState().version,2);assert.deepEqual(copy(h.getBuyerState().favorites),['goji']);assert.equal(h.getBuyerState().error,'');assert.equal(h.getBuyerState().loading,false);
  }
});

test('older successful reads cannot overwrite a later refresh',async()=>{
  const h=harness();let finish;
  h.behavior.respond=()=>new Promise(resolve=>{finish=resolve;});const first=h.refreshBuyerState();
  h.behavior.respond=async()=>record(7,{favorites:['pear']});await h.refreshBuyerState();finish(record(1,{favorites:['goji']}));await first;
  assert.equal(h.getBuyerState().version,7);assert.deepEqual(copy(h.getBuyerState().favorites),['pear']);
});

test('account changes synchronously clear cached data and reject old writes without touching the new account',async()=>{
  const h=harness();h.setServer(record(1,{favorites:['jingtai-apple']}));await h.refreshBuyerState();let finish;
  h.behavior.respond=(path,options)=>options?.method?new Promise(resolve=>{finish=resolve;}):Promise.resolve(record(5,{favorites:['pear']}));
  const old=h.mutateBuyerState(draft=>{draft.favorites=['goji'];});await tick();
  h.cloud.session.user.id='buyer-two';const blank=h.getBuyerState();assert.equal(blank.accountId,'buyer-two');assert.equal(blank.ready,false);assert.deepEqual(copy(blank.favorites),[]);
  await h.refreshBuyerState();finish(record(2,{favorites:['goji']}));await assert.rejects(old,error=>error.code==='account_changed');
  assert.equal(h.getBuyerState().version,5);assert.deepEqual(copy(h.getBuyerState().favorites),['pear']);assert.equal(h.getBuyerState().saving,false);
});

test('old account reads and explicit cache clears cannot restore previous account records',async()=>{
  const h=harness();let finish;h.behavior.respond=()=>new Promise(resolve=>{finish=resolve;});const old=h.refreshBuyerState();
  h.cloud.session.user.id='buyer-two';h.behavior.respond=async()=>record(3,{recent:['pear']});await h.refreshBuyerState();finish(record(1,{recent:['goji']}));await old;
  assert.deepEqual(copy(h.getBuyerState().recent),['pear']);
  let end;h.behavior.respond=()=>new Promise(resolve=>{end=resolve;});const pending=h.refreshBuyerState();h.clearBuyerState();end(record(4,{recent:['goji']}));await pending;
  assert.equal(h.getBuyerState().ready,false);assert.deepEqual(copy(h.getBuyerState().recent),[]);
});

test('a revision conflict reads once, aborts queued edits, and requires an explicit user operation at the refreshed version',async()=>{
  const h=harness();await h.refreshBuyerState();let fail;
  h.behavior.respond=(path,options)=>options?.method?new Promise((resolve,reject)=>{fail=()=>reject(Object.assign(new Error('other device'),{status:409,code:'version_conflict'}));}):Promise.resolve(record(2,{favorites:['corn']}));
  const first=h.mutateBuyerState(draft=>{draft.favorites=['goji'];});
  const queued=h.mutateBuyerState(draft=>{draft.recent=['pear'];});
  const firstRejected=assert.rejects(first,error=>error.status===409&&/核对.*重做/.test(error.message));
  const queuedRejected=assert.rejects(queued,error=>error.code==='shopping_queue_cancelled');
  await tick();fail();await firstRejected;await queuedRejected;
  assert.equal(h.calls.filter(call=>call.options?.method==='PUT').length,1);assert.equal(h.calls.filter(call=>!call.options?.method).length,2);
  assert.equal(h.getBuyerState().version,2);assert.deepEqual(copy(h.getBuyerState().favorites),['corn']);assert.deepEqual(copy(h.getBuyerState().recent),[]);assert.equal(h.getBuyerState().saving,false);
  h.behavior.respond=async(path,options)=>record(3,JSON.parse(options.body).state);
  await h.mutateBuyerState(draft=>{draft.recent=['pear'];});assert.equal(JSON.parse(h.calls.at(-1).options.body).expectedVersion,2);assert.equal(h.getBuyerState().error,'');
});

test('an uncertain successful PUT is read back once and clearly asks the buyer to inspect it instead of automatically repeating the action',async()=>{
  const h=harness();await h.refreshBuyerState();let applied;
  h.behavior.respond=async(path,options)=>{if(options?.method){applied=record(2,JSON.parse(options.body).state);throw Object.assign(new Error('network unavailable'),{status:0});}return applied;};
  await assert.rejects(h.mutateBuyerState(draft=>{draft.favorites=['goji'];}),/确认本次操作是否已生效/);
  assert.equal(h.calls.filter(call=>call.options?.method==='PUT').length,1);assert.equal(h.getBuyerState().version,2);assert.deepEqual(copy(h.getBuyerState().favorites),['goji']);
  h.behavior.respond=async()=>{throw Object.assign(new Error('offline'),{status:0});};
  await assert.rejects(h.mutateBuyerState(draft=>{draft.favorites=['pear'];}),/读取失败/);
  assert.equal(h.getBuyerState().ready,false);assert.deepEqual(copy(h.getBuyerState().favorites),[]);
  const before=h.calls.length;await assert.rejects(h.mutateBuyerState(draft=>{draft.favorites=['corn'];}),/先重新读取/);assert.equal(h.calls.length,before);
});

test('response and transform validation prevent private fields, duplicate SKUs, invalid quantities and real addresses',async()=>{
  const h=harness();
  for(const change of [value=>{value.accountId='private-owner';},value=>{value.state.phone='真实电话';},value=>{value.state.preferredAddress='私人地址';},value=>{value.state.cart=[{productId:'apple',variant:'small',quantity:1,selected:'true'}];},value=>{value.version=-1;}]){
    const value=record();change(value);h.behavior.respond=async()=>value;
    const state=await h.refreshBuyerState();assert.equal(state.ready,false);assert.match(state.error,/格式异常/);assert.deepEqual(copy(state.cart),[]);
  }
  h.behavior.respond=async()=>record();await h.refreshBuyerState();const before=h.calls.length;
  for(const change of [draft=>{draft.phone='真实电话';},draft=>{draft.cart=[{productId:'apple',variant:'small',quantity:11,selected:true}];},draft=>{draft.preferredAddress='私人地址';},draft=>{draft.favorites=['goji','goji'];}])await assert.rejects(h.mutateBuyerState(change),error=>error.status===400);
  assert.equal(h.calls.length,before);assert.equal(h.getBuyerState().version,1);
});

test('confirmed-order consumption uses only the current account endpoint and accepts an idempotent unchanged revision',async()=>{
  const h=harness();await h.refreshBuyerState();
  await h.consumeBuyerOrder(ORDER);let request=h.calls.at(-1);assert.equal(request.path,'/api/v1/me/shopping/consume-order');assert.equal(request.options.method,'POST');assert.deepEqual(JSON.parse(request.options.body),{orderId:ORDER,expectedVersion:1});assert.equal(h.getBuyerState().version,2);
  h.behavior.respond=async()=>({...record(2),consumed:true});await h.consumeBuyerOrder(ORDER);assert.equal(h.getBuyerState().version,2);
  const before=h.calls.length;await assert.rejects(h.consumeBuyerOrder('other-order'),error=>error.status===400);assert.equal(h.calls.length,before);
});
