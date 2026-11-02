import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MemoryCloudbaseDB } from './fixtures/cloudbase-db.mjs';

const require = createRequire(import.meta.url);
const { createMarket } = require('../miniprogram/services/market.js');
const model = require('../miniprogram/services/generated/model.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const APP = 'wx0123456789abcdef', ENV = 'cloud1-native-test', FUNCTION = 'market';
const MOCK_KEY = 'longshang-native-mock-v1';
const expiry = () => new Date(Date.now() + 3600000).toISOString();
const flush = () => new Promise(resolve => setImmediate(resolve));
const settings = extra => ({ mode: 'cloud', transport: 'cloudbase', cloudEnv: ENV, cloudFunction: FUNCTION, ...extra });
const authKey = (environment = ENV, name = FUNCTION) => 'longshang-native-auth:cloudbase:' + environment + ':' + name;
function runtime() {
  const storage = new Map(), calls = [], initializations = [];
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync(key, value) { if (wx.failStorage) throw new Error('Test storage failure'); storage.set(key, clone(value)); },
    removeStorageSync(key) { if (wx.failRemove) throw new Error('Test storage failure'); storage.delete(key); },
    login() { throw new Error('CloudBase must not call wx.login'); },
    request() { throw new Error('CloudBase must not use HTTP'); },
    cloud: {
      init(options) { initializations.push(clone(options)); return wx.onInit?.(options); },
      callFunction(options) { calls.push({ name: options.name, config: clone(options.config), data: clone(options.data) }); return wx.onCloud?.(options); }
    }
  };
  return { wx, storage, calls, initializations };
}
const session = (id, extra = {}) => ({ user: { id, name: '模拟微信用户', email: '' }, role: 'buyer', permissions: [], canManage: false, merchant: null, authProvider: 'cloudbase', ...extra });
const reply = (options, body, status = 200) => options.success({ result: { status, body: clone(body) } });

test('CloudBase requires an exact environment and native SDK; it never guesses HTTP or a mock fallback', async () => {
  for (const cloudEnv of [undefined, '', '填写环境编号', 'https://api.example.test', 'your-env-id', '../prod']) {
    const f = runtime(); assert.throws(() => createMarket(f.wx, settings({ cloudEnv })), { code: 'cloud_config_invalid' });
    assert.equal(f.initializations.length, 0); assert.equal(f.storage.has(MOCK_KEY), false);
  }
  const f = runtime(); delete f.wx.cloud;
  assert.throws(() => createMarket(f.wx, settings()), { code: 'cloud_runtime_missing' });
  assert.throws(() => createMarket(runtime().wx, settings({ cloudFunction: '../function' })), { code: 'cloud_config_invalid' });
  const configured = runtime(); const market = createMarket(configured.wx, settings());
  assert.equal(market.mode, 'cloud'); assert.equal(market.transport, 'cloudbase'); assert.equal(market.storageNamespace, 'cloudbase:' + ENV + ':' + FUNCTION);
  assert.deepEqual(configured.initializations, [{ env: ENV }]);
});

test('CloudBase public browsing and explicit login only transmit the documented event contract', async () => {
  const f = runtime(), id = 'wechat:' + 'a'.repeat(64), token = 'wxs_' + 'a'.repeat(64);
  const market = createMarket(f.wx, settings());
  f.wx.onCloud = options => {
    assert.equal(options.name, FUNCTION); assert.deepEqual(options.config, { env: ENV });
    if (options.data.path === '/api/v1/products') return reply(options, { products: [] });
    if (options.data.path === '/api/v1/auth/wechat/login') return reply(options, { token, expiresAt: expiry(), session: session(id) });
    if (options.data.path === '/api/v1/session') return reply(options, session(id));
    if (options.data.path === '/api/v1/me/shopping') return reply(options, { state: { cart: [], favorites: [], recent: [], preferredAddress: 'gansu' }, version: 0 });
    throw new Error('Unexpected path');
  };
  assert.equal((await market.getSession()).user, null);
  await market.getCatalog();
  await assert.rejects(market.getShopping(), { code: 'sign_in_required' });
  assert.equal(f.calls.length, 1);
  await market.login();
  assert.equal((await market.getSession()).user.id, id); await market.getShopping();
  assert.deepEqual(f.calls.find(row => row.data.path === '/api/v1/auth/wechat/login').data, { path: '/api/v1/auth/wechat/login', method: 'POST', body: {} });
  const personal = f.calls.find(row => row.data.path === '/api/v1/me/shopping').data;
  assert.deepEqual(personal, { path: '/api/v1/me/shopping', method: 'GET', sessionToken: token, expectedUserId: id });
  for (const row of f.calls) {
    assert.ok(Object.keys(row.data).every(key => ['path', 'method', 'body', 'sessionToken', 'expectedUserId'].includes(key)));
    for (const forbidden of ['openid', 'OPENID', 'role', 'AppSecret', 'session_key', 'Authorization']) assert.equal(Object.prototype.hasOwnProperty.call(row.data, forbidden), false);
  }
  assert.equal(f.storage.has(MOCK_KEY), false);
  assert.deepEqual(Object.keys(f.storage.get(authKey())).sort(), ['expiresAt', 'token', 'userId']);
});

