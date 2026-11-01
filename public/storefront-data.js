// Display copy is illustrative. Product ownership comes only from the server;
// this shared module never assigns a real cloud seller to a product.
const IMAGES = new Set(['apples', 'goji', 'pear', 'potato', 'corn', 'onion', 'orchard', 'apple-orchard', 'apples-hero'].map(name => `assets/${name}.jpg`));
const LOCAL_SHOP_ID = 'shop-local-demo';
export const DINGBIAN_PREVIEW_SHOP_ID = 'shop-preview-dingbian';
const PRIORITY = { 'gansu-jingtai': 0, 'shaanxi-dingbian': 1 };
const compareIds = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const compareRegions = (left, right) => (PRIORITY[left.id] ?? 2) - (PRIORITY[right.id] ?? 2) || compareIds(left.id, right.id);
const image = value => IMAGES.has(value) ? value : 'assets/orchard.jpg';

// Origin text is public display data. A deterministic 64-bit FNV identifier
// keeps arbitrary origin labels out of route paths without dropping the label.
function originHash(text) {
  let value = 0xcbf29ce484222325n;
  for (const character of text) {
    value ^= BigInt(character.codePointAt(0));
    value = BigInt.asUintN(64, value * 0x100000001b3n);
  }
  return value.toString(16).padStart(16, '0');
}

export function regionForOrigin(value) {
  const origin = typeof value === 'string' && value.trim() ? value.trim() : '产地待补充（模拟）';
  if (origin.includes('景泰')) return {
    id: 'gansu-jingtai', name: '甘肃 · 景泰', province: '甘肃', subtitle: '从家乡的果园与农田出发',
    description: '先认识景泰的苹果、鲜梨、枸杞与田间作物，再查看商品规格和采购者介绍。产地、商品与采购资料均为模拟示意。',
    image: 'assets/apple-orchard.jpg', preview: false, productIds: [], shopIds: []
  };
  if (origin.includes('定边')) return {
    id: 'shaanxi-dingbian', name: '陕西 · 定边', province: '陕西', subtitle: '认识另一片土地的日常风味',
    description: '按商品填写的产地展示定边特产与所属采购者。当前内容为模拟，实际货源、合作关系与产地介绍待核实。',
    image: 'assets/potato.jpg', preview: false, productIds: [], shopIds: []
  };
  return {
    id: `region-${originHash(origin)}`, name: origin, province: '其他产区', subtitle: '跟着商品认识新的产地',
    description: `按商品标注的“${origin}”归集展示。产区介绍与采购资料为模拟，实际货源待补充核实。`,
    image: 'assets/orchard.jpg', preview: false, productIds: [], shopIds: []
  };
}

function dingbianPreview() {
  const region = regionForOrigin('陕西 · 定边');
  return {
    region: { ...region, name: '陕西 · 定边（筹备示意）', subtitle: '筹备示意 · 暂无在售商品', preview: true,
      description: '仅演示未来接入其他产区的结构；暂无已核实的采购合作、真实货源或在售商品。', shopIds: [DINGBIAN_PREVIEW_SHOP_ID] },
    shop: { id: DINGBIAN_PREVIEW_SHOP_ID, name: '定边采购者店铺（筹备示意）', regionIds: [region.id],
      regionLabel: '陕西 · 定边（筹备示意）', description: '这是未来店铺的结构示意，尚未接入采购者或上架商品，不能购买。',
      procurementName: '采购者待接入', image: 'assets/potato.jpg', preview: true, productIds: [], simulation: true }
  };
}

// Inputs contain only public display fields and an already resolved shop ID.
// Explicit projection prevents private owner/profile properties reaching the UI.
export function buildStorefront(products, definitions, updatedAt = null) {
  const regionMap = new Map(), shopMap = new Map();
  const definitionsById = new Map(definitions.map(shop => [shop.id, shop]));
  for (const product of [...products].sort((left, right) => compareIds(left.id, right.id))) {
    const definition = definitionsById.get(product.shopId);
    if (!definition || typeof product.id !== 'string' || !product.id) continue;
    const template = regionForOrigin(product.origin);
    if (!regionMap.has(template.id)) regionMap.set(template.id, template);
    const region = regionMap.get(template.id);
    if (!shopMap.has(definition.id)) shopMap.set(definition.id, {
      id: definition.id, name: definition.name, regionIds: [], regionLabel: definition.regionLabel || '',
      description: definition.description, procurementName: definition.procurementName,
      image: image(product.image), preview: false, productIds: [], simulation: true
    });
    const shop = shopMap.get(definition.id);
    if (!shop.productIds.includes(product.id)) shop.productIds.push(product.id);
    if (!shop.regionIds.includes(region.id)) shop.regionIds.push(region.id);
    if (!region.productIds.includes(product.id)) region.productIds.push(product.id);
    if (!region.shopIds.includes(shop.id)) region.shopIds.push(shop.id);
  }
  const regions = [...regionMap.values()].sort(compareRegions);
  for (const region of regions) region.shopIds.sort(compareIds);
  const shops = [...shopMap.values()].sort((left, right) => compareIds(left.id, right.id));
  for (const shop of shops) {
    shop.regionIds.sort((left, right) => compareRegions(regionMap.get(left), regionMap.get(right)));
    shop.regionLabel ||= shop.regionIds.map(id => regionMap.get(id).name).join(' / ');
  }
  if (!regionMap.has('shaanxi-dingbian')) {
    const preview = dingbianPreview(); regions.push(preview.region); regions.sort(compareRegions); shops.push(preview.shop);
  }
  return { regions, shops, updatedAt };
}

export function localStorefront(catalog = []) {
  const products = Array.isArray(catalog) ? catalog.filter(product => product?.status === 'published').map(product => ({
    id: product.id, origin: product.origin, image: product.image, shopId: LOCAL_SHOP_ID
  })) : [];
  return buildStorefront(products, [{ id: LOCAL_SHOP_ID, name: '景泰好物示范店', procurementName: '示范采购员',
    description: '本机演示店铺：集中展示当前已上架的模拟商品，演示从产区到店铺的浏览过程，不代表真实采购合作。' }]);
}
