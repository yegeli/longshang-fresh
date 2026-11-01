import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as model from '../public/model.js';

// Run the actual event handlers without opening or controlling a browser.
const source = (await readFile(new URL('../public/admin.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/\nboot\(\);\s*$/, '\n')
  + '\nglobalThis.subject = { state, boot, loadData, readOrders, writeOrders, openDrawer, renderDrawer, refreshRemote, reloadDrawer, saveCloudOrderForm, afterHistory };';
const copy = value => JSON.parse(JSON.stringify(value));
const original = () => ({ ...model.createOrder({ productId: 'jingtai-apple', variant: 'small', quantity: 1, address: 'gansu' }, 'DEMO-ADMIN-UI', '2026-11-01T03:00:00.000Z'), version: 1, updatedAt: '2026-11-01T03:00:00.000Z' });

function harness() {
  const nodes = new Map(), handlers = {}, writes = [], calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], querySelector: () => node('nested'), focus() {}, dataset: {} });
    return nodes.get(id);
  };
  const cloud = { mode: 'cloud', session: { user: { id: 'admin-one', name: '测试运营' }, role: 'admin', canManage: true }, lastSyncedAt: '2026-11-01T03:00:00.000Z' };
  const behavior = { orders: [original()], confirm: true, initialize: async () => {}, mutate: async () => { throw new Error('Specify mutation in the test'); }, single: async () => behavior.orders[0] };
  const context = vm.createContext({
    ...model,
    document: { querySelector: node, querySelectorAll: () => [], addEventListener: (name, callback) => { handlers[name] = callback; }, body: node('body'), activeElement: node('focus') },
    window: { addEventListener() {}, scrollTo() {}, confirm: () => behavior.confirm },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    localStorage: { getItem() { writes.push('read'); throw new Error('Cloud UI read local storage'); }, setItem() { writes.push('write'); throw new Error('Cloud UI wrote local storage'); } },
    FormData: class { constructor(form) { this.values = form.values || {}; } get(key) { return this.values[key] ?? null; } has(key) { return Object.hasOwn(this.values, key); } },
    getCloudState: () => cloud, isCloudMode: () => cloud.mode === 'cloud',
    initializeCloudMode: async () => { await behavior.initialize(); return cloud; },
    readCatalog: () => model.CATALOG, refreshCatalog: async () => { if (behavior.catalog) await behavior.catalog(); }, hydrateMedia: async () => [],
    imageFor: item => item.image || 'assets/apples.jpg', videoFor: () => '', mediaErrorFor: () => '',
    loadCloudOrders: async options => { calls.push({ method: 'list', options }); return behavior.list ? await behavior.list() : { orders: copy(behavior.orders), lastSyncedAt: '2026-11-01T03:10:00.000Z' }; },
    loadCloudOrder: async (id, options) => { calls.push({ method: 'single', id, options }); return copy(await behavior.single()); },
    mutateCloudOrder: async (id, action, payload, options) => { calls.push({ method: 'mutation', id, action, payload: copy(payload), options }); return copy(await behavior.mutate(id, action, payload)); },
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    icon: () => '', authHref: value => value || '', CATALOG_KEY: 'catalog-key',
    saveProduct() {}, setProductStatus() {}, newProductTemplate() {}, parsePrice() {}, getProductVersion() {}, saveMedia() {}, apiRequest() {}
  });
  new vm.Script(source, { filename: 'admin.js' }).runInContext(context);
  return { ...context.subject, context, cloud, behavior, nodes, handlers, calls, writes };
}

test('cloud admin boot reads remote orders and never reads, seeds or writes local orders', async () => {
  const h = harness(); await h.boot();
  assert.equal(h.state.orders.length, 1); assert.equal(h.state.orders[0].version, 1);
  assert.equal(h.state.accountId, 'admin-one'); assert.equal(h.calls[0].options.manager, true);
  assert.deepEqual(h.writes, []);
  h.loadData(); assert.equal(h.state.orders[0].id, 'DEMO-ADMIN-UI');
  assert.throws(() => h.readOrders(), /云端模式不读取本机订单/);
  assert.throws(() => h.writeOrders([]), /云端订单不能写入本机存储/);
  assert.match(h.nodes.get('#scope-notice').textContent, /订单、发货与售后云端同步/);
});

