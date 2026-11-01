import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createMarket } = require('../miniprogram/services/market.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const MOCK_KEY = 'longshang-native-mock-v1';
const API = 'https://mini.example.test';
const AUTH_KEY = 'longshang-native-auth:' + API;
const tokenA = 'wxs_' + 'a'.repeat(64), tokenB = 'wxs_' + 'b'.repeat(64);
const expiresAt = () => new Date(Date.now() + 3600000).toISOString();
const selected = [{ productId: 'jingtai-apple', variant: 'small', quantity: 2 }];
const reply = (options, data, statusCode = 200) => options.success({ data, statusCode });
function device() {
  const storage = new Map(), requests = [];
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => { if (wx.failWrites) throw new Error('storage unavailable'); storage.set(key, clone(value)); },
    removeStorageSync: key => storage.delete(key),
    request: options => { requests.push(options); if (wx.onRequest) wx.onRequest(options); else options.fail({ errMsg: 'network unavailable' }); },
    login: options => options.success({ code: 'wx-login-code-not-an-openid' })
  };
  return { wx, storage, requests };
}
function mock() { const deviceState = device(); return { ...deviceState, market: createMarket(deviceState.wx, { mode: 'mock' }) }; }
function cloud({ authenticated = false } = {}) {
  const state = device();
  if (authenticated) state.storage.set(AUTH_KEY, { token: tokenA, expiresAt: expiresAt() });
  return { ...state, market: createMarket(state.wx, { mode: 'cloud', apiBase: API }) };
}
async function payload(market, overrides = {}) {
  const items = overrides.items || selected, address = overrides.address || 'gansu';
  const { quote } = await market.quote(items, address);
  return { items, address, expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: market.newRequestKey(), ...overrides };
}

test('native package supplies missing JavaScriptCore built-ins before loading its shared model', () => {
  const context = vm.createContext({});
  vm.runInContext('delete Object.fromEntries; delete Object.hasOwn; delete Array.prototype.flatMap;', context);
  vm.runInContext(readFileSync(new URL('../miniprogram/services/compat.js', import.meta.url), 'utf8'), context);
  assert.equal(vm.runInContext("Object.fromEntries([['first',1],['second',2]]).second", context), 2);
  assert.equal(vm.runInContext("Object.hasOwn(Object.create({inherited:true}), 'inherited')", context), false);
  assert.equal(vm.runInContext("Object.hasOwn(Object.fromEntries([['__proto__',3]]),'__proto__')", context), true);
  assert.equal(vm.runInContext("[1,,3].flatMap(value=>[value,value+1]).join(',')", context), '1,2,3,4');
  vm.runInContext('var previous=Object.fromEntries;', context);
  vm.runInContext(readFileSync(new URL('../miniprogram/services/compat.js', import.meta.url), 'utf8'), context);
  assert.equal(vm.runInContext('previous===Object.fromEntries', context), true);
  const generated = readFileSync(new URL('../miniprogram/services/generated/model.js', import.meta.url), 'utf8');
  vm.runInContext('var module={exports:{}}; var exports=module.exports;', context);
  vm.runInContext(generated, context);
  assert.equal(vm.runInContext('module.exports.BASE_CATALOG.length', context), 6);
  assert.equal(vm.runInContext("module.exports.validOrderReceipt({status:'created',createdAt:'2026-11-01T00:00:00.000Z',fulfillment:{status:'shipped',shippedAt:'2026-11-01T00:00:00.000Z'},receipt:{status:'received',receivedAt:'2026-11-01T00:00:00.000Z'}})", context), true);
});

test('native mock inventory seeds once per device and never resets used stock on reload', async () => {
  const { wx, market } = mock();
  const catalog = await market.getCatalog(); assert.equal(catalog.products.length, 6);
  let stocks = (await market.getInventory()).inventories;
  assert.ok(stocks.every(row => row.stocks.small === 20 && row.stocks.family === 12));
  await market.createOrder(await payload(market));
  const reopened = createMarket(wx, { mode: 'mock' });
  stocks = (await reopened.getInventory()).inventories;
  assert.equal(stocks.find(row => row.productId === 'jingtai-apple').stocks.small, 18);
  assert.equal((await reopened.listOrders()).orders.length, 1);
  assert.equal((await reopened.getSession()).authProvider, 'mock');
});

