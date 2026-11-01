import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as model from '../public/model.js';

// Run the actual event handlers without opening or controlling a browser.
const source = (await readFile(new URL('../public/admin.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/\nboot\(\);\s*$/, '\n')
  + '\nglobalThis.subject = { state, boot, loadData, readOrders, writeOrders, openDrawer, renderDrawer, refreshRemote, reloadDrawer, saveCloudOrderForm, afterHistory, changeView, merchantEditorFrom, merchantEditorPage, merchantsPage, merchantAuditPage, saveMerchantForm, reloadMerchantEditor, fillMerchantTemplate, openMerchantAudit, render, scopeValid, inventoryPage, inventoryEditorPage, openInventoryEditor, fillInventoryTemplate, saveInventoryForm, reloadInventoryEditor, openInventoryHistory, inventoryHistoryPage, stockReleaseNotice };';
const copy = value => JSON.parse(JSON.stringify(value));
const original = () => ({ ...model.createOrder({ productId: 'jingtai-apple', variant: 'small', quantity: 1, address: 'gansu' }, 'DEMO-ADMIN-UI', '2026-11-01T03:00:00.000Z'), version: 1, updatedAt: '2026-11-01T03:00:00.000Z' });

function harness() {
  const nodes = new Map(), handlers = {}, writes = [], calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], querySelector: () => node('nested'), focus() {}, dataset: {} });
    return nodes.get(id);
  };
  const cloud = { mode: 'cloud', session: { user: { id: 'admin-one', name: '测试运营' }, role: 'admin', canManage: true }, lastSyncedAt: '2026-11-01T03:00:00.000Z' };
  const behavior = { orders: [original()], confirm: true, initialize: async () => {}, mutate: async () => { throw new Error('Specify mutation in the test'); }, single: async () => behavior.orders[0], inventories: [], inventoryHistory: [], saveInventory: async (productId,input)=>({...input,productId,configured:true,batchId:'BATCH-ONE',version:1,updatedAt:'2026-11-01T03:00:00.000Z'}), merchants: [], saveMerchant: async input => ({...input,id:'MERCHANT-ONE',version:1,bound:false}), audit: [] };
  const context = vm.createContext({
    ...model,
    document: { querySelector: node, querySelectorAll: () => [], addEventListener: (name, callback) => { handlers[name] = callback; }, body: node('body'), activeElement: node('focus') },
    window: { addEventListener() {}, scrollTo() {}, confirm: () => behavior.confirm },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    localStorage: { getItem() { writes.push('read'); throw new Error('Cloud UI read local storage'); }, setItem() { writes.push('write'); throw new Error('Cloud UI wrote local storage'); } },
    FormData: class { constructor(form) { this.values = form.values || {}; } get(key) { return this.values[key] ?? null; } has(key) { return Object.hasOwn(this.values, key); } },
    getCloudState: () => cloud, isCloudMode: () => cloud.mode === 'cloud',
    hasPermission: name => cloud.mode === 'local' || cloud.session?.role === 'admin' || (cloud.session?.canManage === true && cloud.session?.merchant?.status !== 'disabled' && cloud.session?.permissions?.includes(name) === true),
    managementScopeKey: () => JSON.stringify([cloud.mode,cloud.session?.user?.id,cloud.session?.role,cloud.session?.canManage,[...(cloud.session?.permissions || [])].sort(),cloud.session?.merchant?.id,cloud.session?.merchant?.status,cloud.session?.merchant?.version]),
    loadInventories: async options => { calls.push({method:'inventory',options}); return behavior.loadInventories ? await behavior.loadInventories(options) : {inventories:copy(behavior.inventories)}; },
    saveInventory: async (productId,input,options) => { calls.push({method:'save-inventory',productId,input:copy(input),options:copy(options)}); return await behavior.saveInventory(productId,input,options); },
    loadInventoryHistory: async productId => { calls.push({method:'inventory-history',productId}); return behavior.loadInventoryHistory ? await behavior.loadInventoryHistory(productId) : copy(behavior.inventoryHistory); },
    loadMerchants: async () => { calls.push({method:'merchants'}); return {merchants:copy(behavior.merchants)}; },
    loadMerchant: async id => { calls.push({method:'merchant',id}); return behavior.loadMerchant ? await behavior.loadMerchant(id) : copy(behavior.merchants.find(item => item.id === id)); },
    saveMerchant: async (input,options) => { calls.push({method:'save-merchant',input:copy(input),options:copy(options)}); return await behavior.saveMerchant(input,options); },
    loadMerchantAudit: async id => { calls.push({method:'audit',id}); return behavior.loadAudit ? await behavior.loadAudit(id) : copy(behavior.audit); },
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
  h.behavior.initialize = async () => { h.cloud.session = { user: { id: 'admin-one' }, role: 'merchant', canManage: true, permissions:['products','orders','aftersales'] }; };
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

const merchantRecord = (changes = {}) => ({ id: 'MERCHANT-ONE', name: '景泰采购员', region: '甘肃景泰', email: 'jingtai@example.test', permissions: ['products','orders','aftersales'], status: 'enabled', bound: false, version: 1, createdAt:'2026-11-01T03:00:00.000Z',updatedAt:'2026-11-01T03:00:00.000Z', ...changes });
const merchantSession = (permissions, changes = {}) => ({ user: {id:'purchaser-one',name:'景泰采购员'},role:'merchant',canManage:permissions.length > 0,permissions,merchant:merchantRecord({bound:true}),...changes });
const click = (h, dataset) => h.handlers.click({target:{closest:() => ({dataset,disabled:false})}});
const merchantForm = values => ({id:'merchant-form',values:{name:'景泰采购员',email:'jingtai@example.test',region:'甘肃景泰',status:'enabled','permission-products':'on',...values}});

test('merchant templates fill the real editor without saving; only the explicit form submit writes cloud data', async () => {
  const h=harness(); await h.boot();
  await click(h,{action:'new-merchant'}); await click(h,{action:'merchant-template',template:'dingbian'});
  assert.equal(h.state.merchantEditor.values.name,'定边采购员');
  assert.match(h.state.merchantEditor.values.email,/@example\.test$/);
  assert.equal(h.calls.filter(call=>call.method==='save-merchant').length,0);
  assert.match(h.nodes.get('#admin-app').innerHTML,/不创建 ChatGPT 账户/);
  await h.handlers.submit({preventDefault(){},target:merchantForm({name:'定边采购员',email:'dingbian-buyer@example.test',region:'陕西定边','permission-aftersales':'on'})});
  const call=h.calls.find(call=>call.method==='save-merchant');
  assert.equal(call.input.name,'定边采购员'); assert.deepEqual(call.input.permissions,['products','aftersales']);
  assert.equal(h.state.merchantEditor,null); assert.equal(h.state.merchants.length,1); assert.deepEqual(h.writes,[]);
});

test('editing a bound merchant preserves its immutable email and requires confirmation before disabling', async () => {
  const h=harness(); h.behavior.merchants=[merchantRecord({bound:true})]; await h.boot();
  await click(h,{action:'edit-merchant',id:'MERCHANT-ONE'});
  assert.match(h.nodes.get('#admin-app').innerHTML,/readonly aria-readonly="true"/);
  h.behavior.confirm=false;
  await h.saveMerchantForm(merchantForm({email:'different@example.test',status:'disabled'}));
  assert.equal(h.calls.filter(call=>call.method==='save-merchant').length,0);
  assert.equal(h.state.merchantEditor.values.status,'disabled');
  h.behavior.confirm=true; await h.saveMerchantForm(merchantForm({email:'different@example.test',status:'disabled'}));
  const call=h.calls.find(call=>call.method==='save-merchant');
  assert.equal(call.input.email,'jingtai@example.test'); assert.equal(call.input.status,'disabled'); assert.equal(call.options.expectedVersion,1);
});

test('merchant conflict preserves draft and blocks repeated save until explicit confirmed reload', async () => {
  const h=harness(); h.behavior.merchants=[merchantRecord()]; await h.boot();
  await click(h,{action:'edit-merchant',id:'MERCHANT-ONE'});
  h.behavior.saveMerchant=async()=>{throw Object.assign(new Error('版本发生变化'),{status:409});};
  await h.saveMerchantForm(merchantForm({name:'保留我的填写'}));
  assert.equal(h.state.merchantEditor.values.name,'保留我的填写'); assert.equal(h.state.merchantEditor.conflict,true);
  assert.match(h.nodes.get('#admin-app').innerHTML,/放弃当前填写并重新读取/);
  await h.saveMerchantForm(merchantForm({name:'保留我的填写'})); assert.equal(h.calls.filter(call=>call.method==='save-merchant').length,1);
  h.behavior.loadMerchant=async()=>merchantRecord({version:2,name:'另一设备的名字'});
  h.behavior.confirm=false; await h.reloadMerchantEditor(); assert.equal(h.state.merchantEditor.values.name,'保留我的填写');
  h.behavior.confirm=true; await h.reloadMerchantEditor(); assert.equal(h.state.merchantEditor.expectedVersion,2); assert.equal(h.state.merchantEditor.conflict,false); assert.equal(h.state.merchantEditor.values.name,'另一设备的名字');
});

test('merchant account list, filters and audit escape all user-provided text', async () => {
  const h=harness(); h.behavior.merchants=[merchantRecord({name:'<img src=x>',region:'"><img src=x onerror=alert(1)>',email:'a&b@example.test'})];
  h.behavior.audit=[{id:'EVENT-ONE',action:'updated',createdAt:'2026-11-01T03:00:00.000Z',actorName:'<script>bad</script>',before:merchantRecord(),after:merchantRecord({name:'<b>hello</b>'})}];
  await h.boot(); h.changeView('merchants');
  const html=h.nodes.get('#admin-app').innerHTML;
  assert.ok(!html.includes('<img src=x>')); assert.match(html,/&lt;img src=x&gt;/); assert.match(html,/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/); assert.ok(!html.includes('<img src=x onerror='));
  await h.handlers.submit({preventDefault(){},target:{id:'search-merchants',values:{query:'none'}}}); assert.match(h.nodes.get('#admin-app').innerHTML,/还没有符合条件的商家/);
  h.state.merchantFilter.query=''; await click(h,{action:'audit-merchant',id:'MERCHANT-ONE'});
  assert.match(h.nodes.get('#admin-app').innerHTML,/&lt;script&gt;bad&lt;\/script&gt;/); assert.match(h.nodes.get('#admin-app').innerHTML,/&lt;b&gt;hello&lt;\/b&gt;/); assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('<script>'));
});

test('a products-only purchaser never loads private orders or merchants and cannot open unauthorized views', async () => {
  const h=harness(); h.cloud.session=merchantSession(['products']); await h.boot();
  assert.equal(h.calls.filter(call=>['list','merchants'].includes(call.method)).length,0); assert.equal(h.state.orders.length,0);
  const html=h.nodes.get('#admin-app').innerHTML; assert.ok(!html.includes('DEMO-ADMIN-UI')); assert.ok(!html.includes('待处理售后')); assert.ok(!html.includes('最近的订单'));
  h.changeView('orders'); assert.equal(h.state.view,'overview');
  await click(h,{action:'new-merchant'}); assert.equal(h.state.merchantEditor,null);
});

test('an aftersales-only purchaser reads only its returned cases and has no order editing or catalog access', async () => {
  const h=harness(); let catalogCalls=0; h.behavior.catalog=async()=>{catalogCalls++;};
  const order={...model.createAfterSale(original(),{type:'refund',reason:'damaged',description:'模拟品质问题',hasEvidence:false},'AFTER-UI'),version:2};
  h.behavior.orders=[order]; h.cloud.session=merchantSession(['aftersales']); await h.boot();
  assert.equal(catalogCalls,0); assert.equal(h.state.products.length,0); assert.equal(h.calls.filter(call=>call.method==='list').length,1);
  h.changeView('orders'); assert.equal(h.state.view,'overview'); h.openDrawer('order',order.id); assert.equal(h.state.drawer,null);
  h.openDrawer('after',order.id); const html=h.nodes.get('#drawer-root').innerHTML;
  assert.match(html,/id="resolve-form"/); assert.ok(!html.includes('id="ship-form"')); assert.ok(!html.includes('id="order-note-form"')); assert.ok(!html.includes('返回订单详情'));
  await h.saveCloudOrderForm({id:'ship-form',values:{carrier:'物流',tracking:'DEMO-NO'}}); assert.equal(h.calls.filter(call=>call.method==='mutation').length,0);
});

test('an orders-only purchaser may ship and note but cannot open or resolve aftersale forms', async () => {
  const h=harness(); h.cloud.session=merchantSession(['orders']); await h.boot();
  h.openDrawer('order','DEMO-ADMIN-UI'); assert.match(h.nodes.get('#drawer-root').innerHTML,/id="order-note-form"/);
  h.openDrawer('after','DEMO-ADMIN-UI'); assert.equal(h.state.drawer.type,'order');
  await h.saveCloudOrderForm({id:'resolve-form',values:{reply:'不能提交'}}); assert.equal(h.calls.filter(call=>call.method==='mutation').length,0);
  h.behavior.mutate=async()=>({...original(),version:2,merchantNote:'授权备注'});
  await h.saveCloudOrderForm({id:'order-note-form',values:{note:'授权备注'}}); assert.equal(h.state.orders[0].merchantNote,'授权备注');
});

test('missing or empty merchant permissions and disabled merchant status fail closed', async () => {
  for(const session of [merchantSession([]),merchantSession(['products'],{permissions:undefined}),merchantSession(['products'],{merchant:merchantRecord({status:'disabled'})})]) {
    const h=harness(); h.cloud.session=session; await h.boot();
    assert.equal(h.calls.length,0); assert.equal(h.state.products.length,0); assert.equal(h.state.orders.length,0); assert.equal(h.nodes.get('#admin-nav').hidden,true);
  }
});

test('same merchant permission or version changes clear old DOM before awaiting the narrowed scope', async () => {
  for (const change of ['permissions','version']) {
    const h=harness(); h.cloud.session=merchantSession(['products','orders','aftersales']); await h.boot();
    h.nodes.get('#admin-app').innerHTML='PRIVATE-OLD-SCOPE'; h.openDrawer('order','DEMO-ADMIN-UI');
    let finishCatalog; h.behavior.catalog=()=>new Promise(resolve=>{finishCatalog=resolve;});
    h.behavior.initialize=async()=>{ if(change==='permissions') h.cloud.session.permissions=['products']; else h.cloud.session.merchant.version=2; };
    const pending=h.refreshRemote({manual:true}); for(let i=0;i<10&&!finishCatalog;i++) await Promise.resolve();
    assert.ok(finishCatalog); assert.equal(h.state.orders.length,0); assert.equal(h.state.drawer,null); assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('PRIVATE-OLD-SCOPE')); assert.equal(h.nodes.get('#admin-nav').hidden,true);
    finishCatalog(); await pending;
  }
});

