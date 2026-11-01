import test from 'node:test';
import assert from 'node:assert/strict';
import { createJourney } from '../public/journey.js';
import { esc } from '../public/ui.js';

const copy = value => structuredClone(value);
const decodeEntities = value => String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const item = (id, name, category, extra = {}) => ({ id, name, category, status: 'published', subtitle: `${name}介绍`, origin: '甘肃景泰（模拟）', tags: [], variants: [{ id: 'small' }, { id: 'family' }], ...extra });

function fixture() {
  return {
    catalog: [item('apple', '景泰苹果', 'fruit'), item('goji', '景泰枸杞', 'dried'), item('potato', '外地土豆', 'vegetable', { origin: '其他产区（模拟）' }), item('draft', '未发布草稿', 'fruit', { status: 'draft' }), item('offline', '已下架商品', 'fruit', { status: 'offline' })],
    directory: {
      ready: true, error: '',
      regions: [
        { id: 'gansu-jingtai', name: '甘肃 · 景泰', province: '甘肃', subtitle: '黄河边的家乡味', description: '从苹果到田间蔬菜，慢慢认识景泰。', image: 'assets/orchard.jpg', preview: false, productIds: ['apple', 'goji', 'draft', 'offline'], shopIds: ['north'] },
        { id: 'shaanxi-dingbian', name: '陕西 · 定边', province: '陕西', subtitle: '筹备中的地方', description: '定边筹备示意，尚无采购合作。', image: 'assets/orchard.jpg', preview: true, productIds: [], shopIds: ['preview'] },
        { id: 'another-place', name: '其他产区', province: '其他', subtitle: '另一个地方', description: '其他产区介绍。', image: 'assets/potato.jpg', preview: false, productIds: ['potato'], shopIds: ['south'] }
      ],
      shops: [
        { id: 'north', name: '景泰示范店', procurementName: '景泰采购者', regionIds: ['gansu-jingtai'], regionLabel: '甘肃景泰', description: '景泰采购者的模拟简介。', image: 'assets/orchard.jpg', preview: false, simulation: true, productIds: ['apple', 'goji', 'draft', 'offline'] },
        { id: 'preview', name: '定边筹备店', procurementName: '采购者待补充', regionIds: ['shaanxi-dingbian'], regionLabel: '陕西定边', description: '定边店铺筹备示意。', image: 'assets/orchard.jpg', preview: true, simulation: true, productIds: [] },
        { id: 'south', name: '另一家示范店', procurementName: '其他采购者', regionIds: ['another-place'], regionLabel: '其他产区', description: '另一位采购者的模拟简介。', image: 'assets/potato.jpg', preview: false, simulation: true, productIds: ['potato'] }
      ]
    }
  };
}