test('native mock uses idempotent orders, versioned quotes and stock checks', async () => {
  const { market } = mock();
  const firstRequest = await payload(market), oldQuote = await payload(market);
  const first = await market.createOrder(firstRequest);
  assert.equal(first.replayed, false);
  assert.equal((await market.createOrder(firstRequest)).replayed, true);
  await assert.rejects(market.createOrder({ ...firstRequest, expectedTotal: 1 }), { code: 'idempotency_conflict' });
  await assert.rejects(market.createOrder(oldQuote), { code: 'quote_changed' });
  assert.equal((await market.listOrders()).orders.length, 1);
  assert.equal((await market.getInventory()).inventories.find(row => row.productId === 'jingtai-apple').stocks.small, 18);
  for (const invalid of [[{ ...selected[0], quantity: 0 }], [{ ...selected[0], quantity: 11 }], [selected[0], selected[0]]]) await assert.rejects(market.quote(invalid, 'gansu'));
  await assert.rejects(market.quote(selected, 'other'));
  for (let index = 0; index < 2; index++) await market.createOrder(await payload(market, { items: [{ ...selected[0], quantity: index ? 8 : 10 }] }));
  assert.equal((await market.getInventory()).inventories.find(row => row.productId === 'jingtai-apple').stocks.small, 0);
  await assert.rejects(market.quote(selected, 'gansu'), { code: 'stock_insufficient' });
});

test('native mock completes ship, receipt and after-sale without replenishing inventory', async () => {
  const { market } = mock();
  let { order } = await market.createOrder(await payload(market));
  const inventory = (await market.getInventory()).inventories;
  await assert.rejects(market.receiveOrder(order.id, order.version));
  order = (await market.mockShipOrder(order.id, order.version)).order;
  assert.equal(order.fulfillment.status, 'shipped');
  await assert.rejects(market.mockShipOrder(order.id, order.version));
  order = (await market.receiveOrder(order.id, order.version)).order;
  assert.equal(order.receipt.status, 'received');
  await assert.rejects(market.receiveOrder(order.id, order.version));
  order = (await market.createAfterSale(order.id, { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '模拟外箱问题', hasEvidence: false })).order;
  assert.equal(order.afterSale.status, 'submitted');
  order = (await market.mockResolveAfterSale(order.id, order.version, '已完成模拟处理，无真实退款。')).order;
  assert.equal(order.afterSale.status, 'resolved');
  assert.equal(order.afterSaleHistory.length, 2);
  assert.deepEqual((await market.getInventory()).inventories, inventory);
});

test('native mock cancellation restocks original batches once; a changed batch makes the entire order review', async () => {
  const { market, storage } = mock();
  let { order } = await market.createOrder(await payload(market));
  order = (await market.cancelOrder(order.id, order.version)).order;
  assert.equal(order.inventoryRelease.status, 'released');
  await assert.rejects(market.cancelOrder(order.id, order.version));
  assert.equal((await market.getInventory()).inventories.find(row => row.productId === 'jingtai-apple').stocks.small, 20);
  const items = [...selected, { productId: 'pear', variant: 'family', quantity: 1 }];
  order = (await market.createOrder(await payload(market, { items }))).order;
  const saved = storage.get(MOCK_KEY); saved.inventories.pear.batchId = 'BATCH-NEW'; storage.set(MOCK_KEY, saved);
  const before = (await market.getInventory()).inventories;
  order = (await market.cancelOrder(order.id, order.version)).order;
  assert.equal(order.inventoryRelease.status, 'review');
  assert.deepEqual((await market.getInventory()).inventories, before);
});

test('native mock storage failures do not report a successful order or partially deduct inventory', async () => {
  const { market, wx, storage } = mock();
  const request = await payload(market), before = clone(storage.get(MOCK_KEY));
  wx.failWrites = true;
  await assert.rejects(market.createOrder(request), /storage unavailable/);
  assert.deepEqual(storage.get(MOCK_KEY), before);
});

test('native shopping versions and consumed-order markers preserve unselected cart rows across reload', async () => {
  const { market, wx } = mock();
  const state = { cart: [{ ...selected[0], quantity: 4, selected: true }, { productId: 'pear', variant: 'family', quantity: 2, selected: false }], favorites: ['pear'], recent: ['jingtai-apple'], preferredAddress: 'gansu' };
  const shopping = await market.updateShopping(state, 0);
  await assert.rejects(market.updateShopping(state, 0), { code: 'version_conflict' });
  const { order } = await market.createOrder(await payload(market));
  const consumed = await market.consumeOrder(order.id, shopping.version);
  assert.equal(consumed.state.cart[0].quantity, 2); assert.equal(consumed.state.cart[1].quantity, 2);
  const reopened = createMarket(wx, { mode: 'mock' });
  assert.deepEqual(await reopened.consumeOrder(order.id, 0), consumed);
  assert.deepEqual((await reopened.getShopping()).state, consumed.state);
});

test('corrupt native mock storage fails explicitly instead of refilling stock', async () => {
  const { market, storage } = mock(); storage.set(MOCK_KEY, { schema: 99 });
  await assert.rejects(market.getInventory(), { code: 'mock_data_invalid' });
  assert.deepEqual(storage.get(MOCK_KEY), { schema: 99 });
});

test('cloud configuration refuses the private demonstration Site and credential-bearing or non-HTTPS URLs', () => {
  const { wx } = device();
  for (const apiBase of ['', 'http://api.example.test', 'https://api.example.test/path', 'https://user:pass@api.example.test', 'https://api.example.test?key=x', 'https://jingtai.demo.chatgpt.site', 'https://localhost']) assert.throws(() => createMarket(wx, { mode: 'cloud', apiBase }), { code: 'api_config_invalid' });
});

