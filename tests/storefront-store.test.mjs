import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { localStorefront, DINGBIAN_PREVIEW_SHOP_ID } from '../public/storefront-data.js';
import { BASE_CATALOG } from '../public/model.js';

const source = (await readFile(new URL('../public/storefront-store.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.subject={refreshStorefront,getStorefrontState,shopForProduct,regionForProduct};';
const cloudDirectory = () => {
  const data = localStorefront(BASE_CATALOG), real = data.shops.find(shop => !shop.preview), id = 'shop-0123456789abcdef01234567';
  const oldId = real.id; real.id = id;
  for (const region of data.regions) region.shopIds = region.shopIds.map(value => value === oldId ? id : value);
  data.updatedAt = '2026-11-01T00:00:00.000Z';
  return data;
};
function harness(mode = 'cloud') {
  const cloud = { mode }, calls = [], behavior = { respond: async () => cloudDirectory() };
  class CloudError extends Error { constructor(message, status, code) { super(message); Object.assign(this, { status, code }); } }
  const context = vm.createContext({ structuredClone, CloudError, localStorefront, DINGBIAN_PREVIEW_SHOP_ID,
    getCloudState: () => ({ ...cloud }), apiRequest: async path => { calls.push(path); return behavior.respond(path); },
    localStorage: { getItem() { throw new Error('Directory cannot read localStorage.'); }, setItem() { throw new Error('Directory cannot write localStorage.'); } } });
  new vm.Script(source).runInContext(context);
  return { ...context.subject, cloud, calls, behavior };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('local directory dynamically groups only published products in a single simulated shop with region links', async () => {
  const h = harness('local');
  const extra = { ...BASE_CATALOG[0], id: 'dingbian-demo', origin: '陕西 · 定边（模拟）' };
  let state = await h.refreshStorefront({ products: [...BASE_CATALOG, extra, { ...extra, id: 'draft', status: 'draft' }] });
  assert.equal(state.ready, true); assert.equal(state.error, ''); assert.equal(h.calls.length, 0);
  assert.equal(state.shops.length, 1); assert.equal(state.shops[0].productIds.length, BASE_CATALOG.length + 1);
  assert.deepEqual(plain(state.shops[0].regionIds), ['gansu-jingtai', 'shaanxi-dingbian']);
  assert.equal(h.regionForProduct(extra.id).id, 'shaanxi-dingbian'); assert.equal(h.shopForProduct('draft'), null);
  state = await h.refreshStorefront({ products: [{ ...extra, origin: '新产地 · 演示' }] });
  assert.equal(h.shopForProduct(BASE_CATALOG[0].id), null);
  assert.equal(state.shops.filter(shop => !shop.preview).length, 1);
  assert.equal(h.regionForProduct(extra.id).name, '新产地 · 演示');
  assert.equal(state.regions.find(region => region.id === 'shaanxi-dingbian').preview, true);
  assert.equal(state.shops.find(shop => shop.preview).productIds.length, 0);
});

test('public cloud directory uses only storefront GET, deep clones reads and never requests private data', async () => {
  const h = harness(), state = await h.refreshStorefront({ products: BASE_CATALOG });
  assert.deepEqual(h.calls, ['/api/v1/storefront']); assert.equal(state.error, '');
  assert.equal(h.shopForProduct('jingtai-apple').id, 'shop-0123456789abcdef01234567');
  state.shops[0].productIds.length = 0; const first = h.getStorefrontState(); assert.equal(first.shops[0].productIds.length, BASE_CATALOG.length);
  h.shopForProduct('jingtai-apple').productIds.length = 0; h.regionForProduct('jingtai-apple').shopIds.length = 0;
  assert.equal(h.getStorefrontState().shops[0].productIds.length, BASE_CATALOG.length);
  assert.equal(h.getStorefrontState().regions.find(region => region.id === 'gansu-jingtai').shopIds.length, 1);
  assert.equal(h.shopForProduct('missing'), null); assert.equal(h.regionForProduct('missing'), null);
});

test('cloud network and invalid directory failures clear old ownership and never fall back to local products', async () => {
  const h = harness(); await h.refreshStorefront();
  h.behavior.respond = async () => { throw new Error('云端暂不可用'); };
  let state = await h.refreshStorefront({ products: BASE_CATALOG });
  assert.equal(state.error, '云端暂不可用'); assert.equal(state.ready, true); assert.deepEqual(plain(state.shops), []); assert.deepEqual(plain(state.regions), []);
  assert.equal(h.shopForProduct('jingtai-apple'), null); assert.equal(h.cloud.mode, 'cloud');
  for (const mutate of [
    data => { data.shops[0].ownerId = 'private-owner'; },
    data => { data.regions[0].shopIds.push('shop-unknown'); },
    data => { data.shops.push(structuredClone(data.shops[0])); },
    data => { data.regions.push(structuredClone(data.regions[0])); },
    data => { data.shops[0].productIds.push('not-in-region'); },
    data => { data.shops[0].preview = true; },
    data => { data.shops.find(shop => shop.preview).productIds = ['fake-preview-product']; },
    data => { data.shops.find(shop => shop.preview).regionIds = ['gansu-jingtai']; },
    data => { data.shops[0].simulation = false; },
    data => { data.updatedAt = 42; }
  ]) {
    const data = cloudDirectory(); mutate(data); h.behavior.respond = async () => data;
    state = await h.refreshStorefront({ products: BASE_CATALOG });
    assert.match(state.error, /格式异常/); assert.deepEqual(plain(state.shops), []);
  }
});

test('late successful or failed requests cannot restore an obsolete directory after a newer refresh', async () => {
  for (const failOld of [false, true]) {
    const h = harness(); let finish, reject;
    h.behavior.respond = () => new Promise((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
    const old = h.refreshStorefront();
    assert.equal(h.getStorefrontState().ready, false);
    h.behavior.respond = async () => { throw new Error('newer failure'); };
    await h.refreshStorefront();
    if (failOld) reject(new Error('old failure')); else finish(cloudDirectory());
    await old;
    assert.equal(h.getStorefrontState().error, 'newer failure'); assert.deepEqual(plain(h.getStorefrontState().shops), []);
  }
  const h = harness(); let finish;
  h.behavior.respond = () => new Promise(resolve => { finish = resolve; });
  const old = h.refreshStorefront(); h.cloud.mode = 'local';
  await h.refreshStorefront({ products: BASE_CATALOG }); finish(cloudDirectory()); await old;
  assert.equal(h.shopForProduct('jingtai-apple').id, 'shop-local-demo');
});

test('uninitialized mode or an in-flight connection-mode change fails closed without persistence', async () => {
  const uninitialized = harness('uninitialized');
  assert.match((await uninitialized.refreshStorefront({ products: BASE_CATALOG })).error, /连接状态/);
  assert.deepEqual(uninitialized.calls, []);
  const h = harness(); let finish;
  h.behavior.respond = () => new Promise(resolve => { finish = resolve; });
  const pending = h.refreshStorefront(); h.cloud.mode = 'local'; finish(cloudDirectory());
  const state = await pending; assert.match(state.error, /连接状态已变化/); assert.deepEqual(plain(state.shops), []);
});