// A deliberately small DOM adapter: it consumes the real rendered buttons and
// form controls, then dispatches their data attributes through the real handlers.
class JourneyDOM {
  constructor(data = fixture()) {
    this.data = data;
    this.path = 'home';
    this.renders = 0;
    this.stockCalls = [];
    this.videoCalls = [];
    this.backs = new Map();
    this.available = new Set(['apple:family', 'potato:small']);
    this.videos = new Set();
    this.journey = createJourney({
      catalog: () => this.data.catalog,
      getStorefrontState: () => copy(this.data.directory),
      availability: (product, variant) => { this.stockCalls.push(`${product.id}:${variant}`); return { available: this.available.has(`${product.id}:${variant}`), message: '' }; },
      productCard: product => `<button class="fixture-product" data-action="view-product" data-product="${esc(product.id)}"><h3>${esc(product.name)}</h3></button>`,
      title: (name, back) => `<header><button data-action="navigate" data-route="${esc(back)}">返回</button><h1>${esc(name)}</h1></header>`,
      backRoute: (type, id, fallback) => this.backs.get(`${type}/${id}`) || fallback,
      videoFor: product => this.videos.has(product.id) ? `media/${product.id}.mp4` : '',
      videoBlock: product => { this.videoCalls.push(product.id); return this.videos.has(product.id) ? `<video aria-label="${esc(product.name)}采收素材"></video>` : '<p class="harvest-placeholder">采收视频待补充</p>'; },
      nav: path => this.open(path),
      render: () => { this.renders++; this.draw(); }
    });
    this.draw();
  }
  open(path) {
    this.path = path;
    const [page, rawId] = path.split('/');
    this.journey.beforeRender(page, rawId === undefined ? undefined : decodeURIComponent(rawId));
    this.draw();
  }
  draw() {
    const [page, rawId] = this.path.split('/');
    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
    const render = page === 'home' ? this.journey.home : this.journey.routes[page];
    this.html = render ? render(id) : '';
  }
  buttons() {
    return [...this.html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decodeEntities(value)]));
      const dataset = Object.fromEntries(Object.entries(attrs).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
      return { attrs, dataset, text: decodeEntities(match[2].replace(/<[^>]*>/g, '')) };
    });
  }
  click(predicate) {
    const button = this.buttons().find(predicate);
    assert.ok(button, 'rendered button exists');
    const consumed = this.journey.handleClick(button.dataset);
    if (!consumed && button.dataset.action === 'navigate') this.open(button.dataset.route);
    return button;
  }
  submit(value) {
    assert.match(this.html, /id="journey-search"/);
    let prevented = false;
    const consumed = this.journey.handleSubmit({ target: { id: 'journey-search', elements: { namedItem: name => name === 'keyword' ? { value } : null } }, preventDefault: () => { prevented = true; } });
    assert.equal(consumed, true);
    assert.equal(prevented, true);
  }
  productIds() { return this.buttons().filter(button => button.attrs.class === 'fixture-product').map(button => button.dataset.product); }
}

test('home leads to distinct regions, procurement shops and harvest content without fabricated trust claims', () => {
  const ui = new JourneyDOM();
  assert.match(ui.html, /从景泰出发/);
  for (const route of ['regions', 'shops', 'origin', 'specialties']) assert.ok(ui.buttons().some(button => button.dataset.route === route));
  assert.deepEqual(ui.productIds(), ['apple', 'goji', 'potato']);
  assert.doesNotMatch(ui.html, /未发布草稿|已下架商品|销量|评分|认证|包邮|保证新鲜/);
  ui.click(button => button.dataset.route === 'regions');
  assert.equal(ui.path, 'regions');
  ui.click(button => button.dataset.route === 'region/gansu-jingtai');
  assert.match(ui.html, /从苹果到田间蔬菜/);
  ui.click(button => button.dataset.route === 'shop/north');
  assert.equal(ui.path, 'shop/north');
  assert.deepEqual(ui.productIds(), ['apple', 'goji']);
});

test('province and procurement-region filters operate on rendered controls and keep preview destinations discoverable', () => {
  const ui = new JourneyDOM();
  ui.open('regions');
  ui.click(button => button.dataset.province === '陕西');
  assert.match(ui.html, /陕西 · 定边/);
  assert.doesNotMatch(ui.html, /甘肃 · 景泰/);
  assert.match(ui.html, /筹备示意/);
  ui.open('shops');
  ui.click(button => button.dataset.region === 'gansu-jingtai');
  assert.match(ui.html, /景泰示范店/);
  assert.doesNotMatch(ui.html, /定边筹备店|另一家示范店/);
});

test('preview regions and shops never become purchasable even if stale product IDs appear', () => {
  const data = fixture();
  data.directory.regions[1].productIds = ['apple'];
  data.directory.shops[1].productIds = ['apple'];
  const ui = new JourneyDOM(data);
  ui.open('region/shaanxi-dingbian');
  assert.match(ui.html, /尚无上架商品，也不代表已建立采购合作/);
  assert.deepEqual(ui.productIds(), []);
  assert.ok(!ui.buttons().some(button => button.dataset.action === 'view-product'));
  ui.open('shop/preview');
  assert.match(ui.html, /暂未建立实际采购合作/);
  assert.deepEqual(ui.productIds(), []);
  assert.ok(!ui.buttons().some(button => button.dataset.action === 'journey-shop-stock'));
});