test('native cloud login exchanges wx.login code and stores only opaque session data', async () => {
  const { market, wx, storage, requests } = cloud();
  wx.onRequest = options => {
    assert.equal(options.url, API + '/api/v1/auth/wechat/login');
    assert.deepEqual(options.data, { code: 'wx-login-code-not-an-openid' });
    assert.equal(options.header.Authorization, undefined);
    reply(options, { token: tokenA, expiresAt: expiresAt(), session: { user: { id: 'opaque-user', name: '微信买家' }, role: 'buyer', permissions: [], canManage: false } });
  };
  const result = await market.login(); assert.equal(result.session.user.id, 'opaque-user');
  assert.deepEqual(Object.keys(storage.get(AUTH_KEY)).sort(), ['expiresAt','token']);
  assert.equal(requests.length, 1);
  assert.equal(storage.has(MOCK_KEY), false);
  wx.onRequest = options => { assert.equal(options.header.Authorization, 'Bearer ' + tokenA); reply(options, { user: { id: 'opaque-user' }, permissions: [], canManage: false }); };
  await market.getSession();
  assert.equal(requests.some(row => Object.keys(row.header).some(key => key.startsWith('oai-authenticated'))), false);
});

test('cloud network failures never fall back to mock data or create local orders', async () => {
  const { market, storage } = cloud({ authenticated: true });
  await assert.rejects(market.getCatalog(), { code: 'network_error' });
  await assert.rejects(market.createOrder({}), { code: 'network_error' });
  assert.equal(storage.has(MOCK_KEY), false);
});

test('stale account responses cannot clear a new login or return old shopping records', async () => {
  const { market, wx, storage } = cloud({ authenticated: true });
  let oldRequest;
  wx.onRequest = options => {
    if (options.url.endsWith('/me/shopping')) oldRequest = options;
    else reply(options, { token: tokenB, expiresAt: expiresAt(), session: { user: { id: 'buyer-b' }, role: 'buyer', permissions: [], canManage: false } });
  };
  const pending = market.getShopping();
  await market.login();
  reply(oldRequest, { error: { code: 'sign_in_required', message: '过期' } }, 401);
  await assert.rejects(pending, { code: 'stale_session' });
  assert.equal(storage.get(AUTH_KEY).token, tokenB);
});

test('expired sessions are cleared and cloud mock management operations are rejected', async () => {
  const state = device(); state.storage.set(AUTH_KEY, { token: tokenA, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const market = createMarket(state.wx, { mode: 'cloud', apiBase: API });
  assert.equal(state.storage.has(AUTH_KEY), false);
  assert.equal((await market.getSession()).user, null);
  await assert.rejects(market.getShopping(), { code: 'sign_in_required' });
  await assert.rejects(market.mockShipOrder('id', 1), { code: 'mock_only' });
  await assert.rejects(market.mockResolveAfterSale('id', 1, ''), { code: 'mock_only' });
  assert.equal(state.requests.length, 0);
});

test('an authentication error still settles when the device cannot erase its stale token', async () => {
  const { market, wx } = cloud({ authenticated: true });
  wx.removeStorageSync = () => { throw new Error('storage is unavailable'); };
  wx.onRequest = options => reply(options, { error: { code: 'sign_in_required', message: '请重新登录。' } }, 401);
  await assert.rejects(market.getShopping(), { code: 'sign_in_required' });
  assert.equal((await market.getSession()).user, null);
});

test('native cloud order list follows cursor pages and rejects pagination loops', async () => {
  const { market, wx, requests } = cloud({ authenticated: true });
  wx.onRequest = options => options.url.includes('?cursor=') ? reply(options, { orders: [{ id: 'second' }], nextCursor: null }) : reply(options, { orders: [{ id: 'first' }], nextCursor: 'page_2' });
  assert.deepEqual((await market.listOrders()).orders.map(row => row.id), ['first','second']);
  assert.equal(requests[1].url, API + '/api/v1/orders?cursor=page_2');
  wx.onRequest = options => reply(options, { orders: [], nextCursor: 'page_2' });
  await assert.rejects(market.listOrders(), { code: 'cursor_invalid' });
});

test('media URLs remain local or bound to the configured API; no arbitrary remote video is invented', () => {
  const { market } = cloud();
  assert.equal(market.assetUrl('assets/apples.jpg'), '/assets/apples.jpg');
  assert.equal(market.assetUrl('assets/apple-orchard.jpg'), '/assets/apples.jpg');
  const media = 'CLOUD-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert.equal(market.videoFor({ videoMediaId: media }), API + '/api/v1/media/' + media);
  assert.equal(market.videoFor({ video: 'https://other.example/video.mp4' }), '');
  assert.equal(market.assetUrl('https://other.example/image.jpg'), '');
  assert.equal(market.assetUrl('javascript:alert(1)'), '');
});
