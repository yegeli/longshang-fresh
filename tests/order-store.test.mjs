import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeCloudMode } from '../public/cloud-client.js';
import { loadCloudOrders, loadCloudOrder, quoteCloudOrder, submitCloudOrder, mutateCloudOrder, createOrderRequestKey } from '../public/order-store.js';
import { BASE_CATALOG, setCatalog, orderItems, validOrders } from '../public/model.js';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const buyer = id => ({ user: { id }, role: 'buyer', canManage: false });
const admin = { user: { id: 'operator' }, role: 'admin', canManage: true };
const item = { productId: 'retired-fruit', product: '下单时的水果名称', image: 'assets/pear.jpg', variant: 'small', variantLabel: '下单时规格', weight: '2.5kg', unitPrice: 1234, quantity: 2, subtotal: 2468 };
const order = (suffix = 'ONE', version = 1) => ({ id: `DEMO-${suffix}`, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...item, items: [{ ...item }], subtotal: 2468, shipping: 600, total: 3068, address: 'gansu', status: 'created', version });
async function session(value) { globalThis.fetch = async () => json(value); await initializeCloudMode({ force: true }); }
function forbidLocalStorage() { Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Cloud orders may not access localStorage'); } }); }

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage;
  setCatalog(BASE_CATALOG);
});

test('server order snapshots survive an empty or changed public catalog without accepting corrupt legacy orders', async () => {
  setCatalog([]);
  assert.deepEqual(orderItems(order()), [item]);
  assert.deepEqual(validOrders([{ ...order(), version: undefined }]), []);
  setCatalog([{ ...BASE_CATALOG[0], id: item.productId, name: '新名称' }]);
  assert.equal(orderItems(order())[0].product, item.product);
  assert.equal(orderItems(order())[0].unitPrice, 1234);
});

test('cloud listing loads all pages, keeps versions, and never reads device-local order records', async () => {
  await session(buyer('a')); forbidLocalStorage();
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push(path); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    return path.includes('cursor=') ? json({ orders: [order('TWO'), order('ONE', 2)], nextCursor: null }) : json({ orders: [order()], nextCursor: 'page/2' });
  };
  const result = await loadCloudOrders();
  assert.equal(result.orders.length, 2); assert.equal(result.orders[0].version, 2);
  assert.deepEqual(calls, ['/api/v1/orders', '/api/v1/orders?cursor=page%2F2']);
  assert.ok(Number.isFinite(Date.parse(result.lastSyncedAt)));
});

test('anonymous and non-manager clients cannot send protected order requests', async () => {
  await session({ user: null, role: 'anonymous', canManage: false });
  let calls = 0; globalThis.fetch = async () => { calls++; throw Error('unexpected'); };
  await assert.rejects(loadCloudOrders(), error => error.status === 401);
  assert.equal(calls, 0);
  await session(buyer('a'));
  globalThis.fetch = async () => { calls++; throw Error('unexpected'); };
  await assert.rejects(loadCloudOrders({ manager: true }), error => error.status === 403);
  await assert.rejects(mutateCloudOrder('DEMO-ONE', 'aftersale/resolve', { expectedVersion: 1 }), error => error.status === 403);
  assert.equal(calls, 0);
});

test('network failures retain the caller idempotency payload for a safe retry without creating a local order', async () => {
  await session(buyer('a')); forbidLocalStorage();
  const input = { items: [{ productId: item.productId, variant: 'small', quantity: 2 }], address: 'gansu', expectedTotal: 3068, productVersions: { 'retired-fruit': 3 }, idempotencyKey: createOrderRequestKey() };
  const before = structuredClone(input), sent = [];
  globalThis.fetch = async (_path, options) => { sent.push(JSON.parse(options.body)); throw Error('response lost'); };
  await assert.rejects(submitCloudOrder(input), error => error.code === 'NETWORK_ERROR');
  globalThis.fetch = async (_path, options) => { sent.push(JSON.parse(options.body)); return json({ order: order(), replayed: true }); };
  assert.equal((await submitCloudOrder(input)).id, 'DEMO-ONE');
  assert.deepEqual(sent, [before, before]); assert.deepEqual(input, before);
});