test('late order and merchant save responses cannot restore data after management scope changes', async () => {
  const h=harness(); await h.boot(); let finishRead;
  h.behavior.list=()=>new Promise(resolve=>{finishRead=resolve;});
  const pending=h.refreshRemote({manual:true}); for(let i=0;i<10&&!finishRead;i++) await Promise.resolve(); assert.ok(finishRead);
  h.cloud.session=merchantSession(['products']); h.render();
  finishRead({orders:[original()],lastSyncedAt:'2026-11-01T03:10:00.000Z'}); await pending;
  assert.equal(h.state.orders.length,0); assert.equal(h.state.merchants.length,0); assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('DEMO-ADMIN-UI'));
  const a=harness(); await a.boot(); await click(a,{action:'new-merchant'}); let finishSave;
  a.behavior.saveMerchant=()=>new Promise(resolve=>{finishSave=resolve;}); const saved=a.saveMerchantForm(merchantForm()); assert.ok(finishSave);
  a.cloud.session=merchantSession(['products']); a.render(); finishSave(merchantRecord()); await saved;
  assert.equal(a.state.merchants.length,0); assert.equal(a.state.merchantEditor,null); assert.ok(!a.nodes.get('#admin-app').innerHTML.includes('jingtai@example.test'));
});

test('local merchant page explains cloud login and cannot create or pretend to bind accounts', async () => {
  const h=harness(),data=new Map(); h.cloud.mode='local'; h.cloud.session=null;
  h.context.localStorage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}; await h.boot();
  h.changeView('merchants'); assert.match(h.nodes.get('#admin-app').innerHTML,/需要云端管理员登录/);
  await click(h,{action:'new-merchant'}); assert.equal(h.state.merchantEditor,null); assert.equal(h.calls.length,0);
});

