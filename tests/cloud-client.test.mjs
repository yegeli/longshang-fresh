import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_CATALOG, CATALOG, setCatalog, getProduct, addToCart, validCart, quoteCart, createCartOrder } from '../public/model.js';
import * as cloud from '../public/cloud-client.js';
import { refreshCatalog, readCatalog, saveProduct, setProductStatus, getProductVersion } from '../public/catalog-store.js';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let sequence = 0;
const isolatedCloud = () => import(`../public/cloud-client.js?test=${++sequence}`);
const manager = { user: { id: 'test-operator', name: '测试运营' }, role: 'admin', canManage: true, signInUrl: '/signin-with-chatgpt', signOutUrl: '/signout-with-chatgpt' };
const copy = value => JSON.parse(JSON.stringify(value));

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
  setCatalog(BASE_CATALOG);
});

test('only the explicit static-server 404 marker enables local demo mode', async () => {
  const client = await isolatedCloud(); let requests = 0;
  globalThis.fetch = async (url, options) => { requests++; assert.equal(url, '/api/v1/session'); assert.equal(options.credentials, 'same-origin'); return json({ mode: 'local-demo' }, 404); };
  assert.equal((await client.initializeCloudMode()).mode, 'local');
  await client.initializeCloudMode(); assert.equal(requests, 1, 'Normal initialization reuses the discovered mode');
});

test('unmarked or HTML 404 responses fail closed instead of enabling local management', async () => {
  for (const response of [() => json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404), () => new Response('<h1>Not found</h1>', { status: 404 })]) {
    const client = await isolatedCloud(); globalThis.fetch = async () => response();
    await assert.rejects(client.initializeCloudMode(), error => error.status === 404);
    assert.equal(client.getCloudState().mode, 'cloud'); assert.equal(client.getCloudState().session, null);
    assert.throws(() => client.requireManager(), /登录/);
  }
});

test('network and HTTP failures preserve cloud mode and never authorize a local fallback', async () => {
  for (const status of [0, 401, 403, 500]) {
    const client = await isolatedCloud();
    globalThis.fetch = async () => { if (!status) throw new TypeError('offline'); return json({ error: { code: 'UNAVAILABLE', message: '暂时无法连接' } }, status); };
    await assert.rejects(client.initializeCloudMode());
    assert.equal(client.isCloudMode(), true); assert.equal(client.getCloudState().session, null);
    globalThis.fetch = async () => json({ mode: 'local-demo' }, 404);
    await assert.rejects(client.initializeCloudMode({ force: true }), 'An established cloud failure must not later downgrade to local mode');
    assert.equal(client.getCloudState().mode, 'cloud');
  }
});

test('malformed successful session data cannot open management', async () => {
  for (const body of [{ user: null }, { user: {}, canManage: true }, { user: { id: 'test' }, canManage: 'true' }]) {
    const client = await isolatedCloud(); globalThis.fetch = async () => json(body);
    await assert.rejects(client.initializeCloudMode(), /登录状态响应异常/);
    assert.throws(() => client.requireManager(), /登录/);
  }
});

test('an anonymous cloud session can read public products but cannot manage them', async () => {
  const client = await isolatedCloud();
  globalThis.fetch = async url => url.endsWith('/session') ? json({ user: null, role: 'guest', canManage: false }) : json({ products: [] });
  await client.initializeCloudMode(); assert.equal(client.isCloudMode(), true);
  assert.throws(() => client.requireManager(), error => error.status === 403);
  assert.deepEqual(await client.apiRequest('/api/v1/products'), { products: [] });
  assert.equal(client.authHref('javascript:alert(1)'), '');
  assert.equal(client.authHref('/signin-with-chatgpt?return_to=%2Fadmin.html'), '/signin-with-chatgpt?return_to=%2Fadmin.html');
});

test('cloud API errors retain status and code for conflict handling without switching mode', async () => {
  const client = await isolatedCloud(); globalThis.fetch = async () => json(manager); await client.initializeCloudMode();
  globalThis.fetch = async () => json({ error: { code: 'VERSION_CONFLICT', message: '商品已更新' } }, 409);
  await assert.rejects(client.apiRequest('/api/v1/admin/products/test', { method: 'PUT' }), error => error.status === 409 && error.code === 'VERSION_CONFLICT' && error.message === '商品已更新');
  assert.equal(client.isCloudMode(), true);
  await assert.rejects(client.apiRequest('https://example.invalid/api/v1/products'), /接口地址/);
});

function forbidLocalStorage() {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Cloud catalog must not use localStorage'); } });
}

test('cloud catalog uses server data and keeps the editor version and input intact after a conflict', async () => {
  forbidLocalStorage(); let product = { ...copy(BASE_CATALOG[0]), version: 3 }; let request;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/session')) return json(manager);
    if (options.method === 'PUT') { request = JSON.parse(options.body); return json({ error: { code: 'VERSION_CONFLICT', message: '商品已更新' } }, 409); }
    return json({ products: [product], updatedAt: '2026-11-01T00:00:00.000Z' });
  };
  await cloud.initializeCloudMode({ force: true }); await refreshCatalog({ admin: true });
  assert.equal(CATALOG.length, 1); assert.equal(readCatalog()[0].name, product.name);
  const editorVersion = getProductVersion(product.id); assert.equal(editorVersion, 3);
  const input = { ...copy(CATALOG[0]), name: '用户尚未保存的修改（模拟）' }; const originalInput = copy(input);
  product = { ...product, version: 4, name: '另一位运营的新名称（模拟）' };
  await refreshCatalog({ admin: true });
  await assert.rejects(saveProduct(input, { expectedVersion: editorVersion }), error => error.status === 409);
  assert.equal(request.expectedVersion, 3, 'Refresh must not replace the version captured when editing began');
  assert.equal(request.product.name, input.name); assert.deepEqual(input, originalInput, 'Rejected saves leave the caller draft untouched');
  assert.equal(getProductVersion(product.id), 4); assert.equal(readCatalog()[0].name, product.name, 'A conflict must not replace the server snapshot with the rejected draft');
});