test('refresh keeps the opened order version and a conflicting save retains drafts until explicit reload', async () => {
  const h = harness(); await h.boot(); h.openDrawer('order', 'DEMO-ADMIN-UI');
  h.state.drawer.note = '尚未保存的备注'; h.state.drawer.carrier = '待核对的物流';
  h.behavior.orders = [{ ...original(), version: 2, merchantNote: '另一设备已修改' }];
  await h.refreshRemote({ manual: true });
  assert.equal(h.state.orders[0].version, 2);
  assert.equal(h.state.drawer.expectedVersion, 1); assert.equal(h.state.drawer.order.version, 1);
  assert.equal(h.state.drawer.note, '尚未保存的备注'); assert.equal(h.state.drawer.externalChanged, true);
  h.behavior.mutate = async () => { const error = new Error('版本已变化'); error.status = 409; throw error; };
  await h.saveCloudOrderForm({ id: 'order-note-form', values: { note: h.state.drawer.note } });
  const mutation = h.calls.find(call => call.method === 'mutation');
  assert.equal(mutation.payload.expectedVersion, 1); assert.equal(mutation.action, 'note');
  assert.equal(h.state.drawer.conflict, true); assert.equal(h.state.drawer.note, '尚未保存的备注');
  assert.equal(h.state.drawer.carrier, '待核对的物流'); assert.equal(h.state.orders[0].merchantNote, '另一设备已修改');
  h.behavior.confirm = false; await h.reloadDrawer(); assert.equal(h.state.drawer.note, '尚未保存的备注');
  h.behavior.confirm = true; await h.reloadDrawer();
  assert.equal(h.state.drawer.expectedVersion, 2); assert.equal(h.state.drawer.note, '另一设备已修改'); assert.equal(h.state.drawer.conflict, false);
  assert.deepEqual(h.writes, []);
});

test('cloud shipping waits for server success, blocks duplicate submissions and updates the shared order snapshot', async () => {
  const h = harness(); await h.boot(); h.openDrawer('order', 'DEMO-ADMIN-UI');
  let finish;
  h.behavior.mutate = () => new Promise(resolve => { finish = resolve; });
  const form = { id: 'ship-form', values: { carrier: '演示物流', tracking: 'DEMO-TRACK-ONE' } };
  const pending = h.saveCloudOrderForm(form);
  assert.equal(h.state.busy, true); assert.equal(h.state.orders[0].fulfillment, undefined);
  await h.saveCloudOrderForm(form);
  assert.equal(h.calls.filter(call => call.method === 'mutation').length, 1);
  finish({ ...original(), version: 2, updatedAt: '2026-11-01T03:10:00.000Z', fulfillment: { status: 'shipped', carrier: '演示物流', tracking: 'DEMO-TRACK-ONE', shippedAt: '2026-11-01T03:10:00.000Z' } });
  await pending;
  assert.equal(h.state.busy, false); assert.equal(h.state.orders[0].fulfillment.status, 'shipped');
  assert.equal(h.state.drawer.expectedVersion, 2); assert.equal(h.state.drawer.order.fulfillment.tracking, 'DEMO-TRACK-ONE');
  assert.deepEqual(h.writes, []);
});

test('an account switch or revoked management role clears old orders, form drafts and drawer', async () => {
  const h = harness(); await h.boot(); h.openDrawer('order', 'DEMO-ADMIN-UI');
  h.state.editor = null;
  h.behavior.initialize = async () => { h.cloud.session = { user: { id: 'admin-two' }, canManage: true, role: 'admin' }; };
  h.behavior.orders = [];
  await h.refreshRemote({ manual: true });
  assert.equal(h.state.accountId, 'admin-two'); assert.equal(h.state.orders.length, 0); assert.equal(h.state.drawer, null);
  h.state.orders = [original()]; h.openDrawer('order', 'DEMO-ADMIN-UI');
  h.behavior.initialize = async () => { h.cloud.session = { user: { id: 'admin-two' }, canManage: false, role: 'buyer' }; };
  await h.refreshRemote({ manual: true });
  assert.equal(h.state.orders.length, 0); assert.equal(h.state.drawer, null); assert.equal(h.state.editor, null); assert.equal(h.state.accountId, null);
  assert.equal(h.nodes.get('#admin-nav').hidden, true);
});