test('CloudBase invalid environment, failed/malformed calls and server errors remain explicit without local orders', async () => {
  const asyncInit = runtime(); asyncInit.wx.onInit = () => Promise.reject(new Error('Environment does not exist'));
  await assert.rejects(createMarket(asyncInit.wx, settings()).getCatalog(), { code: 'cloud_init_failed' });
  const f = runtime(), market = createMarket(f.wx, settings());
  f.wx.onCloud = options => options.fail({ errMsg: 'Environment does not exist', secret: 'do-not-surface-provider-details' });
  await assert.rejects(market.getCatalog(), { code: 'network_error' });
  f.wx.onCloud = () => Promise.reject(new Error('Provider failure'));
  await assert.rejects(market.getCatalog(), { code: 'network_error' });
  f.wx.onCloud = options => options.success({ result: { status: '200', body: {} } });
  await assert.rejects(market.getCatalog(), { code: 'response_invalid' });
  f.wx.onCloud = options => reply(options, { error: { code: 'cloudbase_unconfigured', message: '环境尚未配置。' } }, 503);
  await assert.rejects(market.getCatalog(), { code: 'cloudbase_unconfigured', status: 503 });
  // Some SDK wrappers return Promise<void> while delivering data through the
  // supplied success callback. That empty Promise is not a server response.
  f.wx.onCloud = options => { setImmediate(() => reply(options, { products: [] })); return Promise.resolve(undefined); };
  assert.deepEqual((await market.getCatalog()).products, []);
  assert.equal(f.storage.has(MOCK_KEY), false);
  assert.equal([...f.storage.keys()].some(key => /shopping|orders/.test(key)), false);
});

test('CloudBase sessions and pending-record namespaces cannot cross environments or functions', async () => {
  const f = runtime(), id = 'wechat:' + 'a'.repeat(64), token = 'wxs_' + 'a'.repeat(64);
  f.storage.set(authKey(), { userId: id, token, expiresAt: expiry() });
  const original = createMarket(f.wx, settings());
  const otherEnv = createMarket(f.wx, settings({ cloudEnv: 'cloud2-other-test' }));
  const otherFunction = createMarket(f.wx, settings({ cloudFunction: 'other-market' }));
  assert.notEqual(original.storageNamespace, otherEnv.storageNamespace); assert.notEqual(original.storageNamespace, otherFunction.storageNamespace);
  assert.equal((await otherEnv.getSession()).user, null); assert.equal((await otherFunction.getSession()).user, null);
  await assert.rejects(otherEnv.getShopping(), { code: 'sign_in_required' });
  assert.equal(f.calls.length, 0);
  // A token-only record from an old transport is insufficient to authorize a
  // CloudBase account; its context account must be explicitly pinned as well.
  f.storage.set(authKey(), { token, expiresAt: expiry() });
  assert.equal((await createMarket(f.wx, settings()).getSession()).user, null);
});

test('CloudBase old-account callbacks cannot clear new auth, return old shopping, or complete a canceled login', async () => {
  const f = runtime(), idA = 'wechat:' + 'a'.repeat(64), idB = 'wechat:' + 'b'.repeat(64), tokenA = 'wxs_' + 'a'.repeat(64), tokenB = 'wxs_' + 'b'.repeat(64);
  f.storage.set(authKey(), { userId: idA, token: tokenA, expiresAt: expiry() });
  const market = createMarket(f.wx, settings()); let oldRequest;
  f.wx.onCloud = options => {
    if (options.data.path === '/api/v1/me/shopping') oldRequest = options;
    else if (options.data.path === '/api/v1/auth/wechat/login') reply(options, { token: tokenB, expiresAt: expiry(), session: session(idB) });
    else reply(options, session(idB));
  };
  const pending = market.getShopping(), rejectedPending = assert.rejects(pending, { code: 'stale_session' }); await flush();
  await market.login();
  reply(oldRequest, { error: { code: 'session_invalid', message: '旧会话' } }, 401);
  await rejectedPending;
  assert.equal(f.storage.get(authKey()).token, tokenB);
  f.wx.onCloud = options => reply(options, { error: { code: 'account_changed', message: '账号已变化' } }, 409);
  await assert.rejects(market.getShopping(), { code: 'account_changed' });
  assert.equal((await market.getSession()).user, null); assert.equal(f.storage.has(authKey()), false);
  let oldLogin;
  f.wx.onCloud = options => { oldLogin = options; };
  const canceled = market.login(), rejectedLogin = assert.rejects(canceled, { code: 'stale_session' }); await flush(); await market.logout();
  f.wx.onCloud = options => reply(options, { token: tokenA, expiresAt: expiry(), session: session(idA) });
  await market.login();
  reply(oldLogin, { token: tokenB, expiresAt: expiry(), session: session(idB) });
  await rejectedLogin;
  assert.equal(f.storage.get(authKey()).token, tokenA);
});