test('a duplicate email while creating a merchant remains editable and can be corrected without a reload', async () => {
  const h=harness(); await h.boot(); await click(h,{action:'new-merchant'});
  h.behavior.saveMerchant=async()=>{throw Object.assign(new Error('该登录邮箱已存在商家档案'),{status:409,code:'merchant_duplicate'});};
  await h.saveMerchantForm(merchantForm()); assert.equal(h.state.merchantEditor.conflict,false); assert.match(h.state.merchantEditor.error,/邮箱已存在/);
  h.behavior.saveMerchant=async input=>merchantRecord(input); await h.saveMerchantForm(merchantForm({email:'another@example.test'}));
  assert.equal(h.state.merchantEditor,null); assert.equal(h.state.merchants[0].email,'another@example.test');
});

const inventoryRecord=(changes={})=>({productId:'jingtai-apple',configured:true,stocks:{small:20,family:12},batchId:'BATCH-ONE',batchCode:'DEMO-APPLE-ONE',harvestDate:'2026-11-01',note:'模拟采收说明',version:1,updatedAt:'2026-11-01T03:00:00.000Z',...changes});
const inventoryForm=values=>({id:'inventory-form',values:{small:'20',family:'12',batchCode:'DEMO-APPLE-ONE',harvestDate:'2026-11-01',note:'模拟批次',reason:'核实后调整模拟库存',...values}});