test('after-sale history escapes user text and shows every submitted, withdrawn and resolved entry', () => {
  const h = harness(), base = { id: 'AFTER-ONE', type: 'refund', createdAt: '2026-11-01T03:00:00.000Z', updatedAt: '2026-11-01T03:10:00.000Z', description: '<img src=x>' };
  const html = h.afterHistory({ afterSaleHistory: [{ ...base, status: 'submitted' }, { ...base, status: 'withdrawn' }, { ...base, status: 'resolved', merchantReply: '模拟处理完成' }] });
  assert.equal((html.match(/<li>/g) || []).length, 3); assert.ok(!html.includes('<img src=x>'));
  assert.match(html, /&lt;img src=x&gt;/); assert.match(html, /已撤回/); assert.match(html, /模拟处理完成/);
});

test('a failed cloud write preserves its original order and draft without reporting success or using local storage', async () => {
  const h = harness(); await h.boot(); h.openDrawer('order', 'DEMO-ADMIN-UI');
  h.state.drawer.note = '等待保存的商家备注';
  h.behavior.mutate = async () => { const error = new Error('云端数据库暂时不可用'); error.status = 503; throw error; };
  await h.saveCloudOrderForm({ id: 'order-note-form', values: { note: h.state.drawer.note } });
  assert.equal(h.state.orders[0].merchantNote, undefined); assert.equal(h.state.orders[0].version, 1);
  assert.equal(h.state.drawer.note, '等待保存的商家备注'); assert.equal(h.state.drawer.expectedVersion, 1);
  assert.match(h.state.drawer.error, /云端数据库暂时不可用/);
  assert.deepEqual(h.writes, []);
});

test('an account change discovered during a write clears the previous account data', async () => {
  const h = harness(); await h.boot(); h.openDrawer('order', 'DEMO-ADMIN-UI');
  h.behavior.mutate = async () => { const error = new Error('登录账户已变化'); error.status = 409; error.code = 'account_changed'; throw error; };
  await h.saveCloudOrderForm({ id: 'order-note-form', values: { note: '待保存' } });
  assert.equal(h.state.orders.length, 0); assert.equal(h.state.drawer, null); assert.equal(h.state.accountId, null);
  assert.equal(h.nodes.get('#admin-nav').hidden, true);
});

test('a delayed refresh cannot downgrade an order after a newer cloud write succeeds', async () => {
  const h = harness(); await h.boot();
  let finishRead;
  h.behavior.list = () => new Promise(resolve => { finishRead = resolve; });
  const pendingRefresh = h.refreshRemote({ manual: true });
  // Allow the session and catalog awaits to reach the delayed order request.
  for (let i = 0; i < 8 && !finishRead; i++) await Promise.resolve();
  assert.ok(finishRead);
  h.openDrawer('order', 'DEMO-ADMIN-UI');
  h.behavior.mutate = async () => ({ ...original(), version: 2, merchantNote: '已经保存的备注', updatedAt: '2026-11-01T03:11:00.000Z' });
  await h.saveCloudOrderForm({ id: 'order-note-form', values: { note: '已经保存的备注' } });
  finishRead({ orders: [original()], lastSyncedAt: '2026-11-01T03:10:00.000Z' });
  await pendingRefresh;
  assert.equal(h.state.orders[0].version, 2); assert.equal(h.state.orders[0].merchantNote, '已经保存的备注');
  assert.equal(h.state.drawer.expectedVersion, 2);
});

