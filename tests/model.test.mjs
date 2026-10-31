import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG, PRODUCT, STORAGE_KEY, getProduct, quote, createOrder, validOrders,
  createAfterSale, updateAfterSale, CART_KEY, validCart, addToCart, quoteCart,
  createCartOrder, orderItems, BASE_CATALOG, setCatalog, isProductAvailable,
  shipOrder, saveOrderNote, resolveAfterSale
} from '../dist/model.js';

const createdAt = '2026-10-31T08:00:00.000Z';
const submittedAt = '2026-10-31T08:05:00.000Z';
const updatedAt = '2026-10-31T08:10:00.000Z';
const selection = { variant: 'small', quantity: 1, address: 'gansu' };
const makeOrder = (overrides = {}, id = 'DEMO-TEST-1') => createOrder({ ...selection, ...overrides }, id, createdAt);
const input = { type: 'refund', reason: 'damaged', description: '演示：一个苹果有碰伤', hasEvidence: true };
const apply = (order = makeOrder(), overrides = {}) => createAfterSale(order, { ...input, ...overrides }, 'AFTER-SALE-1', submittedAt);

test('catalog contains the six supported products and complete demo detail data', () => {
  assert.deepEqual(CATALOG.map(p => p.id), ['jingtai-apple', 'goji', 'pear', 'potato', 'corn', 'onion']);
  assert.equal(PRODUCT, getProduct('jingtai-apple'));
  assert.equal(getProduct('missing'), null);
  assert.equal(STORAGE_KEY, 'longshang-demo-orders-v1');
  for (const product of CATALOG) {
    assert.ok(['fruit', 'dried', 'vegetable'].includes(product.category));
    assert.match(product.image, /^assets\/[a-z]+\.jpg$/);
    for (const key of ['name', 'origin', 'subtitle', 'summary', 'storage', 'sizeNote']) assert.ok(product[key]);
    assert.ok(product.tags.length >= 2);
    assert.ok(product.facts.every(row => row.length === 2 && row.every(value => typeof value === 'string')));
    assert.equal(product.harvestSteps.length, 3);
    assert.ok(product.harvestSteps.every(step => step.title && step.text));
    assert.deepEqual(product.variants.map(v => v.id), ['small', 'family']);
    assert.ok(Object.isFrozen(product));
  }
});

test('legacy quote arguments still yield exact apple totals in integer cents', () => {
  const small = quote('small', 1, 'gansu');
  assert.equal(small.product, PRODUCT);
  assert.equal(small.subtotal, 4990);
  assert.equal(small.total, 5590);
  const family = quote('family', 3, 'shaanxi');
  assert.equal(family.subtotal, 23970);
  assert.equal(family.shipping, 1000);
  assert.equal(family.total, 24970);
});

test('all products use their own specification price and region shipping', () => {
  const expected = {
    'jingtai-apple': [4990, 7990], goji: [1990, 3990], pear: [3990, 6990],
    potato: [1990, 3290], corn: [2990, 4590], onion: [1690, 2690]
  };
  for (const [id, prices] of Object.entries(expected)) {
    for (const [index, variant] of ['small', 'family'].entries()) {
      const q = quote(variant, 3, 'shaanxi', id);
      assert.equal(q.product.id, id);
      assert.equal(q.variant.price, prices[index]);
      assert.equal(q.subtotal, prices[index] * 3);
      assert.equal(q.total, prices[index] * 3 + 1000);
      assert.ok(Number.isSafeInteger(q.total));
    }
  }
  assert.throws(() => quote('small', 1, 'gansu', 'missing'), /商品不存在/);
});

test('quantity boundaries and unsupported region are handled before submission', () => {
  assert.equal(quote('small', 0).quantity, 1);
  assert.equal(quote('family', 999).quantity, 10);
  assert.equal(quote('small', 2.9).quantity, 2);
  assert.equal(quote('small', 2, 'other', 'pear').total, null);
  assert.throws(() => makeOrder({ address: 'other', productId: 'pear' }), /配送地区/);
});

test('orders snapshot each product and do not follow subsequent selection changes', () => {
  const chosen = { productId: 'goji', variant: 'family', quantity: 2, address: 'shaanxi' };
  const order = createOrder(chosen, 'DEMO-GOJI-1', createdAt);
  chosen.productId = 'corn'; chosen.variant = 'small'; chosen.quantity = 7;
  assert.equal(order.productId, 'goji');
  assert.equal(order.product, getProduct('goji').name);
  assert.equal(order.image, 'assets/goji.jpg');
  assert.equal(order.weight, '净含量 250g');
  assert.equal(order.variant, 'family');
  assert.equal(order.quantity, 2);
  assert.equal(order.total, 8980);
  assert.equal(order.status, 'created');
  assert.deepEqual(validOrders([order]), [order]);
});

