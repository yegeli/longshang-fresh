import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_CATALOG, CATALOG, PRODUCT, setCatalog, getProduct, quote, createOrder, validOrders } from '../dist/model.js';
import { CATALOG_KEY, readCatalog, saveProduct, setProductStatus, newProductTemplate, parsePrice } from '../dist/catalog-store.js';

const values = new Map();
let failReads = false, failWrites = false;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key) { if (failReads) throw new Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (failWrites) throw new Error('quota exceeded'); values.set(key, String(value)); }
  }
});
test.beforeEach(() => { failReads = false; failWrites = false; values.clear(); setCatalog(BASE_CATALOG); });
test.after(() => { if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage; });

test('default catalog reads six published products and never resets unrelated user records', () => {
  values.set('longshang-demo-orders-v1', '["existing orders"]');
  values.set('longshang-demo-cart-v1', '["existing cart"]');
  const products = readCatalog();
  assert.equal(CATALOG_KEY, 'longshang-demo-catalog-v1');
  assert.equal(products.length, 6);
  assert.ok(products.every(product => product.status === 'published'));
  assert.equal(products[0].video, '');
  assert.equal(products[1].video, '');
  assert.equal(values.get('longshang-demo-orders-v1'), '["existing orders"]');
  assert.equal(values.get('longshang-demo-cart-v1'), '["existing cart"]');
  assert.equal(values.has(CATALOG_KEY), false);
});

test('partial edits change both variant prices while preserving facts and harvest records', () => {
  const product = saveProduct({
    id: 'jingtai-apple', name: '新名称苹果（模拟）', origin: '景泰模拟果园',
    summary: '已更新的模拟介绍',
    variants: [{ id: 'small', price: 1234 }, { id: 'family', price: 5678 }]
  });
  assert.equal(product.variants[0].label, '尝鲜装');
  assert.equal(product.variants[1].weight, '净重 5kg');
  assert.deepEqual(product.facts, BASE_CATALOG[0].facts);
  assert.deepEqual(product.harvestSteps, BASE_CATALOG[0].harvestSteps);
  assert.equal(PRODUCT.name, '新名称苹果（模拟）');
  assert.equal(quote('small').total, 1834);
  assert.equal(BASE_CATALOG[0].name, '景泰红富士苹果');
  assert.equal(BASE_CATALOG[0].variants[0].price, 4990);
  setCatalog(BASE_CATALOG);
  readCatalog();
  assert.equal(getProduct('jingtai-apple').variants[1].price, 5678);
});

test('new product template is editable, complete and draft until explicitly published', () => {
  const draft = newProductTemplate('demo-new-local-food');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.video, '');
  assert.equal(draft.variants.length, 2);
  assert.equal(draft.harvestSteps.length, 3);
  assert.match(draft.summary, /模拟/);
  draft.name = '新增景泰特产（模拟）';
  draft.variants[0].price = 2090;
  const product = saveProduct(draft);
  assert.equal(product.variants[0].price, 2090);
  assert.equal(CATALOG.length, 7);
  assert.equal(quote('small', 1, 'gansu', product.id).total, null);
  setProductStatus(product.id, 'published');
  assert.equal(quote('small', 1, 'gansu', product.id).total, 2690);
  setProductStatus(product.id, 'offline');
  assert.equal(getProduct(product.id).status, 'offline');
  assert.equal(quote('small', 1, 'gansu', product.id).available, false);
  assert.throws(() => setProductStatus(product.id, 'deleted'), /状态/);
  assert.throws(() => setProductStatus('not-found', 'published'), /不存在/);
});

test('yuan parsing is exact in integer cents and rejects invalid prices', () => {
  for (const [input, expected] of [['49.90', 4990], [49.9, 4990], ['.50', 50], ['0.29', 29], ['0001.20', 120], ['1.', 100], ['9999.99', 999999]]) {
    assert.equal(parsePrice(input), expected);
  }
  for (const invalid of ['', ' ', '-1', -1, '1.234', 'abc', '1e2', '0x10', '0', 0, '10000', NaN, Infinity, true, null, undefined]) {
    assert.throws(() => parsePrice(invalid));
  }
});

