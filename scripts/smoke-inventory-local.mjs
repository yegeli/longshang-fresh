#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BASE_CATALOG } from '../public/model.js';

// Fake trusted identities belong exclusively to the local test Worker. Refuse
// remote origins, credentials, non-root URLs and redirects before sending them.
let base;
try {
  base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.username + base.password + base.search + base.hash, '');
  assert.equal(base.pathname, '/');
} catch {
  console.error('Inventory smoke test requires an HTTP loopback root URL, without credentials or redirects.');
  process.exit(1);
}

const suffix = randomUUID().slice(0, 8);
const admin = { id: process.env.SMOKE_ADMIN_ID || 'local_seedy', email: process.env.SMOKE_ADMIN_EMAIL || 'seedy@sites.test' };
const a = { id: `inventory-seller-a-${suffix}`, email: `inventory-seller-a-${suffix}@example.test` };
const b = { id: `inventory-seller-b-${suffix}`, email: `inventory-seller-b-${suffix}@example.test` };
const buyers = [0, 1].map(number => ({ id: `inventory-buyer-${number}-${suffix}`, email: `inventory-buyer-${number}-${suffix}@example.test` }));
const profiles = new Map();
const orders = [];
let checks = 0;

async function call(path, { user = admin, method = 'GET', body, expected = 200, withStatus = false } = {}) {
  assert.ok(path.startsWith('/api/v1/'));
  const headers = { Accept: 'application/json' };
  if (user) { headers['oai-authenticated-user-id'] = user.id; headers['oai-authenticated-user-email'] = user.email; }
  if (body !== undefined) { headers.Origin = base.origin; headers['Content-Type'] = 'application/json'; }
  const response = await fetch(base.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  let result;
  try { result = await response.json(); } catch { throw new Error(`${method} ${path}: response was not JSON`); }
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${path}: expected ${expected}, got ${response.status}; code=${result?.error?.code || 'none'}`);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  checks++;
  return withStatus ? { status: response.status, result } : result;
}
const post = (path, body, user = admin, expected = 200, withStatus = false) => call('/api/v1' + path, { user, method: 'POST', body, expected, withStatus });
async function merchant(user, name, region) {
  const result = await post('/admin/merchants', { name, region, email: user.email, status: 'enabled', permissions: ['products', 'orders', 'aftersales'] }, admin, 201);
  profiles.set(user.id, result.merchant);
  const session = await call('/api/v1/session', { user });
  assert.equal(session.role, 'merchant'); assert.equal(session.canManage, true);
  profiles.set(user.id, (await call('/api/v1/admin/merchants/' + result.merchant.id)).merchant);
}
async function updateMerchant(user, patch) {
  const profile = profiles.get(user.id);
  const current = (await call('/api/v1/admin/merchants/' + profile.id)).merchant;
  const body = { name: current.name, email: current.email, region: current.region, permissions: current.permissions, status: current.status, ...patch, expectedVersion: current.version };
  const updated = (await call('/api/v1/admin/merchants/' + current.id, { method: 'PUT', body })).merchant;
  profiles.set(user.id, updated); return updated;
}
async function product(user, id, name) {
  const value = { ...structuredClone(BASE_CATALOG[0]), id, name, status: 'published' };
  return (await call('/api/v1/admin/products/' + id, { user, method: 'PUT', body: { product: value, expectedVersion: 0 } })).product;
}
async function inventory(id, user = a) {
  const result = (await call('/api/v1/admin/inventory', { user })).inventories.find(value => value.productId === id);
  assert.ok(result, 'Managed inventory must include the owned product.'); return result;
}
async function setInventory(id, patch, user = a, { expected = 200, version } = {}) {
  const current = await inventory(id, user);
  const body = { stocks: current.stocks, batchCode: current.batchCode, harvestDate: current.harvestDate, note: current.note,
    reason: '本机自动验收：调整模拟可售余量', ...patch, expectedVersion: version ?? current.version };
  return (await call('/api/v1/admin/inventory/' + id, { user, method: 'PUT', body, expected })).inventory;
}
const history = async (id, user = a) => (await call('/api/v1/admin/inventory/' + id + '/history', { user })).events;
async function quoted(items, buyer = buyers[0]) {
  const { quote } = await post('/orders/quote', { items, address: 'gansu' }, buyer);
  return { quote, input: { items, address: 'gansu', expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: `INVENTORY-SMOKE-${randomUUID()}` } };
}
async function create(items, buyer = buyers[0]) {
  const { input } = await quoted(items, buyer);
  const result = await post('/orders', input, buyer, 201); orders.push(result.order.id); return result.order;
}

try {
  assert.equal((await call('/api/v1/session')).role, 'admin');
  await call('/api/v1/admin/inventory', { user: null, expected: 401 });
  await call('/api/v1/admin/inventory', { user: buyers[0], expected: 403 });
  await merchant(a, '景泰库存验收采购者（模拟）', '甘肃·景泰');
  await merchant(b, '定边库存验收采购者（模拟）', '陕西·定边');
  const pa = await product(a, `inventory-a-${suffix}`, '景泰库存验收苹果（本机模拟）');
  const pb = await product(b, `inventory-b-${suffix}`, '定边库存验收苹果（本机模拟）');
  const one = [{ productId: pa.id, variant: 'small', quantity: 1 }];
  const empty = await inventory(pa.id);
  assert.equal(empty.configured, false); assert.equal(empty.version, 0); assert.deepEqual(empty.stocks, { small: 0, family: 0 });
  await post('/orders/quote', { items: one, address: 'gansu' }, buyers[0], 409);
  const initial = await setInventory(pa.id, { stocks: { small: 1, family: 0 }, batchCode: `BATCH-A-${suffix}`, harvestDate: new Date().toISOString().slice(0, 10), note: '本机模拟采摘批次A，无真实供货信息。' });
  assert.equal(initial.configured, true); assert.equal(initial.version, 1); assert.ok(initial.batchId);
  await setInventory(pb.id, { stocks: { small: 2, family: 2 }, batchCode: `BATCH-B-${suffix}`, harvestDate: '', note: '其他商家的模拟批次。' }, b);
  assert.ok(!(await call('/api/v1/admin/inventory', { user: b })).inventories.some(value => value.productId === pa.id));
  await call('/api/v1/admin/inventory/' + pa.id, { user: b, method: 'PUT', body: { stocks: { small: 999, family: 999 }, batchCode: 'FORBIDDEN', harvestDate: '', note: '', reason: '禁止越权', expectedVersion: 1 }, expected: [403, 404] });
  await call('/api/v1/admin/inventory/' + pa.id + '/history', { user: b, expected: [403, 404] });
  const auditBefore = await history(pa.id);
  await setInventory(pa.id, { stocks: { small: 9, family: 9 } }, a, { version: 0, expected: 409 });
  assert.deepEqual(await history(pa.id), auditBefore, 'A failed version update must not append an event.');
  await setInventory(pa.id, { stocks: { small: -1, family: 0 } }, a, { expected: 400 });
  await setInventory(pa.id, { stocks: { small: 1000000, family: 0 } }, a, { expected: 400 });

  const publicStock = (await call('/api/v1/inventory', { user: null })).inventories.find(value => value.productId === pa.id);
  assert.equal(publicStock.batchCode, initial.batchCode); assert.deepEqual(publicStock.stocks, initial.stocks);
  const quotes = await Promise.all(buyers.map(buyer => quoted(one, buyer)));
  assert.equal(quotes[0].quote.items[0].batchId, initial.batchId);
  assert.equal(quotes[0].quote.items[0].batchCode, initial.batchCode);
  assert.equal(quotes[0].quote.items[0].batchNote, initial.note);
  assert.equal(quotes[0].quote.inventoryVersions[pa.id], initial.version);
  assert.equal((await inventory(pa.id)).stocks.small, 1, 'Reading quotes must not reserve stock.');
  const contested = await Promise.all(quotes.map(({ input }, index) => post('/orders', input, buyers[index], [201, 409], true)));
  assert.deepEqual(contested.map(value => value.status).sort(), [201, 409], 'Only one buyer may purchase the final unit.');
  const winner = contested.findIndex(value => value.status === 201), buyer = buyers[winner];
  let order = contested[winner].result.order; orders.push(order.id);
  assert.equal((await inventory(pa.id)).stocks.small, 0);
  const replayed = await post('/orders', quotes[winner].input, buyer);
  assert.equal(replayed.replayed, true); assert.equal(replayed.order.id, order.id);
  assert.equal((await inventory(pa.id)).stocks.small, 0, 'A replay must not reserve again.');
  await post('/orders/quote', { items: one, address: 'gansu' }, buyers[0], 409);
  const cancellations = await Promise.all([0, 1].map(() => post('/orders/' + order.id + '/cancel', { expectedVersion: order.version }, buyer, [200, 409], true)));
  assert.deepEqual(cancellations.map(value => value.status).sort(), [200, 409]);
  order = cancellations.find(value => value.status === 200).result.order;
  assert.equal(order.status, 'cancelled'); assert.equal(order.stockRelease.status, 'released');
  assert.equal((await inventory(pa.id)).stocks.small, 1, 'Concurrent cancellation must restore once.');
  const released = await history(pa.id);
  assert.equal(released.filter(value => value.action === 'reserved' && value.orderId === order.id).length, 1);
  assert.equal(released.filter(value => value.action === 'released' && value.orderId === order.id).length, 1);
  assert.equal((await post('/orders', quotes[winner].input, buyer)).order.status, 'cancelled');

  const oldBatchOrder = await create(one);
  const batchB = await setInventory(pa.id, { stocks: { small: 4, family: 2 }, batchCode: `BATCH-NEXT-${suffix}`, note: '本机模拟新批次，与旧单分开处理。' });
  assert.notEqual(batchB.batchId, initial.batchId);
  const reviewed = (await post('/orders/' + oldBatchOrder.id + '/cancel', { expectedVersion: oldBatchOrder.version }, buyers[0])).order;
  assert.equal(reviewed.status, 'cancelled'); assert.equal(reviewed.stockRelease.status, 'review');
  assert.deepEqual((await inventory(pa.id)).stocks, batchB.stocks, 'An old batch cancellation cannot replenish the new batch.');
  const persisted = (await call('/api/v1/orders/' + oldBatchOrder.id, { user: buyers[0] })).order;
  assert.equal(persisted.items[0].batchId, initial.batchId); assert.equal(persisted.items[0].batchCode, initial.batchCode);
  assert.ok((await history(pa.id)).some(value => value.action === 'release_review' && value.orderId === oldBatchOrder.id));

  const combined = await create([{ productId: pa.id, variant: 'small', quantity: 1 }, { productId: pa.id, variant: 'family', quantity: 2 }]);
  assert.equal(combined.items.length, 2);
  const beforeRefund = await inventory(pa.id);
  assert.deepEqual(beforeRefund.stocks, { small: 3, family: 0 });
  await post('/orders/quote', { items: [{ productId: pa.id, variant: 'small', quantity: 1 }, { productId: pa.id, variant: 'family', quantity: 1 }], address: 'gansu' }, buyers[0], 409);
  assert.deepEqual((await inventory(pa.id)).stocks, beforeRefund.stocks);
  let refund = (await post('/orders/' + combined.id + '/aftersale', { expectedVersion: combined.version, type: 'refund', reason: 'other', description: '本机模拟售后，不执行真实退款或自动补库存。', hasEvidence: false }, buyers[0])).order;
  refund = (await post('/admin/orders/' + combined.id + '/aftersale/resolve', { expectedVersion: refund.version, reply: '本机模拟处理完成，不自动回库。' }, a)).order;
  assert.equal(refund.afterSale.status, 'resolved'); assert.deepEqual((await inventory(pa.id)).stocks, beforeRefund.stocks);
  await updateMerchant(a, { permissions: ['orders', 'aftersales'] });
  await call('/api/v1/admin/inventory', { user: a, expected: 403 });
  await call('/api/v1/admin/inventory/' + pa.id + '/history', { user: a, expected: 403 });
  await updateMerchant(a, { status: 'disabled' });
  assert.ok(!(await call('/api/v1/inventory', { user: null })).inventories.some(value => value.productId === pa.id));
  await post('/orders/quote', { items: one, address: 'gansu' }, buyers[0], 409);
  assert.equal((await call('/api/v1/admin/orders/' + combined.id)).order.afterSale.status, 'resolved');
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', checks, merchantsCreated: profiles.size, ordersCreated: orders.length, message: error.message }));
  process.exitCode = 1;
} finally {
  // Keep histories for inspection while removing local mock products from sale.
  for (const [id] of profiles) {
    try { await updateMerchant({ id }, { status: 'disabled' }); }
    catch { console.error('A local inventory mock merchant could not be disabled.'); process.exitCode = 1; }
  }
}
if (!process.exitCode) console.log(JSON.stringify({ result: 'PASS', checks, merchants: profiles.size, simulatedOrders: orders.length, simulated: true, payment: false, realShipment: false }));
