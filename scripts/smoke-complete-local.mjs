#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BASE_CATALOG } from '../public/model.js';

// These mock trusted headers are exclusively for the local Worker. Refuse
// remote origins, non-root URLs, credentials and redirects before every run.
let base;
try {
  base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.username + base.password + base.search + base.hash, '');
  assert.equal(base.pathname, '/');
} catch {
  console.error('Complete smoke test requires an HTTP loopback root URL, without credentials or redirects.');
  process.exit(1);
}

const suffix = randomUUID().slice(0, 8);
const admin = { id: process.env.SMOKE_ADMIN_ID || 'local_seedy', email: process.env.SMOKE_ADMIN_EMAIL || 'seedy@sites.test' };
const merchantA = { id: `complete-merchant-a-${suffix}`, email: `complete-merchant-a-${suffix}@example.test` };
const merchantB = { id: `complete-merchant-b-${suffix}`, email: `complete-merchant-b-${suffix}@example.test` };
const buyerA = { id: `complete-buyer-a-${suffix}`, email: `complete-buyer-a-${suffix}@example.test` };
const buyerB = { id: `complete-buyer-b-${suffix}`, email: `complete-buyer-b-${suffix}@example.test` };
const permissions = ['products', 'orders', 'aftersales'];
const profiles = new Map(), products = new Map(), orders = [];
let checks = 0, uploadedMedia;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function headersFor(user) {
  return user ? { 'oai-authenticated-user-id': user.id, 'oai-authenticated-user-email': user.email } : {};
}
async function call(path, { user = admin, method = 'GET', body, raw = false, headers: extraHeaders = {}, origin = base.origin, expected = 200 } = {}) {
  assert.ok(path.startsWith('/api/v1/'));
  const headers = { Accept: 'application/json', ...headersFor(user), ...extraHeaders };
  if (method !== 'GET' && method !== 'HEAD') headers.Origin = origin;
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  const response = await fetch(base.origin + path, { method, headers,
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(15000) });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`${method} ${path}: response was not JSON`); }
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}; code=${result?.error?.code || 'none'}`);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  checks++;
  return result;
}
const post = (path, body, user = admin, expected = 200) => call('/api/v1' + path, { method: 'POST', body, user, expected });
const readShopping = (user = buyerA) => call('/api/v1/me/shopping', { user });
const putShopping = (state, expectedVersion, user = buyerA, extra = {}) => call('/api/v1/me/shopping', { method: 'PUT', user, body: { state, expectedVersion }, ...extra });
const readOrder = (id, user = buyerA) => call('/api/v1/orders/' + id, { user });
const readInventory = async (id, user = merchantA) => {
  const value = (await call('/api/v1/admin/inventory', { user })).inventories.find(item => item.productId === id);
  assert.ok(value); return value;
};

async function createMerchant(user, name) {
  const { merchant } = await post('/admin/merchants', { name, email: user.email, region: '甘肃 · 景泰（本机模拟）', status: 'enabled', permissions }, admin, 201);
  profiles.set(user.id, merchant);
  assert.equal(merchant.bound, false);
  const session = await call('/api/v1/session', { user });
  assert.equal(session.role, 'merchant');
  assert.equal(session.canManage, true);
  assert.deepEqual([...session.permissions].sort(), [...permissions].sort());
  const bound = (await call('/api/v1/admin/merchants/' + merchant.id)).merchant;
  assert.equal(bound.bound, true);
  profiles.set(user.id, bound);
}

async function saveProduct(user, product) {
  const previous = products.get(product.id);
  const { product: saved } = await call('/api/v1/admin/products/' + product.id, {
    user, method: 'PUT', body: { product, expectedVersion: previous?.version || 0 }
  });
  products.set(saved.id, saved);
  return saved;
}
async function newProduct(user, id, name, status = 'published') {
  return saveProduct(user, { ...structuredClone(BASE_CATALOG[0]), id, name, status, origin: '甘肃 · 景泰（完整验收模拟产地）' });
}
async function setInventory(id, user) {
  const current = await readInventory(id, user);
  assert.deepEqual(current.stocks, { small: 0, family: 0 });
  return (await call('/api/v1/admin/inventory/' + id, { user, method: 'PUT', body: {
    expectedVersion: current.version, stocks: { small: 10, family: 8 }, batchCode: `COMPLETE-${suffix}-${id.slice(-2)}`,
    harvestDate: new Date().toISOString().slice(0, 10), note: '完整流程本机验收模拟批次，无真实供货。', reason: '配置本机完整流程模拟库存'
  } })).inventory;
}
async function mediaRead(id, expected, bytes) {
  assert.match(id, /^CLOUD-[a-f0-9-]+$/i);
  const response = await fetch(base.origin + '/api/v1/media/' + id, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  if (bytes) {
    assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(bytes), 'Bound cloud media must return the uploaded bytes.');
  } else await response.arrayBuffer();
  checks++;
}

try {
  assert.equal((await call('/api/v1/session')).role, 'admin');
  await createMerchant(merchantA, '完整验收景泰采购者甲（模拟）');
  await createMerchant(merchantB, '完整验收景泰采购者乙（模拟）');
  let apple = await newProduct(merchantA, `complete-apple-${suffix}`, '完整验收苹果（模拟）', 'draft');
  const pear = await newProduct(merchantA, `complete-pear-${suffix}`, '完整验收鲜梨（模拟）');
  const other = await newProduct(merchantB, `complete-other-${suffix}`, '其他店验收苹果（模拟）');
  const imageBytes = await readFile(new URL('../public/assets/apples.jpg', import.meta.url));
  uploadedMedia = await call('/api/v1/media?kind=image', { user: merchantA, method: 'POST', raw: true, body: imageBytes, expected: 201, headers: {
    'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent(`complete-apple-${suffix}.jpg`),
    'X-Media-Source': encodeURIComponent('本机流程验收：仓库内置苹果示意照片；原来源与授权见 public/assets/credits.json，不代表真实货源。')
  } });
  assert.equal(uploadedMedia.kind, 'image');
  assert.equal(uploadedMedia.size, imageBytes.byteLength);
  await mediaRead(uploadedMedia.id, 404);
  apple = await saveProduct(merchantA, { ...apple, imageMediaId: uploadedMedia.id, status: 'published' });
  await mediaRead(uploadedMedia.id, 200, imageBytes);
  await call('/api/v1/admin/products/' + apple.id, { user: merchantB, method: 'PUT', expected: 403,
    body: { product: apple, expectedVersion: apple.version } });
  await setInventory(apple.id, merchantA);
  await setInventory(pear.id, merchantA);
  await setInventory(other.id, merchantB);

  const directory = await call('/api/v1/storefront', { user: null });
  const shop = directory.shops.find(item => item.productIds.includes(apple.id));
  const otherShop = directory.shops.find(item => item.productIds.includes(other.id));
  assert.ok(shop && otherShop);
  assert.equal(shop.name, '完整验收景泰采购者甲（模拟）');
  assert.deepEqual([...shop.productIds].sort(), [apple.id, pear.id].sort());
  assert.notEqual(shop.id, otherShop.id);
  for (const identity of [merchantA, merchantB, buyerA, buyerB]) {
    assert.ok(!JSON.stringify(directory).includes(identity.id));
    assert.ok(!JSON.stringify(directory).includes(identity.email));
  }
  const initial = await readShopping();
  assert.deepEqual(initial, { state: { cart: [], favorites: [], recent: [], preferredAddress: 'gansu' }, version: 0, updatedAt: null });
  await call('/api/v1/me/shopping', { user: null, expected: 401 });
  const state = {
    cart: [
      { productId: apple.id, variant: 'small', quantity: 3, selected: true },
      { productId: apple.id, variant: 'family', quantity: 2, selected: false },
      { productId: pear.id, variant: 'small', quantity: 1, selected: true },
      { productId: other.id, variant: 'small', quantity: 2, selected: false }
    ], favorites: [apple.id, pear.id], recent: [pear.id, apple.id], preferredAddress: 'shaanxi'
  };
  let shopping = await putShopping(state, 0);
  assert.equal(shopping.version, 1);
  assert.deepEqual((await readShopping({ ...buyerA })).state, state, 'A separate client with the same identity must see cloud shopping data.');
  assert.deepEqual((await readShopping(buyerB)).state, initial.state);
  await putShopping({ ...state, preferredAddress: 'gansu' }, 0, buyerA, { expected: 409 });
  await call('/api/v1/me/shopping', { user: buyerA, method: 'PUT', expected: 400, body: { expectedVersion: 1, state, userId: buyerB.id } });
  await putShopping(state, 1, buyerA, { expected: 403, origin: 'https://other.example.test' });
  assert.deepEqual(await readShopping(), shopping, 'Rejected shopping writes must not change any saved fields.');

  const items = [{ productId: apple.id, variant: 'small', quantity: 1 }, { productId: pear.id, variant: 'small', quantity: 1 }];
  await post('/orders/quote', { items: [...items, { productId: other.id, variant: 'small', quantity: 1 }], address: 'shaanxi' }, buyerA, 422);
  const { quote } = await post('/orders/quote', { items, address: 'shaanxi' }, buyerA);
  const input = { items, address: 'shaanxi', expectedTotal: quote.total, productVersions: quote.productVersions,
    inventoryVersions: quote.inventoryVersions, idempotencyKey: `COMPLETE-${randomUUID()}` };
  let { order } = await post('/orders', input, buyerA, 201);
  orders.push(order.id);
  assert.equal(order.version, 1);
  assert.equal(order.items.length, 2);
  assert.equal(order.shipping, 1000);
  const afterStock = [await readInventory(apple.id), await readInventory(pear.id)];
  assert.deepEqual(afterStock.map(value => value.stocks), [{ small: 9, family: 8 }, { small: 9, family: 8 }]);
  const replay = await post('/orders', input, buyerA);
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.id, order.id);
  assert.deepEqual([await readInventory(apple.id), await readInventory(pear.id)], afterStock, 'An idempotent order retry must not deduct stock twice.');
  await call('/api/v1/orders/' + order.id, { user: buyerB, expected: 404 });
  await post('/me/shopping/consume-order', { orderId: order.id, expectedVersion: 0 }, buyerB, 404);
  await post('/me/shopping/consume-order', { orderId: order.id, expectedVersion: 0 }, buyerA, 409);
  shopping = await post('/me/shopping/consume-order', { orderId: order.id, expectedVersion: shopping.version }, buyerA);
  const expectedCart = [
    { ...state.cart[0], quantity: 2 }, state.cart[1], state.cart[3]
  ];
  assert.deepEqual(shopping.state.cart, expectedCart);
  assert.deepEqual(shopping.state.favorites, state.favorites);
  assert.deepEqual(shopping.state.recent, state.recent);
  assert.equal(shopping.state.preferredAddress, 'shaanxi');
  assert.equal(shopping.consumed, true);
  const consumedAgain = await post('/me/shopping/consume-order', { orderId: order.id, expectedVersion: 1 }, buyerA);
  assert.deepEqual(consumedAgain, shopping, 'Consuming the same order twice must preserve quantities, state version and sync time.');
  assert.deepEqual((await readShopping({ ...buyerA })).state.cart, expectedCart);
  assert.deepEqual((await readShopping(buyerB)).state, initial.state);

  await post('/orders/' + order.id + '/receive', { expectedVersion: order.version }, buyerA, 409);
  await post('/admin/orders/' + order.id + '/ship', { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-FORBIDDEN' }, merchantB, 404);
  order = (await post('/admin/orders/' + order.id + '/ship', { expectedVersion: order.version, carrier: '完整验收模拟物流', tracking: `DEMO-COMPLETE-${suffix.toUpperCase()}` }, merchantA)).order;
  assert.equal(order.fulfillment.status, 'shipped');
  await post('/orders/' + order.id + '/receive', { expectedVersion: order.version }, buyerB, 404);
  await post('/orders/' + order.id + '/receive', { expectedVersion: order.version }, merchantA, 404);
  await post('/admin/orders/' + order.id + '/receive', { expectedVersion: order.version }, admin, 404);
  await post('/orders/' + order.id + '/receive', { expectedVersion: 1 }, buyerA, 409);
  order = (await post('/orders/' + order.id + '/receive', { expectedVersion: order.version }, buyerA)).order;
  assert.equal(order.receipt.status, 'received');
  assert.ok(Date.parse(order.receipt.receivedAt) >= Date.parse(order.fulfillment.shippedAt));
  const received = structuredClone(order);
  assert.deepEqual((await readOrder(order.id, { ...buyerA })).order, order);
  await post('/orders/' + order.id + '/receive', { expectedVersion: order.version }, buyerA, 409);
  assert.deepEqual((await readOrder(order.id)).order, received);
  await post('/orders/' + order.id + '/cancel', { expectedVersion: order.version }, buyerA, 409);
  await post('/admin/orders/' + order.id + '/ship', { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-AGAIN' }, merchantA, 409);
  order = (await post('/orders/' + order.id + '/aftersale', { expectedVersion: order.version, type: 'refund', reason: 'damaged',
    description: '本机完整流程模拟售后，无真实客户或收货资料。', hasEvidence: false }, buyerA)).order;
  assert.equal(order.afterSale.status, 'submitted');
  await post('/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: order.version, reply: '禁止跨店处理' }, merchantB, 404);
  await post('/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: 1, reply: '过期版本不可覆盖' }, merchantA, 409);
  order = (await post('/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: order.version, reply: '本机完整流程模拟处理完成，实际退款0元。' }, merchantA)).order;
  const resolved = (await readOrder(order.id, { ...buyerA })).order;
  assert.equal(resolved.afterSale.status, 'resolved');
  assert.equal(resolved.afterSale.merchantReply, '本机完整流程模拟处理完成，实际退款0元。');
  assert.deepEqual(resolved.receipt, received.receipt);
  assert.deepEqual(resolved.afterSaleHistory.map(value => value.status), ['submitted', 'resolved']);
  assert.deepEqual([await readInventory(apple.id), await readInventory(pear.id)], afterStock, 'Shipping, receipt and after-sale resolution must not automatically change stock.');
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', checks, merchantsCreated: profiles.size, productsCreated: products.size, simulatedOrders: orders.length, message: error.message }));
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  for (const product of products.values()) {
    try { if (product.status !== 'offline') await saveProduct(admin, { ...product, status: 'offline' }); }
    catch { cleanupFailed = true; }
  }
  for (const profile of profiles.values()) {
    try {
      const { merchant } = await call('/api/v1/admin/merchants/' + profile.id);
      await call('/api/v1/admin/merchants/' + profile.id, { method: 'PUT', body: {
        name: merchant.name, email: merchant.email, region: merchant.region, status: 'disabled', permissions: merchant.permissions, expectedVersion: merchant.version
      } });
    } catch { cleanupFailed = true; }
  }
  if (uploadedMedia) {
    try { await mediaRead(uploadedMedia.id, 404); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) {
    console.error('Some local complete-flow fixtures could not be taken offline; inspect the local database before reusing it.');
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(JSON.stringify({ result: 'PASS', checks, merchants: profiles.size, products: products.size, simulatedOrders: orders.length,
  uploadedImage: !!uploadedMedia, shoppingSync: true, receipt: true, simulated: true, payment: false, realShipment: false }));