test('the explicit static local mode retains example orders and local note saving', async () => {
  const h = harness(), data = new Map(); h.cloud.mode = 'local'; h.cloud.session = null;
  h.context.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  await h.boot();
  assert.equal(h.state.orders.length, 3); assert.equal(h.calls.length, 0);
  const id = h.state.orders[0].id; h.openDrawer('order', id);
  await h.handlers.submit({ preventDefault() {}, target: { id: 'order-note-form', values: { note: '本机演示备注' } } });
  assert.equal(h.state.orders.find(order => order.id === id).merchantNote, '本机演示备注');
  assert.equal(h.state.drawer.order.merchantNote, '本机演示备注');
  assert.equal(JSON.parse(data.get(model.STORAGE_KEY)).find(order => order.id === id).merchantNote, '本机演示备注');
});

test('switching to a second manager removes the first account DOM before the new catalog resolves or fails', async () => {
  const h = harness(); await h.boot();
  h.state.products = [{ id: 'private-product-account-a', name: '甲账号私有草稿' }];
  h.nodes.get('#admin-app').innerHTML = '<div>DEMO-PRIVATE-ACCOUNT-A 甲账号私有草稿</div>';
  h.openDrawer('order', 'DEMO-ADMIN-UI');
  let rejectCatalog;
  h.behavior.initialize = async () => { h.cloud.session = { user: { id: 'admin-b' }, role: 'admin', canManage: true }; };
  h.behavior.catalog = () => new Promise((resolve, reject) => { rejectCatalog = reject; });
  const pending = h.refreshRemote({ manual: true });
  for (let i = 0; i < 8 && !rejectCatalog; i++) await Promise.resolve();
  assert.ok(rejectCatalog);
  assert.equal(h.state.products.length, 0); assert.equal(h.state.orders.length, 0); assert.equal(h.state.drawer, null);
  assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('DEMO-PRIVATE-ACCOUNT-A'));
  assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('甲账号私有草稿'));
  assert.equal(h.nodes.get('#admin-nav').hidden, true);
  rejectCatalog(new Error('新账号云端目录暂不可用'));
  await pending;
  assert.equal(h.state.products.length, 0); assert.equal(h.state.orders.length, 0); assert.equal(h.state.ready, false);
  assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('甲账号私有草稿'));
  assert.match(h.nodes.get('#admin-app').innerHTML, /新账号云端目录暂不可用/);
});

test('downgrading the same account from admin to merchant clears global records before its new scope loads or fails', async () => {
  const h = harness(); await h.boot();
  assert.equal(h.state.accessRole, 'admin');
  h.state.products = [{ id: 'another-merchant-draft', name: '其他商家私有草稿' }];
  h.nodes.get('#admin-app').innerHTML = '<div>DEMO-GLOBAL-ADMIN-ORDER 其他商家私有草稿</div>';
  h.openDrawer('order', 'DEMO-ADMIN-UI');
  let rejectCatalog;
  h.behavior.initialize = async () => { h.cloud.session = { user: { id: 'admin-one' }, role: 'merchant', canManage: true }; };
  h.behavior.catalog = () => new Promise((resolve, reject) => { rejectCatalog = reject; });
  const pending = h.refreshRemote({ manual: true });
  for (let i = 0; i < 8 && !rejectCatalog; i++) await Promise.resolve();
  assert.ok(rejectCatalog);
  assert.equal(h.state.accountId, 'admin-one'); assert.equal(h.state.accessRole, 'merchant');
  assert.equal(h.state.products.length, 0); assert.equal(h.state.orders.length, 0); assert.equal(h.state.drawer, null);
  assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('DEMO-GLOBAL-ADMIN-ORDER'));
  assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('其他商家私有草稿'));
  rejectCatalog(Object.assign(new Error('商家权限目录暂不可用'), { status: 503 }));
  await pending;
  assert.equal(h.state.products.length, 0); assert.equal(h.state.orders.length, 0); assert.equal(h.state.ready, false);
  assert.equal(h.state.accountId, null); assert.equal(h.state.accessRole, null);
  assert.equal(h.nodes.get('#admin-nav').hidden, true);
  assert.match(h.nodes.get('#admin-app').innerHTML, /商家权限目录暂不可用/);
  assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('其他商家私有草稿'));
});
