import { BASE_CATALOG, setCatalog, normalizeCatalogProduct } from './model.js';

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

export function readCatalog() { return setCatalog(loadProducts()); }

export function saveProduct(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('商品资料格式无效');
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

export function setProductStatus(id, status) {
  if (!['published', 'draft', 'offline'].includes(status)) throw new Error('商品状态无效');
  const product = loadProducts().find(item => item.id === id);
  if (!product) throw new Error('商品不存在');
  return saveProduct({ ...product, status });
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