test('legacy apple records migrate without relabeling them as another catalog product', () => {
  const legacy = {
    id: 'DEMO-LEGACY-1', createdAt, product: '景泰红富士苹果',
    variant: 'family', variantLabel: '家庭装', weight: '净重 5kg',
    unitPrice: 7990, quantity: 2, subtotal: 15980, shipping: 1000,
    total: 16980, address: 'shaanxi', status: 'created'
  };
  const [migrated] = validOrders([legacy]);
  assert.equal(migrated.productId, 'jingtai-apple');
  assert.equal(migrated.product, legacy.product);
  assert.equal(migrated.image, 'assets/apples.jpg');
  assert.equal(migrated.total, legacy.total);
  assert.equal(legacy.productId, undefined);
});

test('historical monetary snapshots survive catalog validation and missing labels receive safe defaults', () => {
  const order = makeOrder({ productId: 'pear' });
  const historical = { ...order, unitPrice: 3500, subtotal: 3500, total: 4100 };
  assert.equal(validOrders([historical])[0].total, 4100);
  const [cleaned] = validOrders([{ ...order, variantLabel: null, weight: {}, image: 'https://outside.example/image.jpg' }]);
  assert.equal(cleaned.variantLabel, '尝鲜装');
  assert.equal(cleaned.weight, '净重 2.5kg');
  assert.equal(cleaned.image, 'assets/pear.jpg');
});

test('malformed persisted orders, unknown products and duplicate IDs do not enter the UI', () => {
  const order = makeOrder();
  assert.deepEqual(validOrders([
    null, {}, { ...order, total: 1 }, { ...order, status: 'paid' },
    { ...order, productId: 'unknown' }, { ...order, quantity: 11 },
    { ...order, address: 'other' }, { ...order, createdAt: 'invalid' }
  ]), []);
  assert.deepEqual(validOrders({}), []);
  assert.equal(validOrders([order, order]).length, 1);
  assert.equal(validOrders(Array.from({ length: 110 }, (_, index) => makeOrder({}, `DEMO-${index}`))).length, 100);
});

test('creating an after-sale request returns an order copy without changing the main status', () => {
  const order = makeOrder();
  const updated = apply(order);
  assert.notEqual(updated, order);
  assert.equal(order.afterSale, undefined);
  assert.equal(updated.status, 'created');
  assert.deepEqual(updated.afterSale, {
    id: 'AFTER-SALE-1', ...input, status: 'submitted', createdAt: submittedAt, updatedAt: submittedAt
  });
  assert.deepEqual(validOrders([updated]), [updated]);
  assert.equal(apply(order, { type: 'replacement', hasEvidence: false }).afterSale.type, 'replacement');
});

test('duplicate pending requests and cancelled orders cannot create after-sale requests', () => {
  assert.throws(() => apply(apply()), /重复申请/);
  assert.throws(() => apply({ ...makeOrder(), status: 'cancelled' }), /仅已生成/);
  assert.throws(() => apply(null), /仅已生成/);
});

test('after-sale form validates type, reason, description length and evidence flag', () => {
  for (const overrides of [
    { type: 'paid-refund' }, { reason: 'unknown' }, { description: '字'.repeat(301) },
    { description: null }, { hasEvidence: 'true' }
  ]) assert.throws(() => apply(makeOrder(), overrides));
  assert.equal(apply(makeOrder(), { description: '字'.repeat(300) }).afterSale.description.length, 300);
  assert.equal(apply(makeOrder(), { description: '' }).afterSale.description, '');
  assert.equal(apply(makeOrder(), { description: '规格 < 订单说明，损坏数量 > 1' }).afterSale.description, '规格 < 订单说明，损坏数量 > 1');
});