test('inventory view shows unconfigured counts and template only fills until explicit versioned save',async()=>{
  const h=harness();await h.boot();h.changeView('inventory');
  assert.match(h.nodes.get('#admin-app').innerHTML,/未设置库存/);assert.match(h.nodes.get('#admin-app').innerHTML,/设置库存/);
  await click(h,{action:'edit-inventory',id:'jingtai-apple'});assert.equal(h.state.inventoryEditor.expectedVersion,0);assert.equal(h.state.inventoryEditor.values.small,'0');
  await click(h,{action:'inventory-template'});assert.equal(h.state.inventoryEditor.values.small,'20');assert.equal(h.state.inventoryEditor.values.family,'12');assert.match(h.state.inventoryEditor.values.batchCode,/^DEMO-/);
  assert.equal(h.calls.filter(call=>call.method==='save-inventory').length,0);
  await h.handlers.submit({preventDefault(){},target:inventoryForm()});
  const call=h.calls.find(call=>call.method==='save-inventory');assert.equal(call.options.expectedVersion,0);assert.equal(call.productId,'jingtai-apple');assert.equal(call.input.stocks.small,20);assert.equal(h.state.inventoryEditor,null);assert.equal(h.state.inventories[0].version,1);assert.deepEqual(h.writes,[]);
});