test('version conflicts retain the form payload and do not replace expectedVersion', async () => {
  await session(admin); const draft = { expectedVersion: 2, carrier: '演示快递', tracking: 'DEMO-TEST' };
  const before = structuredClone(draft);
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/v1/admin/orders/DEMO-ONE/ship'); assert.deepEqual(JSON.parse(options.body), draft);
    return json({ error: { code: 'version_conflict', message: '订单已被其他设备更新' } }, 409);
  };
  await assert.rejects(mutateCloudOrder('DEMO-ONE', 'ship', draft, { manager: true }), error => error.status === 409);
  assert.deepEqual(draft, before);
});

test('an older request cannot publish the previous account data after switching accounts', async () => {
  await session(buyer('a'));
  let release; globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = loadCloudOrders();
  await session(buyer('b')); release(json({ orders: [order()], nextCursor: null }));
  await assert.rejects(pending, error => error.code === 'account_changed');
});

test('invalid order responses and looping pagination fail explicitly rather than showing partial success', async () => {
  await session(buyer('a'));
  globalThis.fetch = async () => json({ orders: [{ ...order(), total: 1 }], nextCursor: null });
  await assert.rejects(loadCloudOrders(), error => error.code === 'invalid_order_response');
  globalThis.fetch = async () => json({ orders: [order()], nextCursor: 'loop' });
  await assert.rejects(loadCloudOrders(), error => error.code === 'invalid_order_response');
  globalThis.fetch = async () => json({ order: order('SOMEONE-ELSE') });
  await assert.rejects(loadCloudOrder('DEMO-ONE'), error => error.code === 'invalid_order_response');
});

test('quotes and successful management mutations use only the designated JSON API routes', async () => {
  await session(admin); const calls = [];
  globalThis.fetch = async (path, options) => {
    const body = JSON.parse(options.body); calls.push({ path, body });
    assert.equal(options.method, 'POST'); assert.equal(options.headers['Content-Type'], 'application/json');
    return path.endsWith('/quote') ? json({ quote: { items: [item], address: 'gansu', subtotal: 2468, shipping: 600, quantity: 2, total: 3068, productVersions: { 'retired-fruit': 3 }, inventoryVersions: { 'retired-fruit': 7 } } }) : json({ order: { ...order('ONE', 2), merchantNote: '模拟备注' } });
  };
  const items = [{ productId: 'retired-fruit', variant: 'small', quantity: 2 }];
  assert.equal((await quoteCloudOrder(items, 'gansu')).total, 3068);
  assert.equal((await mutateCloudOrder('DEMO-ONE', 'note', { expectedVersion: 1, note: '模拟备注' }, { manager: true })).version, 2);
  assert.deepEqual(calls[0], { path: '/api/v1/orders/quote', body: { items, address: 'gansu' } });
});

test('order batch snapshots survive changed catalogs and malformed batch dates fail closed',()=>{
  const snapshot={...item,batchId:'BATCH-ONE',batchCode:'DEMO-20261101',harvestDate:'2026-11-01',batchNote:'模拟采摘'};
  setCatalog([]);
  assert.deepEqual(orderItems({...order(),items:[snapshot]}),[snapshot]);
  assert.deepEqual(orderItems({...order(),items:[{...snapshot,harvestDate:'2026-02-30'}]}),[]);
  assert.deepEqual(orderItems({...order(),items:[{...snapshot,batchCode:undefined}]}),[]);
});

test('quotes without usable inventory versions cannot be submitted as confirmed stock quotes',async()=>{
  await session(buyer('a'));
  for(const inventoryVersions of [undefined,[],{}, {'retired-fruit':0}]){
    globalThis.fetch=async()=>json({quote:{items:[item],address:'gansu',total:3068,productVersions:{'retired-fruit':1},inventoryVersions}});
    await assert.rejects(quoteCloudOrder([{productId:item.productId,variant:'small',quantity:2}],'gansu'),error=>error.code==='invalid_order_response');
  }
});