test('submitted after-sale can resolve or withdraw without changing the order status', () => {
  const order = apply();
  for (const status of ['resolved', 'withdrawn']) {
    const updated = updateAfterSale(order, status, updatedAt);
    assert.equal(updated.status, 'created');
    assert.equal(updated.afterSale.status, status);
    assert.equal(updated.afterSale.createdAt, submittedAt);
    assert.equal(updated.afterSale.updatedAt, updatedAt);
    assert.equal(order.afterSale.status, 'submitted');
    assert.deepEqual(validOrders([updated]), [updated]);
    assert.throws(() => updateAfterSale(updated, 'resolved', updatedAt), /仅待处理/);
    assert.equal(createAfterSale(updated, input, 'AFTER-SALE-2', updatedAt).afterSale.status, 'submitted');
  }
  assert.throws(() => updateAfterSale(order, 'submitted', updatedAt), /仅可标记/);
  assert.throws(() => updateAfterSale(order, 'resolved', createdAt), /时间无效/);
  assert.throws(() => updateAfterSale(makeOrder(), 'resolved', updatedAt), /仅待处理/);
  assert.throws(() => updateAfterSale({ ...order, afterSale: { ...order.afterSale, updatedAt: 'bad date' } }, 'resolved', updatedAt), /仅待处理/);
});

test('invalid persisted after-sale is removed while its valid parent order is retained', () => {
  const order = apply();
  const invalidCases = [
    null, [], {}, { ...order.afterSale, status: 'refunded' },
    { ...order.afterSale, description: '字'.repeat(301) },
    { ...order.afterSale, description: {} }, { ...order.afterSale, hasEvidence: 'yes' },
    { ...order.afterSale, createdAt: 'bad date' },
    { ...order.afterSale, updatedAt: createdAt }, { ...order.afterSale, id: '<img>' }
  ];
  for (const afterSale of invalidCases) {
    const [cleaned] = validOrders([{ ...order, afterSale }]);
    assert.equal(cleaned.id, order.id);
    assert.equal(cleaned.afterSale, undefined);
  }
  const [cleaned] = validOrders([{ ...order, afterSale: { ...order.afterSale, unexpectedField: 'discard' } }]);
  assert.deepEqual(cleaned.afterSale, order.afterSale);
  assert.deepEqual(validOrders([]), []);
});

test('cart normalizes and merges SKUs without mutating the input or dropping unselected rows', () => {
  const original = [
    { productId: 'jingtai-apple', variant: 'small', quantity: 2, selected: false },
    { productId: 'goji', variant: 'family', quantity: 1, selected: false },
    { productId: 'jingtai-apple', variant: 'small', quantity: 3, selected: true },
    { productId: 'jingtai-apple', variant: 'family', quantity: 1 }
  ];
  assert.equal(CART_KEY, 'longshang-demo-cart-v1');
  assert.deepEqual(validCart(original), [
    { productId: 'jingtai-apple', variant: 'small', quantity: 5, selected: true },
    { productId: 'goji', variant: 'family', quantity: 1, selected: false },
    { productId: 'jingtai-apple', variant: 'family', quantity: 1, selected: true }
  ]);
  assert.equal(original[0].quantity, 2);
  assert.equal(original[0].selected, false);
  assert.equal(original[3].selected, undefined);
});

test('malformed cart rows are ignored and duplicate quantities cap at ten per SKU', () => {
  const row = { productId: 'pear', variant: 'small', quantity: 8, selected: false };
  assert.deepEqual(validCart([
    null, {}, { ...row, productId: 'unknown' }, { ...row, variant: 'unknown' },
    { ...row, quantity: 0 }, { ...row, quantity: 11 }, { ...row, quantity: 1.5 },
    { ...row, quantity: '2' }, { ...row, selected: 'false' }, row, row
  ]), [{ ...row, quantity: 10 }]);
  assert.deepEqual(validCart({}), []);
  const allSkus = CATALOG.flatMap(product => product.variants.map(variant => ({ productId: product.id, variant: variant.id, quantity: 10, selected: true })));
  assert.equal(validCart([...allSkus, ...allSkus]).length, 12);
  assert.ok(validCart([...allSkus, ...allSkus]).every(item => item.quantity === 10));
});

test('addToCart merges the same SKU, reselects it and preserves separate specifications', () => {
  const original = [{ productId: 'pear', variant: 'small', quantity: 8, selected: false }];
  const cart = addToCart(original, { productId: 'pear', variant: 'small', quantity: 5 });
  assert.deepEqual(cart, [{ productId: 'pear', variant: 'small', quantity: 10, selected: true }]);
  assert.equal(original[0].quantity, 8);
  assert.equal(original[0].selected, false);
  const twoSpecs = addToCart(cart, { productId: 'pear', variant: 'family', quantity: 1 });
  assert.equal(twoSpecs.length, 2);
  assert.equal(twoSpecs[1].variant, 'family');
  assert.equal(addToCart([], { productId: 'corn', variant: 'small', quantity: 100 })[0].quantity, 10);
  assert.equal(addToCart([], { productId: 'corn', variant: 'small' })[0].quantity, 1);
  for (const invalid of [null, {}, { productId: 'pear', variant: 'unknown', quantity: 1 }, { productId: 'pear', variant: 'small', quantity: 0 }]) {
    assert.throws(() => addToCart([], invalid));
  }
});

