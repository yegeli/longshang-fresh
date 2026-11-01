#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BASE_CATALOG } from '../public/model.js';

// Trusted mock identity headers are ONLY for the local test Worker. Refuse
// remote origins and redirects before sending any fixture identity or mutation.
let base;
try {
  base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.username + base.password + base.search + base.hash, '');
  assert.equal(base.pathname, '/');
} catch {
  console.error('Storefront smoke test requires an HTTP loopback root URL, without credentials or redirects.');
  process.exit(1);
}

const suffix = randomUUID().slice(0, 8);
const admin = { id: process.env.SMOKE_ADMIN_ID || 'local_seedy', email: process.env.SMOKE_ADMIN_EMAIL || 'seedy@sites.test' };
const a = { id: `storefront-owner-a-${suffix}`, email: `storefront-owner-a-${suffix}@example.test` };
const b = { id: `storefront-owner-b-${suffix}`, email: `storefront-owner-b-${suffix}@example.test` };
const unbound = { id: `storefront-unbound-${suffix}`, email: `storefront-unbound-${suffix}@example.test` };
const buyer = { id: `storefront-buyer-${suffix}`, email: `storefront-buyer-${suffix}@example.test` };
const profiles = new Map();
const products = new Map();
const unknownOrigin = '未知产地 / <试验>&"（本机模拟）';
let checks = 0;