test('inventory editor validates integer counts, dates and required reasons before requesting a save',async()=>{
  for(const values of [{small:'-1'},{family:'1.2'},{small:'1000000'},{small:''},{harvestDate:'2026-02-30'},{reason:''},{batchCode:''}]) {
    const h=harness();await h.boot();h.openInventoryEditor('jingtai-apple');await h.saveInventoryForm(inventoryForm(values));
    assert.equal(h.calls.filter(call=>call.method==='save-inventory').length,0);assert.ok(h.state.inventoryEditor.error);
  }
});

test('changing a configured batch requires confirmation while same-batch quantity adjustment does not',async()=>{
  const h=harness();h.behavior.inventories=[inventoryRecord()];await h.boot();h.openInventoryEditor('jingtai-apple');h.behavior.confirm=false;
  await h.saveInventoryForm(inventoryForm({batchCode:'DEMO-APPLE-TWO'}));assert.equal(h.calls.filter(call=>call.method==='save-inventory').length,0);
  await h.saveInventoryForm(inventoryForm({small:'19'}));assert.equal(h.calls.filter(call=>call.method==='save-inventory').length,1);assert.equal(h.state.inventoryEditor,null);
});

test('inventory conflict retains the original version and draft until a confirmed fresh read',async()=>{
  const h=harness();h.behavior.inventories=[inventoryRecord()];await h.boot();h.openInventoryEditor('jingtai-apple');
  h.behavior.saveInventory=async()=>{throw Object.assign(new Error('库存发生变化'),{status:409,code:'version_conflict'});};
  await h.saveInventoryForm(inventoryForm({small:'18',reason:'保留填写'}));assert.equal(h.state.inventoryEditor.conflict,true);assert.equal(h.state.inventoryEditor.values.small,'18');assert.equal(h.state.inventoryEditor.expectedVersion,1);
  await h.saveInventoryForm(inventoryForm());assert.equal(h.calls.filter(call=>call.method==='save-inventory').length,1);
  h.behavior.inventories=[inventoryRecord({version:2,stocks:{small:17,family:12}})];h.behavior.confirm=false;await h.reloadInventoryEditor();assert.equal(h.state.inventoryEditor.values.small,'18');
  h.behavior.confirm=true;await h.reloadInventoryEditor();assert.equal(h.state.inventoryEditor.expectedVersion,2);assert.equal(h.state.inventoryEditor.values.small,'17');assert.equal(h.state.inventoryEditor.conflict,false);
});

test('orders-only and aftersales-only purchasers cannot read or open inventory management',async()=>{
  for(const permissions of [['orders'],['aftersales']]) {
    const h=harness();h.cloud.session=merchantSession(permissions);await h.boot();h.changeView('inventory');assert.equal(h.state.view,'overview');
    await click(h,{action:'edit-inventory',id:'jingtai-apple'});await click(h,{action:'inventory-history',id:'jingtai-apple'});assert.equal(h.state.inventoryEditor,null);assert.equal(h.calls.filter(call=>call.method.startsWith('inventory')).length,0);
  }
});