test('cart quote counts only selected items and charges shipping once per combined order', () => {
  const cart = [
    { productId: 'jingtai-apple', variant: 'small', quantity: 2, selected: true },
    { productId: 'goji', variant: 'family', quantity: 3, selected: true },
    { productId: 'corn', variant: 'small', quantity: 10, selected: false }
  ];
  const quote = quoteCart(cart, 'gansu');
  assert.equal(quote.items.length, 2);
  assert.equal(quote.quantity, 5);
  assert.equal(quote.subtotal, 21950);
  assert.equal(quote.shipping, 600);
  assert.equal(quote.total, 22550);
  assert.equal(quote.address.id, 'gansu');
  assert.deepEqual(quote.items.map(item => [item.productId, item.variant, item.quantity, item.subtotal]), [
    ['jingtai-apple', 'small', 2, 9980], ['goji', 'family', 3, 11970]
  ]);
  assert.equal(quoteCart(cart, 'shaanxi').total, 22950);
  assert.equal(quoteCart(cart, 'other').total, null);
  const empty = quoteCart(cart.map(item => ({ ...item, selected: false })), 'gansu');
  assert.deepEqual(empty.items, []);
  assert.equal(empty.quantity, 0);
  assert.equal(empty.subtotal, 0);
  assert.equal(empty.total, null);
  assert.equal(quoteCart([], 'gansu').total, null);
  assert.throws(() => createCartOrder([], 'gansu', 'DEMO-CART-EMPTY'), /选择/);
  assert.throws(() => createCartOrder(cart, 'other', 'DEMO-CART-OTHER'), /配送地区/);
});

test('multi-item orders preserve snapshots and keep first-item compatibility fields', () => {
  const cart = [
    { productId: 'jingtai-apple', variant: 'small', quantity: 2, selected: true },
    { productId: 'goji', variant: 'family', quantity: 3, selected: true }
  ];
  const order = createCartOrder(cart, 'shaanxi', 'DEMO-CART-1', createdAt);
  assert.equal(order.quantity, 5);
  assert.equal(order.productId, 'jingtai-apple');
  assert.equal(order.image, 'assets/apples.jpg');
  assert.equal(order.product, '景泰红富士苹果等2款商品');
  assert.equal(order.total, 22950);
  assert.equal(order.items[1].weight, '净含量 250g');
  cart[0].quantity = 10;
  assert.equal(order.items[0].quantity, 2);
  assert.deepEqual(validOrders([order]), [order]);
  const items = orderItems(order);
  items[0].quantity = 9;
  assert.equal(order.items[0].quantity, 2);
});

test('multi-item order validation accepts total quantities above ten while enforcing row boundaries and aggregates', () => {
  const cart = [
    { productId: 'pear', variant: 'small', quantity: 10, selected: true },
    { productId: 'pear', variant: 'family', quantity: 10, selected: true }
  ];
  const order = createCartOrder(cart, 'gansu', 'DEMO-CART-20', createdAt);
  assert.equal(order.quantity, 20);
  assert.equal(order.product, getProduct('pear').name);
  assert.deepEqual(validOrders([order]), [order]);
  const invalid = [
    { ...order, quantity: 10 }, { ...order, subtotal: order.subtotal + 1, total: order.total + 1 },
    { ...order, total: order.total + 1 }, { ...order, items: [] }, { ...order, items: null },
    { ...order, items: [order.items[0], order.items[0]] },
    { ...order, items: [{ ...order.items[0], productId: 'unknown' }, order.items[1]] },
    { ...order, items: [{ ...order.items[0], quantity: 11 }, order.items[1]] }
  ];
  assert.deepEqual(validOrders(invalid), []);
  assert.deepEqual(orderItems({ ...order, items: null }), []);
});