async function call(path, { user = admin, method = 'GET', body, expected = 200 } = {}) {
  assert.ok(path.startsWith('/api/v1/'));
  const headers = { Accept: 'application/json' };
  if (user) {
    headers['oai-authenticated-user-id'] = user.id;
    headers['oai-authenticated-user-email'] = user.email;
  }
  if (body !== undefined) {
    headers.Origin = base.origin;
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(base.origin + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`${method} ${path}: response was not JSON`); }
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}; code=${result?.error?.code || 'none'}`);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  checks++;
  return result;
}

async function createMerchant(user, name, region, bind = true) {
  const { merchant } = await call('/api/v1/admin/merchants', { method: 'POST', expected: 201, body: {
    name, region, email: user.email, status: 'enabled', permissions: ['products', 'orders', 'aftersales']
  } });
  profiles.set(user.id, merchant);
  if (bind) {
    const session = await call('/api/v1/session', { user });
    assert.equal(session.role, 'merchant');
    assert.equal(session.canManage, true);
  }
  return merchant;
}

async function updateMerchant(user, patch) {
  const profile = profiles.get(user.id);
  const { merchant: current } = await call('/api/v1/admin/merchants/' + profile.id);
  const body = {
    name: current.name, email: current.email, region: current.region,
    permissions: current.permissions, status: current.status, ...patch, expectedVersion: current.version
  };
  const { merchant } = await call('/api/v1/admin/merchants/' + current.id, { method: 'PUT', body });
  profiles.set(user.id, merchant);
  return merchant;
}

async function createProduct(user, id, name, origin, status = 'published') {
  const product = { ...structuredClone(BASE_CATALOG[0]), id, name, origin, status };
  const result = await call('/api/v1/admin/products/' + id, { user, method: 'PUT', body: { product, expectedVersion: 0 } });
  assert.equal(result.product.id, id);
  products.set(id, result.product);
  return result.product;
}

async function setProductStatus(id, status) {
  const previous = products.get(id);
  const { product } = await call('/api/v1/admin/products/' + id, {
    method: 'PUT', body: { product: { ...previous, status }, expectedVersion: previous.version }
  });
  products.set(id, product);
  return product;
}

const directory = () => call('/api/v1/storefront', { user: null });
const publicProducts = async () => (await call('/api/v1/products', { user: null })).products;
const sorted = values => [...values].sort();
const shopFor = (value, id) => value.shops.find(shop => shop.productIds.includes(id));
const regionFor = (value, id) => value.regions.find(region => region.productIds.includes(id));
const safeId = value => assert.match(value, /^[a-z0-9][a-z0-9-]{0,95}$/, 'Public route IDs must be safe path segments.');

function verifyPublicDirectory(value, visibleProducts) {
  assert.deepEqual(sorted(Object.keys(value)), ['regions', 'shops', 'updatedAt']);
  assert.ok(Array.isArray(value.regions));
  assert.ok(Array.isArray(value.shops));
  assert.ok(value.updatedAt === null || typeof value.updatedAt === 'string');
  const privateKeys = /^(?:email|user_?id|owner_?id|permissions|bound|version|created_?by|updated_?by|merchant_?id|merchant_?note|password|token)$/i;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.ok(!privateKeys.test(key), `Private field ${key} must not appear in the public directory.`);
      visit(child);
    }
  }
  visit(value);
  const serialized = JSON.stringify(value);
  for (const identity of [admin, a, b, unbound, buyer]) {
    assert.ok(!serialized.includes(identity.id), 'Raw identity IDs must not appear publicly.');
    assert.ok(!serialized.includes(identity.email), 'Login emails must not appear publicly.');
  }
  for (const profile of profiles.values()) assert.ok(!serialized.includes(profile.id), 'Private merchant record IDs must not appear publicly.');
  const publishedIds = new Set(visibleProducts.map(product => product.id));
  const assignedIds = [];
  assert.equal(new Set(value.shops.map(shop => shop.id)).size, value.shops.length);
  assert.equal(new Set(value.regions.map(region => region.id)).size, value.regions.length);
  for (const shop of value.shops) {
    assert.deepEqual(sorted(Object.keys(shop)), sorted(['id', 'name', 'regionIds', 'regionLabel', 'description', 'procurementName', 'image', 'preview', 'productIds', 'simulation']));
    safeId(shop.id);
    assert.equal(shop.simulation, true);
    assert.equal(new Set(shop.productIds).size, shop.productIds.length);
    assert.ok(shop.regionIds.every(id => value.regions.some(region => region.id === id)));
    if (shop.preview) assert.deepEqual(shop.productIds, [], 'A preview shop must not offer products.');
    else assert.ok(shop.productIds.length, 'Empty active shops should not pretend to supply products.');
    for (const id of shop.productIds) {
      assert.ok(publishedIds.has(id), 'Only publicly visible published products belong in a shop.');
      assignedIds.push(id);
      const region = regionFor(value, id);
      assert.ok(region);
      assert.ok(region.shopIds.includes(shop.id));
      assert.ok(shop.regionIds.includes(region.id));
    }
  }
  assert.equal(new Set(assignedIds).size, assignedIds.length, 'A product must belong to exactly one actual-owner shop.');
  assert.deepEqual(sorted(assignedIds), sorted(publishedIds), 'Shop products must match the public catalog.');
  for (const region of value.regions) {
    assert.deepEqual(sorted(Object.keys(region)), sorted(['id', 'name', 'province', 'subtitle', 'description', 'image', 'preview', 'productIds', 'shopIds']));
    safeId(region.id);
    assert.equal(new Set(region.productIds).size, region.productIds.length);
    assert.ok(region.productIds.every(id => publishedIds.has(id)));
    assert.ok(region.shopIds.every(id => value.shops.some(shop => shop.id === id)));
    if (region.preview) {
      assert.deepEqual(region.productIds, [], 'A preview region must not offer products.');
      assert.ok(region.shopIds.every(id => value.shops.find(shop => shop.id === id).preview));
    }
  }
  checks++;
}

try {
  assert.equal((await call('/api/v1/session')).role, 'admin');
  const baseline = await directory();
  const baselineProducts = await publicProducts();
  verifyPublicDirectory(baseline, baselineProducts);
  const dingbian = baseline.regions.find(region => region.id === 'shaanxi-dingbian');
  assert.ok(dingbian, 'Dingbian should have a clearly labelled future-region entry.');
  if (!baselineProducts.some(product => /定边/.test(product.origin))) {
    assert.equal(dingbian.preview, true);
    assert.deepEqual(dingbian.productIds, []);
    assert.ok(dingbian.shopIds.length);
    assert.ok(dingbian.shopIds.every(id => baseline.shops.find(shop => shop.id === id)?.preview));
  }

  await createMerchant(a, '景泰店铺验收采购者（模拟）', '甘肃 · 景泰');
  await createMerchant(b, '异地产区验收采购者（模拟）', '未知产地（本机模拟）');
  const unopened = await createMerchant(unbound, `尚未绑定-${suffix}（模拟）`, '甘肃 · 景泰', false);
  const pa = await createProduct(a, `storefront-a1-${suffix}`, '店铺验收苹果甲（模拟）', '甘肃 · 景泰（本机模拟）');
  const pa2 = await createProduct(a, `storefront-a2-${suffix}`, '店铺验收苹果乙（模拟）', '甘肃 · 景泰（本机模拟）');
  const draft = await createProduct(a, `storefront-draft-${suffix}`, '未发布验收苹果（模拟）', '甘肃 · 景泰（本机模拟）', 'draft');
  const pb = await createProduct(b, `storefront-b-${suffix}`, '异地验收苹果（模拟）', unknownOrigin);
  let value = await directory();
  verifyPublicDirectory(value, await publicProducts());
  const shopA = shopFor(value, pa.id), shopB = shopFor(value, pb.id);
  assert.ok(shopA && shopB);
  assert.notEqual(shopA.id, shopB.id, 'Distinct owners must have distinct shops.');
  assert.deepEqual(sorted(shopA.productIds), sorted([pa.id, pa2.id]));
  assert.deepEqual(shopB.productIds, [pb.id]);
  assert.equal(shopA.name, '景泰店铺验收采购者（模拟）');
  assert.ok(!value.shops.some(shop => shop.name === unopened.name), 'An unbound profile is not an open storefront.');
  assert.ok(!JSON.stringify(value).includes(draft.id), 'Draft products must not leak into any directory list.');
  const unknownRegion = regionFor(value, pb.id);
  assert.ok(unknownRegion);
  assert.equal(unknownRegion.name, unknownOrigin, 'Unknown origins retain their own label instead of being falsely assigned to Jingtai.');
  assert.notEqual(unknownRegion.id, 'gansu-jingtai');
  assert.notEqual(unknownRegion.id, 'shaanxi-dingbian');
  const repeated = await directory();
  assert.equal(shopFor(repeated, pa.id).id, shopA.id, 'Public owner IDs must be stable across reads.');
  assert.equal(regionFor(repeated, pb.id).id, unknownRegion.id, 'Unknown region IDs must be stable across reads.');

  // Listing a published product must never fabricate positive stock.
  const stock = (await call('/api/v1/inventory', { user: null })).inventories.find(item => item.productId === pa.id);
  assert.ok(stock);
  assert.deepEqual(stock.stocks, { small: 0, family: 0 });
  await call('/api/v1/orders/quote', { user: buyer, method: 'POST', expected: 409, body: {
    items: [{ productId: pa.id, variant: 'small', quantity: 1 }], address: 'gansu'
  } });

  await updateMerchant(a, { status: 'disabled' });
  value = await directory();
  verifyPublicDirectory(value, await publicProducts());
  assert.ok(!value.shops.some(shop => shop.id === shopA.id), 'Disabled merchants must lose their public shop.');
  assert.ok(!JSON.stringify(value).includes(pa.id));
  assert.ok(!JSON.stringify(value).includes(pa2.id));
  assert.equal(shopFor(value, pb.id).id, shopB.id, 'Disabling one merchant must not hide another merchant.');
  await updateMerchant(a, { status: 'enabled' });
  value = await directory();
  assert.equal(shopFor(value, pa.id).id, shopA.id, 'Re-enabling a merchant preserves the opaque shop identity.');
  await setProductStatus(pa.id, 'offline');
  await setProductStatus(pa2.id, 'offline');
  value = await directory();
  verifyPublicDirectory(value, await publicProducts());
  assert.ok(!value.shops.some(shop => shop.id === shopA.id), 'A draft-only/offline merchant is not an active shop.');
  assert.equal(shopFor(value, pb.id).id, shopB.id);
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', checks, merchantsCreated: profiles.size, productsCreated: products.size, message: error.message }));
  process.exitCode = 1;
} finally {
  // Keep local audit trails, but take every temporary fixture off sale even if
  // an assertion failed. No real merchant, product, stock or order is changed.
  let cleanupFailed = false;
  for (const [id, product] of products) {
    try { if (product.status !== 'offline') await setProductStatus(id, 'offline'); }
    catch { cleanupFailed = true; }
  }
  for (const [id] of profiles) {
    try { await updateMerchant({ id }, { status: 'disabled' }); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) {
    console.error('Some local storefront fixtures could not be taken offline; inspect the local test database before reusing it.');
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(JSON.stringify({ result: 'PASS', checks, merchants: profiles.size, products: products.size, simulated: true, payment: false, realShipment: false }));