test('inventory list filters and history escape batch, reason and actor data including review warnings',async()=>{
  const h=harness();h.behavior.inventories=[inventoryRecord({batchCode:'<img src=x>',stocks:{small:2,family:0}})];
  h.behavior.inventoryHistory=[{id:'EVENT-ONE',action:'release_review',createdAt:'2026-11-01T03:00:00.000Z',actorName:'<b>actor</b>',reason:'<script>bad</script>',orderId:'ORDER-ONE',before:inventoryRecord(),after:inventoryRecord()}];
  await h.boot();h.changeView('inventory');assert.match(h.nodes.get('#admin-app').innerHTML,/&lt;img src=x&gt;/);assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('<img src=x>'));
  h.state.inventoryFilter.status='low';h.render();assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('data-id="jingtai-apple"'));
  h.state.inventoryFilter.status='empty';h.render();assert.ok(h.nodes.get('#admin-app').innerHTML.includes('data-id="jingtai-apple"'));
  await click(h,{action:'inventory-history',id:'jingtai-apple'});const html=h.nodes.get('#admin-app').innerHTML;
  assert.match(html,/旧批次取消/);assert.match(html,/没有自动增加新批次库存/);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.ok(!html.includes('<b>actor</b>'));
});

test('late inventory reads, saves and history cannot restore a revoked product permission',async()=>{
  for(const operation of ['read','save','history']) {
    const h=harness();h.behavior.inventories=[inventoryRecord()];await h.boot();let finish,pending;
    if(operation==='read'){h.behavior.loadInventories=()=>new Promise(resolve=>{finish=resolve;});pending=h.refreshRemote();}
    else if(operation==='save'){h.openInventoryEditor('jingtai-apple');h.behavior.saveInventory=()=>new Promise(resolve=>{finish=resolve;});pending=h.saveInventoryForm(inventoryForm());}
    else {h.behavior.loadInventoryHistory=()=>new Promise(resolve=>{finish=resolve;});pending=h.openInventoryHistory('jingtai-apple');}
    for(let i=0;i<30&&!finish;i++)await Promise.resolve();assert.ok(finish);
    h.cloud.session=merchantSession(['orders']);h.render();finish(operation==='read'?{inventories:[inventoryRecord()]}:operation==='save'?inventoryRecord({version:2}):[]);await pending;
    assert.equal(h.state.inventories.length,0);assert.equal(h.state.inventoryEditor,null);assert.equal(h.state.inventoryHistory,null);assert.ok(!h.nodes.get('#admin-app').innerHTML.includes('DEMO-APPLE-ONE'));
  }
});

test('delayed inventory reads cannot downgrade a successful newer version',async()=>{
  const h=harness();h.behavior.inventories=[inventoryRecord()];await h.boot();let finish;h.behavior.loadInventories=()=>new Promise(resolve=>{finish=resolve;});const pending=h.refreshRemote();
  for(let i=0;i<30&&!finish;i++)await Promise.resolve();assert.ok(finish);
  h.openInventoryEditor('jingtai-apple');h.behavior.saveInventory=async()=>inventoryRecord({version:2,stocks:{small:18,family:12}});await h.saveInventoryForm(inventoryForm({small:'18'}));
  finish({inventories:[inventoryRecord()]});await pending;assert.equal(h.state.inventories[0].version,2);assert.equal(h.state.inventories[0].stocks.small,18);
});

test('local inventory page explains its cloud boundary and never fabricates a saved inventory',async()=>{
  const h=harness(),data=new Map();h.cloud.mode='local';h.cloud.session=null;h.context.localStorage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  await h.boot();h.changeView('inventory');assert.match(h.nodes.get('#admin-app').innerHTML,/库存管理需要连接云端/);await click(h,{action:'edit-inventory',id:'jingtai-apple'});assert.equal(h.state.inventoryEditor,null);assert.equal(h.calls.length,0);
});

test('order cancellation release notices preserve the review message while escaping its text',()=>{
  const h=harness(),html=h.stockReleaseNotice({stockRelease:{status:'review',message:'旧批次 <script>bad</script> 需要核对'}});
  assert.match(html,/需要核对旧批次/);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.ok(!html.includes('<script>bad</script>'));
});