test('shop categories and stock filters use current published products and any available variant only', () => {
  const ui = new JourneyDOM();
  ui.open('shop/north');
  assert.deepEqual(ui.productIds(), ['apple', 'goji']);
  ui.click(button => button.dataset.category === 'dried');
  assert.deepEqual(ui.productIds(), ['goji']);
  ui.click(button => button.dataset.action === 'journey-shop-stock');
  assert.deepEqual(ui.productIds(), []);
  assert.match(ui.html, /可以取消“只看有货”/);
  assert.ok(ui.stockCalls.includes('goji:small') && ui.stockCalls.includes('goji:family'));
  ui.click(button => button.dataset.action === 'journey-shop-reset');
  ui.click(button => button.dataset.action === 'journey-shop-stock');
  assert.deepEqual(ui.productIds(), ['apple']);
  assert.ok(ui.stockCalls.includes('apple:family'));
  ui.open('shop/south');
  assert.deepEqual(ui.productIds(), ['potato']);
});

test('shop filters keep their state for return navigation and ignore invalid or preview mutations', () => {
  const ui = new JourneyDOM();
  ui.open('shop/north');
  ui.click(button => button.dataset.category === 'dried');
  ui.open('shops');
  ui.open('shop/north');
  assert.deepEqual(ui.productIds(), ['goji']);
  ui.journey.handleClick({ action: 'journey-shop-category', shop: 'north', category: '<script>' });
  assert.deepEqual(ui.productIds(), ['goji']);
  const before = ui.renders;
  assert.equal(ui.journey.handleClick({ action: 'journey-shop-stock', shop: 'preview' }), true);
  assert.equal(ui.renders, before);
  assert.equal(ui.journey.handleClick({ action: 'view-product', product: 'apple' }), false);
});

test('search forms create encoded reloadable routes and support products, origins and procurement names', () => {
  const ui = new JourneyDOM();
  ui.submit('  苹果  ');
  assert.equal(ui.path, `search/${encodeURIComponent('苹果')}`);
  assert.deepEqual(ui.productIds(), ['apple']);
  ui.submit('景泰采购者');
  assert.deepEqual(ui.productIds(), ['apple', 'goji']);
  ui.submit('其他产区');
  assert.deepEqual(ui.productIds(), ['potato']);
  ui.submit('不存在的梨');
  assert.match(ui.html, /还没有找到这份味道/);
  assert.deepEqual(ui.productIds(), []);
  ui.click(button => button.dataset.action === 'journey-clear-search');
  assert.equal(ui.path, 'search');
  assert.match(ui.html, /你想找哪份家乡味/);
  ui.click(button => button.dataset.keyword === '枸杞');
  assert.deepEqual(ui.productIds(), ['goji']);
});

test('search trims, bounds and escapes input without double decoding literal percent sequences', () => {
  const ui = new JourneyDOM();
  ui.submit('  %25 / <img src=x onerror="bad">  ');
  assert.equal(ui.path, `search/${encodeURIComponent('%25 / <img src=x onerror="bad">')}`);
  assert.match(ui.html, /%25 \/ &lt;img/);
  assert.doesNotMatch(ui.html, /<img src=x|onerror="bad"/);
  ui.submit('长'.repeat(60));
  assert.equal(decodeURIComponent(ui.path.split('/')[1]).length, 40);
  ui.submit('   ');
  assert.equal(ui.path, 'search');
  let prevented = false;
  assert.equal(ui.journey.handleSubmit({ target: { id: 'different-form' }, preventDefault: () => { prevented = true; } }), false);
  assert.equal(prevented, false);
});

test('directory failures show retry and never leak stale shops or synthesize a product owner', () => {
  const data = fixture();
  data.directory.error = '<网络错误>';
  const ui = new JourneyDOM(data);
  for (const path of ['home', 'regions', 'shops', 'region/gansu-jingtai', 'shop/north']) {
    ui.open(path);
    assert.match(ui.html, /产区与店铺暂时无法读取/);
    assert.match(ui.html, /&lt;网络错误&gt;/);
    assert.ok(ui.buttons().some(button => button.dataset.action === 'refresh-cloud'));
    assert.doesNotMatch(ui.html, /景泰示范店|景泰采购者/);
  }
  const context = ui.journey.productContext(data.catalog[0]);
  assert.match(context, /refresh-cloud/);
  assert.doesNotMatch(context, /shop\/north/);
});

