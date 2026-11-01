import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeCloudMode } from '../public/cloud-client.js';
import { refreshBuyerInventory, inventoryFor, availability } from '../public/buyer-inventory.js';
import { BASE_CATALOG } from '../public/model.js';

const originalFetch = globalThis.fetch;
const product = BASE_CATALOG[0];
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const row = stocks => ({productId:product.id,configured:true,stocks,batchId:'BATCH-ONE',batchCode:'DEMO',harvestDate:'2026-11-01',note:'模拟',version:1,updatedAt:'2026-11-01T00:00:00Z'});
async function cloud() { globalThis.fetch=async()=>json({user:null,role:'anonymous',canManage:false});await initializeCloudMode({force:true}); }
test.afterEach(()=>{globalThis.fetch=originalFetch;});

test('public stock distinguishes unconfigured, sold out and low per-variant counts',async()=>{
  await cloud();globalThis.fetch=async()=>json({inventories:[]});await refreshBuyerInventory();
  assert.equal(availability(product,'small').available,false);assert.match(availability(product,'small').message,/待备货/);
  globalThis.fetch=async()=>json({inventories:[row({small:2,family:0})]});await refreshBuyerInventory();
  assert.equal(availability(product,'small',2).available,true);assert.equal(availability(product,'small',3).available,false);
  assert.match(availability(product,'small',3).message,/仅剩 2 份/);assert.match(availability(product,'family').message,/缺货/);
  assert.equal(availability({...product,status:'offline'},'small').available,false);
  const copy=inventoryFor(product.id);copy.stocks.small=900;
  assert.equal(inventoryFor(product.id).stocks.small,2);
});

test('failed or malformed stock refresh clears stale availability and never permits buying',async()=>{
  await cloud();globalThis.fetch=async()=>json({inventories:[row({small:20,family:12})]});await refreshBuyerInventory();
  assert.equal(availability(product,'small').available,true);
  for(const read of [async()=>{throw Error('offline');},async()=>json({inventories:[row({small:-1,family:12})]})]){
    globalThis.fetch=read;await refreshBuyerInventory();assert.equal(inventoryFor(product.id),null);
    assert.equal(availability(product,'small').available,false);assert.match(availability(product,'small').message,/无法读取/);
  }
});

test('an older inventory response cannot restore stock after a newer sold-out result',async()=>{
  await cloud();let finish;globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});const old=refreshBuyerInventory();
  globalThis.fetch=async()=>json({inventories:[row({small:0,family:0})]});await refreshBuyerInventory();
  finish(json({inventories:[row({small:20,family:12})]}));await old;
  assert.equal(availability(product,'small').stock,0);
});
