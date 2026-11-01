import test from 'node:test';
import assert from 'node:assert/strict';
import * as cloud from '../public/cloud-client.js';
import { refreshCatalog, saveProduct } from '../public/catalog-store.js';
import { loadCloudOrders, mutateCloudOrder } from '../public/order-store.js';
import { BASE_CATALOG, CATALOG, setCatalog } from '../public/model.js';

const originalFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const merchant = (permissions, version = 1) => ({ user: { id: 'merchant-one', name: '景泰采购员（模拟）' }, role: 'merchant', canManage: true, permissions, merchant: { id: 'MERCHANT-ONE', status: 'enabled', version } });
async function setSession(value) { globalThis.fetch = async () => json(value); return cloud.initializeCloudMode({ force: true }); }
test.afterEach(() => { globalThis.fetch = originalFetch; setCatalog(BASE_CATALOG); });

test('merchant permissions fail closed when missing, empty, disabled or malformed', async () => {
  for (const session of [{ ...merchant([]), permissions: undefined }, merchant([]), { ...merchant(['products']), merchant: { status: 'disabled' } }]) {
    await setSession(session);
    assert.equal(cloud.hasPermission('products'), false);
    assert.equal(cloud.getCloudState().session.canManage, false);
    assert.throws(() => cloud.requirePermission('products'));
  }
  await assert.rejects(setSession(merchant(['products', 'admin'])), error => error.code === 'INVALID_SESSION');
  assert.equal(cloud.getCloudState().session, null);
});

test('permission-specific guards prevent ungranted product and fulfillment requests', async () => {
  await setSession(merchant(['aftersales']));
  let requests = 0; globalThis.fetch = async () => { requests++; return json({ orders: [], nextCursor: null }); };
  await assert.rejects(refreshCatalog({ admin: true }), error => error.status === 403);
  await assert.rejects(saveProduct(BASE_CATALOG[0]), error => error.status === 403);
  await assert.rejects(mutateCloudOrder('DEMO-ONE', 'ship', { expectedVersion: 1 }, { manager: true }), error => error.status === 403);
  assert.equal(requests, 0);
  assert.deepEqual((await loadCloudOrders({ manager: true })).orders, []);
  assert.equal(requests, 1);
  await setSession(merchant(['products']));
  globalThis.fetch = async () => { throw Error('Should not send orders request'); };
  await assert.rejects(loadCloudOrders({ manager: true }), error => error.status === 403);
});

test('same-account permission changes invalidate scope while array order does not', async () => {
  await setSession(merchant(['orders', 'aftersales']));
  const original = cloud.managementScopeKey();
  await setSession(merchant(['aftersales', 'orders']));
  assert.equal(cloud.managementScopeKey(), original);
  await setSession(merchant(['aftersales'], 2));
  assert.throws(() => cloud.requireUnchangedScope(original), error => error.code === 'account_changed');
});

test('session snapshots cannot mutate the actual granted permissions', async () => {
  await setSession(merchant(['aftersales']));
  const copy = cloud.getCloudState();
  copy.session.permissions.push('products'); copy.session.role = 'admin'; copy.session.merchant.status = 'disabled';
  assert.equal(cloud.hasPermission('products'), false);
  assert.equal(cloud.hasPermission('aftersales'), true);
  assert.equal(cloud.getCloudState().session.merchant.status, 'enabled');
});

test('a catalog read started under broader rights cannot populate private data after revocation', async () => {
  await setSession(merchant(['products'])); setCatalog([]);
  let release; globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = refreshCatalog({ admin: true });
  await setSession(merchant(['aftersales'], 2));
  release(json({ products: [{ ...BASE_CATALOG[0], version: 1, name: '旧权限下的私有商品' }] }));
  await assert.rejects(pending, error => error.code === 'account_changed');
  assert.equal(CATALOG.length, 0);
});

test('a management order read cannot return an earlier permission scope to the same account', async () => {
  await setSession(merchant(['orders', 'aftersales']));
  let release; globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = loadCloudOrders({ manager: true });
  await setSession(merchant(['aftersales'], 2));
  release(json({ orders: [], nextCursor: null }));
  await assert.rejects(pending, error => error.code === 'account_changed');
});

test('late session success or failure never overwrites a newer permission decision', async () => {
  for (const fail of [false, true]) {
    let resolveOld, rejectOld;
    globalThis.fetch = () => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const stale = cloud.initializeCloudMode({ force: true });
    await setSession(merchant(['aftersales'], 8));
    if (fail) rejectOld(new Error('late network failure')); else resolveOld(json(merchant(['products', 'orders', 'aftersales'], 1)));
    await assert.rejects(stale, error => error.code === 'session_superseded');
    assert.deepEqual(cloud.getCloudState().session.permissions, ['aftersales']);
    assert.equal(cloud.getCloudState().session.merchant.version, 8);
    assert.equal(cloud.getCloudState().error, '');
  }
});