test('successful cloud price/status writes update the cached version without touching browser storage', async () => {
  forbidLocalStorage(); let product = { ...copy(BASE_CATALOG[0]), version: 7 }; const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/session')) return json(manager);
    if (options.method === 'PUT') { const input = JSON.parse(options.body); writes.push(input); product = { ...input.product, version: input.expectedVersion + 1 }; return json({ product, version: product.version }); }
    return json({ products: [product] });
  };
  await cloud.initializeCloudMode({ force: true }); await refreshCatalog({ admin: true });
  const saved = await saveProduct({ id: product.id, variants: [{ id: 'small', price: 1234 }, { id: 'family', price: 5678 }] }, { expectedVersion: 7 });
  assert.equal(saved.variants[0].price, 1234); assert.equal(saved.variants[1].price, 5678); assert.equal(getProductVersion(product.id), 8);
  await setProductStatus(product.id, 'offline', { expectedVersion: 8 });
  assert.equal(readCatalog()[0].status, 'offline'); assert.equal(getProductVersion(product.id), 9); assert.deepEqual(writes.map(write => write.expectedVersion), [7, 8]);
});

test('invalid server catalog or failed cloud writes preserve the previous valid cache and version', async () => {
  forbidLocalStorage(); let mode = 'valid'; const product = { ...copy(BASE_CATALOG[0]), version: 2 };
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/session')) return json(manager);
    if (options.method === 'PUT') return json({ error: { code: 'STORAGE_FAILED', message: '数据库保存失败' } }, 500);
    return json({ products: mode === 'valid' ? [product] : [{ ...product, version: 0 }] });
  };
  await cloud.initializeCloudMode({ force: true }); await refreshCatalog({ admin: true }); mode = 'invalid';
  await assert.rejects(refreshCatalog({ admin: true }), /版本格式/);
  assert.equal(readCatalog()[0].name, product.name); assert.equal(getProductVersion(product.id), 2);
  await assert.rejects(saveProduct({ ...copy(product), name: '失败的保存（模拟）' }, { expectedVersion: 2 }), /数据库保存失败/);
  assert.equal(readCatalog()[0].name, product.name); assert.equal(getProductVersion(product.id), 2);
});

test('a cloud user without management rights cannot trigger a save or read the admin catalog', async () => {
  forbidLocalStorage(); const requests = [];
  globalThis.fetch = async url => { requests.push(url); return json({ user: { id: 'viewer' }, role: 'viewer', canManage: false }); };
  await cloud.initializeCloudMode({ force: true });
  await assert.rejects(refreshCatalog({ admin: true }), error => error.status === 403);
  await assert.rejects(saveProduct(copy(BASE_CATALOG[0])), error => error.status === 403);
  assert.deepEqual(requests, ['/api/v1/session']);
});


test('a formerly public product missing on refresh stays in this tab cart but cannot sell or expose private admin data', async () => {
  forbidLocalStorage();
  let publicProducts = [{ ...copy(BASE_CATALOG[0]), id: 'cloud-cart-product', version: 1 }];
  const privateProduct = { ...copy(BASE_CATALOG[1]), id: 'private-admin-draft', name: '未公开的运营草稿（模拟）', status: 'draft', version: 1 };
  globalThis.fetch = async url => {
    if (url.endsWith('/session')) return json(manager);
    return json({ products: url.includes('/admin/') ? [privateProduct] : publicProducts, updatedAt: '2020-01-01T00:00:00.000Z' });
  };
  await cloud.initializeCloudMode({ force: true });
  const beforeFetch = Date.now(); await refreshCatalog();
  assert.ok(Date.parse(cloud.getCloudState().lastSyncedAt) >= beforeFetch, 'Last synchronization records fetch time, not the server modification timestamp');
  assert.equal(getProduct('pear'), null, 'Default products must not be silently added to a cloud catalog');
  const cart = addToCart([], { productId: publicProducts[0].id, variant: 'small', quantity: 2 });
  assert.equal(quoteCart(cart, 'gansu').available, true);
  publicProducts = []; await refreshCatalog();
  assert.equal(getProduct(cart[0].productId).status, 'offline'); assert.deepEqual(validCart(cart), cart);
  const amount = quoteCart(cart, 'gansu'); assert.equal(amount.available, false); assert.equal(amount.total, null); assert.equal(amount.unavailableItems.length, 1);
  assert.throws(() => createCartOrder(cart, 'gansu', 'DEMO-OFFLINE'), /下架|尚未上架/);
  await refreshCatalog({ admin: true });
  assert.equal(getProduct(cart[0].productId), null, 'Admin refresh replaces its directory rather than retaining inaccessible entries');
  assert.equal(getProduct(privateProduct.id).name, privateProduct.name);
  await refreshCatalog();
  assert.equal(getProduct(privateProduct.id), null, 'Public retention must never inherit a private admin-only product');
  assert.equal(getProduct(cart[0].productId).status, 'offline');
  const freshTabStore = await import(`../public/catalog-store.js?fresh-tab=${++sequence}`);
  await freshTabStore.refreshCatalog();
  assert.deepEqual(validCart(cart), [], 'A fresh tab has no old public snapshot; unavailable unknown cart items are not restored from defaults');
});