test('directory loading, missing destinations and empty catalogs have usable navigation', () => {
  const data = fixture();
  data.directory.ready = false;
  const ui = new JourneyDOM(data);
  ui.open('regions');
  assert.match(ui.html, /正在整理产区与采购者店铺/);
  data.directory.ready = true;
  ui.open('region/missing');
  assert.match(ui.html, /这份产区档案暂不可用/);
  assert.ok(ui.buttons().some(button => button.dataset.route === 'regions'));
  ui.open('shop/missing');
  assert.match(ui.html, /这家店铺暂不可用/);
  assert.ok(ui.buttons().some(button => button.dataset.route === 'shops'));
  data.catalog = [];
  ui.open('home');
  assert.match(ui.html, /这里的好物还在准备/);
  assert.deepEqual(ui.productIds(), []);
});

test('product context includes only matching region and procurement backlinks and handles absent relationships', () => {
  const ui = new JourneyDOM();
  const context = ui.journey.productContext(ui.data.catalog[0]);
  assert.match(context, /data-route="region\/gansu-jingtai"/);
  assert.match(context, /data-route="shop\/north"/);
  assert.match(context, /景泰采购者/);
  assert.doesNotMatch(context, /另一家示范店/);
  const orphan = item('orphan', '没有目录的商品', 'fruit');
  const missing = ui.journey.productContext(orphan);
  assert.match(missing, /产区或采购者档案暂不可用/);
  assert.doesNotMatch(missing, /data-route="shop\//);
  assert.equal(ui.journey.productContext(null), '');
  ui.data.directory.shops[0].regionIds = ['another-place'];
  assert.match(ui.journey.productContext(ui.data.catalog[0]), /档案暂不可用/);
});

test('region and shop headers use controller-provided source routes for contextual return navigation', () => {
  const ui = new JourneyDOM();
  ui.backs.set('shop/north', 'region/gansu-jingtai');
  ui.open('shop/north');
  assert.equal(ui.buttons()[0].dataset.route, 'region/gansu-jingtai');
  ui.backs.set('region/gansu-jingtai', 'home');
  ui.open('region/gansu-jingtai');
  assert.equal(ui.buttons()[0].dataset.route, 'home');
});

test('remote descriptions, names and route IDs are escaped while linked IDs round-trip safely', () => {
  const data = fixture(), id = '店/名"<unsafe>?%25';
  data.directory.shops[0] = { ...data.directory.shops[0], id, name: '<img src=x onerror="run">', procurementName: '张"<采购者>', description: '<script>run()</script>' };
  data.directory.regions[0].shopIds = [id];
  const ui = new JourneyDOM(data);
  assert.match(ui.html, /&lt;img src=x onerror=&quot;run&quot;&gt;/);
  assert.doesNotMatch(ui.html, /<img src=x|<script>/);
  const link = ui.buttons().find(button => button.dataset.route === `shop/${encodeURIComponent(id)}`);
  assert.ok(link);
  ui.click(button => button.dataset.route === link.dataset.route);
  assert.match(ui.html, /&lt;script&gt;run\(\)&lt;\/script&gt;/);
  assert.deepEqual(ui.productIds(), ['apple', 'goji']);
  const context = ui.journey.productContext(data.catalog[0]);
  assert.match(context, new RegExp(`data-route="shop/${encodeURIComponent(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(context, /<img src=x/);
});

test('harvest content prefers a bound video and otherwise shows an honest placeholder with product context', () => {
  const ui = new JourneyDOM();
  ui.open('region/gansu-jingtai');
  assert.match(ui.html, /采收视频待补充/);
  assert.ok(ui.buttons().some(button => button.dataset.action === 'view-product' && button.dataset.product === 'apple' && button.dataset.section === 'harvest'));
  assert.doesNotMatch(ui.html, /<video/);
  ui.videos.add('goji');
  ui.open('shop/north');
  assert.match(ui.html, /<video aria-label="景泰枸杞采收素材"/);
  assert.equal(ui.videoCalls.at(-1), 'goji');
  assert.ok(ui.buttons().some(button => button.dataset.action === 'support'));
  assert.ok(!ui.buttons().some(button => button.dataset.action === 'payment'));
});