test('persisted multi-item prices remain historical snapshots instead of following current catalog prices', () => {
  const order = createCartOrder([
    { productId: 'pear', variant: 'small', quantity: 2, selected: true },
    { productId: 'onion', variant: 'family', quantity: 1, selected: true }
  ], 'gansu', 'DEMO-CART-HISTORY', createdAt);
  order.items[0].unitPrice = 3500;
  order.items[0].subtotal = 7000;
  order.unitPrice = 3500;
  order.subtotal = 9690;
  order.total = 10290;
  assert.deepEqual(validOrders([order]), [order]);
  assert.equal(validOrders([order])[0].items[0].unitPrice, 3500);
});

test('orderItems supports both legacy and current single-product orders without forcing an items field', () => {
  const old = makeOrder();
  delete old.productId;
  delete old.image;
  const [restored] = validOrders([old]);
  assert.equal(restored.items, undefined);
  assert.equal(restored.productId, 'jingtai-apple');
  assert.deepEqual(orderItems(old), orderItems(restored));
  assert.equal(orderItems(makeOrder({ productId: 'goji' }))[0].productId, 'goji');
  assert.deepEqual(orderItems(null), []);
  assert.deepEqual(orderItems({}), []);
});

test('after-sale requests persist and transition for the entire multi-item order', () => {
  const order = createCartOrder([
    { productId: 'jingtai-apple', variant: 'small', quantity: 2, selected: true },
    { productId: 'potato', variant: 'family', quantity: 2, selected: true }
  ], 'gansu', 'DEMO-CART-AFTER', createdAt);
  const submitted = createAfterSale(order, input, 'AFTER-CART-1', submittedAt);
  assert.equal(submitted.total, order.total);
  assert.deepEqual(submitted.items, order.items);
  assert.deepEqual(validOrders(JSON.parse(JSON.stringify([submitted]))), [submitted]);
  const resolved = updateAfterSale(submitted, 'resolved', updatedAt);
  assert.equal(resolved.status, 'created');
  assert.equal(resolved.afterSale.status, 'resolved');
  assert.deepEqual(resolved.items, order.items);
  assert.deepEqual(validOrders([resolved]), [resolved]);
});

test('base catalog stays immutable while live catalog supports edited prices and media snapshots', () => {
  const original = makeOrder();
  try {
    setCatalog(BASE_CATALOG.map(product => product.id === 'jingtai-apple' ? {
      ...product, name: '苹果新名称（模拟）', image: 'assets/pear.jpg', imageMediaId: 'MEDIA-NEW-IMAGE',
      variants: product.variants.map(variant => ({ ...variant, price: variant.price + 1000 }))
    } : product));
    assert.equal(PRODUCT.name, '苹果新名称（模拟）');
    assert.equal(quote('small').total, 6590);
    const updated = makeOrder();
    assert.equal(updated.imageMediaId, 'MEDIA-NEW-IMAGE');
    assert.deepEqual(validOrders([updated]), [updated]);
    assert.equal(validOrders([original])[0].total, 5590);
    assert.equal(validOrders([original])[0].product, '景泰红富士苹果');
    assert.equal(BASE_CATALOG[0].variants[0].price, 4990);
    assert.equal(BASE_CATALOG[0].status, 'published');
    assert.equal(BASE_CATALOG[0].video, '');
    assert.ok(Object.isFrozen(BASE_CATALOG[0].variants[0]));
  } finally { setCatalog(BASE_CATALOG); }
});

test('offline products remain in cart and historical orders but block new orders and additions', () => {
  const before = makeOrder();
  const cart = [
    { productId: 'jingtai-apple', variant: 'small', quantity: 1, selected: true },
    { productId: 'pear', variant: 'small', quantity: 1, selected: true }
  ];
  try {
    setCatalog(BASE_CATALOG.map(product => product.id === 'jingtai-apple' ? { ...product, status: 'offline' } : product));
    assert.equal(getProduct('jingtai-apple').status, 'offline');
    assert.equal(isProductAvailable(getProduct('jingtai-apple')), false);
    assert.equal(quote('small').available, false);
    assert.equal(quote('small').total, null);
    assert.throws(() => makeOrder(), /下架/);
    assert.throws(() => addToCart(cart, selection), /有效的商品/);
    assert.throws(() => addToCart(cart, { ...selection, productId: 'jingtai-apple' }), /下架/);
    assert.equal(validCart(cart).length, 2);
    const mixed = quoteCart(cart, 'gansu');
    assert.equal(mixed.items.length, 2);
    assert.equal(mixed.unavailableItems.length, 1);
    assert.equal(mixed.unavailableItems[0].productId, 'jingtai-apple');
    assert.equal(mixed.total, null);
    assert.throws(() => createCartOrder(cart, 'gansu', 'DEMO-OFFLINE'), /下架/);
    const allowed = cart.map(row => ({ ...row, selected: row.productId !== 'jingtai-apple' }));
    assert.equal(quoteCart(allowed, 'gansu').total, 4590);
    assert.deepEqual(quoteCart(allowed, 'gansu').unavailableItems, []);
    assert.deepEqual(validOrders([before]), [before]);
  } finally { setCatalog(BASE_CATALOG); }
});