test('CloudBase management is transported with its real actor and server errors retain their version semantics', async () => {
  const f = runtime(), id = 'wechat:' + 'a'.repeat(64), token = 'wxs_' + 'a'.repeat(64);
  f.storage.set(authKey(), { userId: id, token, expiresAt: expiry() });
  const market = createMarket(f.wx, settings());
  const operator = session(id, { role: 'merchant', permissions: ['orders'], canManage: true, merchant: { status: 'enabled' } });
  f.wx.onCloud = options => {
    if (options.data.path === '/api/v1/session') return reply(options, operator);
    return reply(options, { error: { code: 'version_conflict', message: '订单已变化，请重新读取。' } }, 409);
  };
  await assert.rejects(market.shipManagementOrder('DEMO-EXAMPLE', { expectedVersion: 1, carrier: '模拟物流', tracking: 'DEMO-CLOUDBASE' }, id), { code: 'version_conflict', status: 409 });
  const write = f.calls.find(row => row.data.path.endsWith('/ship'));
  assert.equal(write.data.method, 'POST'); assert.equal(write.data.expectedUserId, id); assert.equal(write.data.sessionToken, token);
  assert.deepEqual(write.data.body, { expectedVersion: 1, carrier: '模拟物流', tracking: 'DEMO-CLOUDBASE' });
  await assert.rejects(market.shipManagementOrder('DEMO-EXAMPLE', {}, 'wechat:' + 'b'.repeat(64)), { code: 'stale_session' });
  assert.equal(f.calls.filter(row => row.data.path.endsWith('/ship')).length, 1);
  f.wx.onCloud = options => options.fail({});
  await assert.rejects(market.logout(), { code: 'network_error' });
  assert.equal((await market.getSession()).user, null); assert.equal(f.storage.has(authKey()), false);
});

test('CloudBase adapter fixture detects true concurrent write conflicts without partial commits', async () => {
  const db = new MemoryCloudbaseDB(); await db.collection('stock').doc('apple').set({ data: { remaining: 1 } });
  const a = await db.startTransaction(), b = await db.startTransaction();
  await a.collection('stock').doc('apple').get(); await b.collection('stock').doc('apple').get();
  await a.collection('stock').doc('apple').set({ data: { remaining: 0 } });
  await b.collection('stock').doc('apple').set({ data: { remaining: 0 } });
  await b.collection('orders').doc('loser').set({ data: { status: 'created' } });
  await a.commit(); await assert.rejects(b.commit(), { code: 'DATABASE_TRANSACTION_CONFLICT' });
  assert.equal(db.dump('stock')[0].remaining, 0); assert.deepEqual(db.dump('orders'), []);
});

test('CloudBase adapter models snapshot reads rather than serializable authorization guards', async () => {
  const db = new MemoryCloudbaseDB();
  await db.collection('accounts').doc('operator').set({ data: { enabled: true } });
  const previous = await db.startTransaction();
  assert.equal((await previous.collection('accounts').doc('operator').get()).data.enabled, true);
  await db.collection('accounts').doc('operator').set({ data: { enabled: false } });
  assert.equal((await previous.collection('accounts').doc('operator').get()).data.enabled, true);
  // Reading authorization alone does not conflict with a concurrent revocation.
  // Production business mutations must also write their authorization fence.
  await previous.collection('products').doc('apple').set({ data: { price: 1 } });
  await previous.commit();
  assert.equal(db.dump('products')[0].price, 1);
  assert.equal(db.dump('accounts')[0].enabled, false);
});

