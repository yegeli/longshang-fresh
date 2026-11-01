import { BASE_CATALOG, setCatalog, normalizeCatalogProduct } from './model.js';
import { initializeCloudMode, isCloudMode, apiRequest, requirePermission, managementScopeKey, requireUnchangedScope, markCloudSynced } from './cloud-client.js';

let cloudCatalog = [];
// Only retain products this tab actually read from the public API, never admin-only data.
let publicCatalog = [];
const versions = new Map();
export function getProductVersion(id) { return versions.get(id) ?? 0; }

export const CATALOG_KEY = 'longshang-demo-catalog-v1';

export function parsePrice(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('价格需为有效的元金额');
  const source = String(value).trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(source)) throw new Error('价格需为正数，最多两位小数');
  const [whole = '0', fraction = ''] = source.split('.');
  const cents = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 999999) throw new Error('价格需在0.01至9999.99元之间');
  return cents;
}

function loadProducts() {
  let raw;
  try { raw = localStorage.getItem(CATALOG_KEY); }
  catch (cause) { throw new Error('无法读取本浏览器的商品资料，请检查存储权限', { cause }); }
  if (raw === null) return BASE_CATALOG.map(product => normalizeCatalogProduct(product));
  let saved;
  try { saved = JSON.parse(raw); }
  catch (cause) { throw new Error('本地商品资料格式损坏，未覆盖原记录', { cause }); }
  if (!Array.isArray(saved) || saved.length > 200) throw new Error('本地商品目录格式无效，未覆盖原记录');
  const products = new Map(BASE_CATALOG.map(product => [product.id, product]));
  const seen = new Set();
  for (const item of saved) {
    if (!item || seen.has(item.id)) throw new Error('本地商品编号重复或资料无效');
    const product = normalizeCatalogProduct(item, products.get(item.id));
    seen.add(product.id); products.set(product.id, product);
  }
  if (products.size > 200) throw new Error('本地商品数量超过200款');
  return [...products.values()];
}

export function readCatalog() { return setCatalog(isCloudMode() ? cloudCatalog : loadProducts()); }

export async function initializeCatalog(options = {}) {
  await initializeCloudMode();
  return refreshCatalog(options);
}
export async function refreshCatalog({ admin = false } = {}) {
  if (!isCloudMode()) return readCatalog();
  if (admin) requirePermission('products');
  const scope = admin ? managementScopeKey() : null;
  const data = await apiRequest(admin ? '/api/v1/admin/products' : '/api/v1/products');
  if (admin) requireUnchangedScope(scope);
  if (!Array.isArray(data?.products) || data.products.some(product => !Number.isSafeInteger(product?.version) || product.version < 1)) throw new Error('云端商品目录或版本格式无效');
  const next = data.products.map(product => normalizeCatalogProduct(product));
  if (!admin && next.some(product => product.status !== 'published')) throw new Error('公开商品目录包含未发布记录');
  // Missing public products stay removable in an existing cart, always unavailable.
  // Respect the model's 200-product limit and never retain built-in or private admin entries.
  const liveIds = new Set(next.map(product => product.id));
  const unavailable = admin ? [] : publicCatalog.filter(product => !liveIds.has(product.id))
    .slice(0, Math.max(0, 200 - next.length)).map(product => ({ ...product, status: 'offline' }));
  const checked = setCatalog([...next, ...unavailable]);
  if (!admin) publicCatalog = [...checked];
  versions.clear();
  data.products.forEach(product => versions.set(product.id, product.version));
  cloudCatalog = [...checked]; markCloudSynced();
  return checked;
}
async function saveCloudProduct(input, options) {
  requirePermission('products');
  const scope = managementScopeKey();
  const previous = cloudCatalog.find(product => product.id === input.id);
  const product = normalizeCatalogProduct(input, previous || {});
  const expectedVersion = options.expectedVersion ?? getProductVersion(product.id);
  const data = await apiRequest(`/api/v1/admin/products/${encodeURIComponent(product.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product, expectedVersion })
  });
  requireUnchangedScope(scope);
  const version = data?.version ?? data?.product?.version;
  if (!Number.isSafeInteger(version) || version < 1 || data?.product?.id !== product.id) throw new Error('云端保存响应或版本异常，请重新读取后核对');
  const saved = normalizeCatalogProduct(data.product);
  const index = cloudCatalog.findIndex(item => item.id === saved.id);
  const next = [...cloudCatalog]; if (index < 0) next.push(saved); else next[index] = saved;
  setCatalog(next); cloudCatalog = next;
  versions.set(saved.id, version); markCloudSynced();
  return saved;
}

export function saveProduct(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('商品资料格式无效');
  if (isCloudMode()) return saveCloudProduct(input, options);
  const products = loadProducts();
  const index = products.findIndex(product => product.id === input.id);
  const product = normalizeCatalogProduct(input, index >= 0 ? products[index] : {});
  const next = [...products];
  if (index >= 0) next[index] = product;
  else next.push(product);
  if (next.length > 200) throw new Error('本地商品数量超过200款');
  try { localStorage.setItem(CATALOG_KEY, JSON.stringify(next)); }
  catch (cause) { throw new Error('商品未保存：本浏览器存储失败，请释放空间或检查权限', { cause }); }
  setCatalog(next);
  return product;
}

export function setProductStatus(id, status, options = {}) {
  if (!['published', 'draft', 'offline'].includes(status)) throw new Error('商品状态无效');
  const product = (isCloudMode() ? cloudCatalog : loadProducts()).find(item => item.id === id);
  if (!product) throw new Error('商品不存在');
  return saveProduct({ ...product, status }, options);
}

export function newProductTemplate(id) {
  return JSON.parse(JSON.stringify(normalizeCatalogProduct({
    id, name: '新增特产（模拟）', category: 'fruit', status: 'draft', image: 'assets/apples.jpg',
    origin: '甘肃 · 示例产地（模拟）', subtitle: '认识一份新的家乡好物 · 模拟商品',
    tags: ['新增商品 · 模拟', '规格待核实'],
    summary: '这是新增商品的模拟资料，请填写名称、规格与价格后预览。图片与介绍不代表实际货源。',
    storage: '模拟储存说明，正式售卖前根据真实商品和包装填写。',
    sizeNote: '以下净重或计量均为模拟示例，不包含外包装。',
    facts: [['商品形态', '模拟示例，待实际货源核实'], ['产地', '示例产地（模拟）'], ['规格', '以两种模拟规格展示']],
    harvestSteps: [
      { title: '采收记录', text: '模拟步骤，实际采收时间与方式待补充。' },
      { title: '分拣检查', text: '模拟步骤，实际分级与验收标准待补充。' },
      { title: '包装准备', text: '模拟步骤，实际包装材料与试寄结果待补充。' }
    ],
    variants: [
      { id: 'small', label: '尝鲜装（模拟）', weight: '净重 1kg（模拟）', price: 1990, hint: '先认识这款模拟商品' },
      { id: 'family', label: '分享装（模拟）', weight: '净重 2kg（模拟）', price: 2990, hint: '规格和价格均可在后台修改' }
    ],
    video: '', videoTitle: '采收视频 · 待补充', videoNote: '暂无视频，后续可选择上传模拟素材。'
  })));
}