test('new draft catalog products cannot sell until published', () => {
  const product = { ...BASE_CATALOG[0], id: 'new-demo-fruit', name: '新增果品（模拟）', status: 'draft' };
  try {
    setCatalog([...BASE_CATALOG, product]);
    assert.equal(CATALOG.length, 7);
    assert.equal(quote('small', 1, 'gansu', product.id).available, false);
    assert.throws(() => createOrder({ ...selection, productId: product.id }, 'DEMO-DRAFT'), /尚未上架/);
    setCatalog([...BASE_CATALOG, { ...product, status: 'published' }]);
    const order = createOrder({ ...selection, productId: product.id }, 'DEMO-NEW-PRODUCT', createdAt);
    assert.equal(order.productId, product.id);
    assert.deepEqual(validOrders([order]), [order]);
    const before = CATALOG;
    assert.throws(() => setCatalog([...BASE_CATALOG, { ...product, name: '' }]));
    assert.equal(CATALOG, before);
  } finally { setCatalog(BASE_CATALOG); }
});

test('merchant shipping rejects cancelled, duplicate and pending-after-sale orders', () => {
  const order = makeOrder();
  const shipped = shipOrder(order, '演示快递', 'DEMO-TRACK-1', updatedAt);
  assert.equal(order.fulfillment, undefined);
  assert.equal(shipped.status, 'created');
  assert.deepEqual(shipped.fulfillment, { status: 'shipped', carrier: '演示快递', tracking: 'DEMO-TRACK-1', shippedAt: updatedAt });
  assert.deepEqual(validOrders([shipped]), [shipped]);
  assert.throws(() => shipOrder(shipped, '演示快递', 'DEMO-TRACK-2', updatedAt), /重复/);
  assert.throws(() => shipOrder({ ...order, status: 'cancelled' }, '演示快递', 'DEMO-TRACK-2', updatedAt), /取消/);
  assert.throws(() => shipOrder(apply(order), '演示快递', 'DEMO-TRACK-2', updatedAt), /售后/);
  assert.throws(() => shipOrder(resolveAfterSale(apply(order), '模拟整单退款完成', updatedAt), '演示快递', 'DEMO-TRACK-2', updatedAt), /整单模拟退款/);
  assert.throws(() => shipOrder(order, '', 'DEMO-TRACK-2', updatedAt), /名称/);
  assert.throws(() => shipOrder(order, '演示快递', 'REAL-123', updatedAt), /DEMO/);
  assert.throws(() => shipOrder(order, '演示快递', 'DEMO-TRACK-2', 'bad date'), /时间/);
});

test('merchant notes and after-sale replies survive validation without changing original snapshots', () => {
  const order = makeOrder();
  const noted = saveOrderNote(order, ' 已核对规格，演示备注 ');
  assert.equal(noted.merchantNote, '已核对规格，演示备注');
  assert.equal(order.merchantNote, undefined);
  assert.throws(() => saveOrderNote(order, '字'.repeat(301)), /300/);
  const resolved = resolveAfterSale(apply(noted), ' 已模拟协商处理，不产生真实退款 ', updatedAt);
  assert.equal(resolved.afterSale.status, 'resolved');
  assert.equal(resolved.afterSale.merchantReply, '已模拟协商处理，不产生真实退款');
  assert.equal(resolved.total, order.total);
  assert.deepEqual(validOrders([resolved]), [resolved]);
  assert.throws(() => resolveAfterSale(apply(order), '字'.repeat(301), updatedAt), /300/);
  const [cleaned] = validOrders([{ ...resolved, merchantNote: {}, fulfillment: { status: 'shipped', carrier: '', tracking: 'real', shippedAt: 'bad' }, afterSale: { ...resolved.afterSale, merchantReply: '字'.repeat(301) } }]);
  assert.equal(cleaned.merchantNote, undefined);
  assert.equal(cleaned.fulfillment, undefined);
  assert.equal(cleaned.afterSale.status, 'resolved');
  assert.equal(cleaned.afterSale.merchantReply, undefined);
});