test('two CloudBase clients use the real shared handler for shopping, stock, order fulfillment and after-sales', async () => {
  const { CloudbaseStore, digest } = require('../cloudfunctions/market/lib/store.js');
  const { createMarketApi } = require('../cloudfunctions/market/lib/api.js');
  const { schemaVersion, manifestHash } = require('../cloudfunctions/market/lib/provision-contract.js');
  const db = new MemoryCloudbaseDB(), store = new CloudbaseStore(db);
  const operatorId = 'wechat:' + digest(APP + '\0operator');
  const env = { WECHAT_APP_ID: APP, CLOUDBASE_ENV_ID: ENV, BOOTSTRAP_ADMIN_ACCOUNT_ID: operatorId };
  await store.set('meta', 'provision-ready', { id: 'provision-ready', schemaVersion, manifestHash, appId: APP, envId: ENV, ready: true, verifiedAt: new Date().toISOString(), operatorAccountId: operatorId });
  function client(openid) {
    const f = runtime(); f.openid = openid;
    const handler = createMarketApi({ store, env, getContext: () => ({ APPID: APP, OPENID: f.openid, ENV }) });
    f.wx.onCloud = options => handler(clone(options.data)).then(result => ({ result }));
    f.market = createMarket(f.wx, settings()); return f;
  }
  const admin = client('operator'), a = client('buyer'), b = client('buyer'), other = client('different-buyer');
  await admin.market.login(); await a.market.login(); await b.market.login(); await other.market.login();
  const product = { ...clone(model.normalizeCatalogProduct(model.BASE_CATALOG[0])), status: 'published' };
  await admin.market.saveManagementProduct(product, 0, operatorId);
  await admin.market.saveManagementInventory(product.id, { expectedVersion: 0, stocks: { small: 4, family: 2 }, batchCode: 'DEMO-CLOUDBASE', harvestDate: '', note: '本机隔离云函数测试', reason: '模拟测试' }, operatorId);
  const shopping = { cart: [{ productId: product.id, variant: 'small', quantity: 1, selected: true }], favorites: [product.id], recent: [product.id], preferredAddress: 'gansu' };
  const before = await a.market.getShopping(); await a.market.updateShopping(shopping, before.version);
  assert.deepEqual((await b.market.getShopping()).state, shopping);
  await assert.rejects(b.market.updateShopping({ ...shopping, favorites: [] }, before.version), { code: 'version_conflict' });
  const items = shopping.cart.map(({ productId, variant, quantity }) => ({ productId, variant, quantity }));
  const quote = (await a.market.quote(items, 'gansu')).quote;
  const payload = { items, address: 'gansu', expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: a.market.newRequestKey() };
  let order = (await a.market.createOrder(payload)).order;
  assert.equal((await b.market.createOrder(payload)).order.id, order.id);
  assert.equal((await b.market.getInventory()).inventories.find(row => row.productId === product.id).stocks.small, 3);
  assert.equal((await b.market.listOrders()).orders.length, 1);
  await assert.rejects(other.market.getOrder(order.id), { status: 404 });
  order = (await admin.market.shipManagementOrder(order.id, { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-CLOUDBASE' }, operatorId)).order;
  assert.equal((await b.market.getOrder(order.id)).order.fulfillment.status, 'shipped');
  order = (await b.market.receiveOrder(order.id, order.version)).order;
  order = (await b.market.createAfterSale(order.id, { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '模拟售后问题', hasEvidence: false })).order;
  order = (await admin.market.resolveManagementAfterSale(order.id, { expectedVersion: order.version, reply: '模拟处理完成，实际退款0元。' }, operatorId)).order;
  assert.equal((await a.market.getOrder(order.id)).order.afterSale.status, 'resolved');
  // SDK context changes without a client re-login: the real gateway rejects
  // the stale account precondition and the transport erases only this session.
  a.openid = 'different-buyer';
  await assert.rejects(a.market.getShopping(), { code: 'account_changed' });
  assert.equal((await a.market.getSession()).user, null);
  a.openid = 'buyer'; await a.market.login();
  await a.market.logout();
  assert.equal((await a.market.getSession()).user, null);
  assert.equal((await b.market.getSession()).user.id, 'wechat:' + digest(APP + '\0buyer'));
  assert.equal((await b.market.getOrder(order.id)).order.afterSale.merchantReply, '模拟处理完成，实际退款0元。');
  assert.equal(a.storage.has(MOCK_KEY), false); assert.equal(b.storage.has(MOCK_KEY), false);
  a.openid = 'different-buyer'; await a.market.login();
  await assert.rejects(a.market.getOrder(order.id), { status: 404 });
  assert.equal((await a.market.getShopping()).state.cart.length, 0);
});