test('invalid product fields fail before any write and leave live catalog unchanged', () => {
  readCatalog();
  const before = CATALOG;
  const badInputs = [
    { id: 'jingtai-apple', name: '' }, { id: 'jingtai-apple', name: '字'.repeat(41) },
    { id: 'jingtai-apple', category: 'unknown' }, { id: 'jingtai-apple', status: 'removed' },
    { id: 'jingtai-apple', variants: [{ id: 'small', price: 0 }, { id: 'family', price: 100 }] },
    { id: 'jingtai-apple', variants: [{ id: 'small', price: 1.5 }, { id: 'family', price: 100 }] },
    { id: 'jingtai-apple', variants: [{ id: 'small', price: 1000000 }, { id: 'family', price: 100 }] },
    { id: 'jingtai-apple', image: 'https://outside.example/picture.jpg' },
    { id: 'jingtai-apple', video: 'assets/../private.mp4' }
  ];
  for (const input of badInputs) {
    assert.throws(() => saveProduct(input));
    assert.equal(CATALOG, before);
    assert.equal(values.has(CATALOG_KEY), false);
  }
});

test('write failure reports failure without changing catalog or order storage', () => {
  saveProduct({ id: 'jingtai-apple', name: '已保存名称（模拟）' });
  const before = CATALOG;
  const saved = values.get(CATALOG_KEY);
  values.set('longshang-demo-orders-v1', '["kept"]');
  failWrites = true;
  assert.throws(() => saveProduct({ id: 'jingtai-apple', name: '不应保存的新名称' }), /未保存/);
  assert.throws(() => setProductStatus('jingtai-apple', 'offline'), /未保存/);
  assert.equal(CATALOG, before);
  assert.equal(values.get(CATALOG_KEY), saved);
  assert.equal(values.get('longshang-demo-orders-v1'), '["kept"]');
});

test('unreadable or corrupt catalog throws without replacing persisted user data', () => {
  const before = CATALOG;
  values.set(CATALOG_KEY, '{broken JSON');
  assert.throws(() => readCatalog(), /损坏/);
  assert.throws(() => saveProduct({ id: 'jingtai-apple', name: '不能覆盖损坏记录' }), /损坏/);
  assert.equal(values.get(CATALOG_KEY), '{broken JSON');
  assert.equal(CATALOG, before);
  failReads = true;
  assert.throws(() => readCatalog(), /读取/);
  assert.equal(CATALOG, before);
});

test('media IDs persist while historical order image and amount snapshots remain unchanged', () => {
  saveProduct({ id: 'jingtai-apple', imageMediaId: 'MEDIA-IMAGE-1', videoMediaId: 'MEDIA-VIDEO-1', videoTitle: '模拟上传视频', videoNote: '上传素材仅为模拟' });
  const order = createOrder({ productId: 'jingtai-apple', variant: 'small', quantity: 1, address: 'gansu' }, 'DEMO-MEDIA-OLD', '2026-10-31T08:00:00.000Z');
  saveProduct({ id: 'jingtai-apple', image: 'assets/pear.jpg', imageMediaId: 'MEDIA-IMAGE-2', variants: [{ id: 'small', price: 9999 }, { id: 'family', price: 9999 }] });
  const [restored] = validOrders([order]);
  assert.equal(restored.image, 'assets/apples.jpg');
  assert.equal(restored.imageMediaId, 'MEDIA-IMAGE-1');
  assert.equal(restored.total, 5590);
  assert.equal(getProduct('jingtai-apple').imageMediaId, 'MEDIA-IMAGE-2');
  saveProduct({ id: 'jingtai-apple', imageMediaId: '', videoMediaId: '' });
  assert.equal(getProduct('jingtai-apple').imageMediaId, undefined);
  assert.equal(getProduct('jingtai-apple').videoMediaId, undefined);
});

test('saving another product reads latest persisted edits instead of overwriting a second tab', () => {
  readCatalog();
  values.set(CATALOG_KEY, JSON.stringify(BASE_CATALOG.map(product => product.id === 'pear' ? { ...product, name: '其他标签页修改的梨（模拟）' } : product)));
  saveProduct({ id: 'jingtai-apple', name: '当前标签页修改的苹果（模拟）' });
  assert.equal(getProduct('pear').name, '其他标签页修改的梨（模拟）');
  assert.equal(getProduct('jingtai-apple').name, '当前标签页修改的苹果（模拟）');
});
