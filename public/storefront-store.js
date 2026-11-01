import { apiRequest, getCloudState, CloudError } from './cloud-client.js';
import { localStorefront, DINGBIAN_PREVIEW_SHOP_ID } from './storefront-data.js';

// Public browsing relationships are memory-only. Cloud failures clear the last
// directory instead of assigning products to a made-up local seller.
const state = { regions: [], shops: [], ready: false, error: '' };
let generation = 0;
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';
const ids = value => Array.isArray(value) && value.every(id => text(id) && !!id) && new Set(value).size === value.length;
const exactly = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new CloudError('产区与店铺资料格式异常，请重新读取。', 0, 'INVALID_RESPONSE'); };

function directory(value) {
  if (!exactly(value, ['regions', 'shops', 'updatedAt']) || !Array.isArray(value.regions) || !Array.isArray(value.shops)
    || value.regions.length > 201 || value.shops.length > 201 || !(value.updatedAt === null || text(value.updatedAt))) invalid();
  const regionIds = new Set(), shopIds = new Set(), productIds = new Set();
  for (const region of value.regions) {
    if (!exactly(region, ['id', 'name', 'province', 'subtitle', 'description', 'image', 'preview', 'productIds', 'shopIds'])
      || !['id', 'name', 'province', 'subtitle', 'description', 'image'].every(key => text(region[key]))
      || !/^[a-z][a-z0-9-]+$/.test(region.id) || regionIds.has(region.id) || typeof region.preview !== 'boolean'
      || !ids(region.productIds) || !ids(region.shopIds) || (!region.preview && !region.productIds.length)) invalid();
    regionIds.add(region.id);
  }
  for (const shop of value.shops) {
    if (!exactly(shop, ['id', 'name', 'regionIds', 'regionLabel', 'description', 'procurementName', 'image', 'preview', 'productIds', 'simulation'])
      || !['id', 'name', 'regionLabel', 'description', 'procurementName', 'image'].every(key => text(shop[key]))
      || (!/^shop-[a-f0-9]{24}$/.test(shop.id) && shop.id !== DINGBIAN_PREVIEW_SHOP_ID)
      || shopIds.has(shop.id) || typeof shop.preview !== 'boolean' || shop.simulation !== true
      || !ids(shop.productIds) || !ids(shop.regionIds) || !shop.regionIds.length || shop.regionIds.some(id => !regionIds.has(id))
      || (shop.preview ? shop.id !== DINGBIAN_PREVIEW_SHOP_ID || shop.productIds.length !== 0 || shop.regionIds.length !== 1 || shop.regionIds[0] !== 'shaanxi-dingbian'
        : !shop.productIds.length || shop.id === DINGBIAN_PREVIEW_SHOP_ID)) invalid();
    for (const id of shop.productIds) { if (productIds.has(id)) invalid(); productIds.add(id); }
    shopIds.add(shop.id);
  }
  for (const region of value.regions) {
    if (region.shopIds.some(id => !shopIds.has(id)) || region.productIds.some(id => !productIds.has(id))
      || region.preview && (region.id !== 'shaanxi-dingbian' || region.productIds.length !== 0 || region.shopIds.length !== 1 || region.shopIds[0] !== DINGBIAN_PREVIEW_SHOP_ID)) invalid();
    for (const id of region.shopIds) if (!value.shops.find(shop => shop.id === id).regionIds.includes(region.id)) invalid();
    for (const id of region.productIds) if (!value.shops.some(shop => shop.regionIds.includes(region.id) && shop.productIds.includes(id))) invalid();
  }
  for (const shop of value.shops) for (const id of shop.regionIds) {
    const region = value.regions.find(candidate => candidate.id === id);
    if (!region.shopIds.includes(shop.id) || shop.preview !== region.preview
      || (!shop.preview && !shop.productIds.some(productId => region.productIds.includes(productId)))) invalid();
  }
  if ([...productIds].some(id => value.regions.filter(region => region.productIds.includes(id)).length !== 1)) invalid();
  return clone({ regions: value.regions, shops: value.shops });
}

export function getStorefrontState() { return clone(state); }
export function shopForProduct(id) { return clone(state.shops.find(shop => !shop.preview && shop.productIds.includes(id)) || null); }
export function regionForProduct(id) { return clone(state.regions.find(region => !region.preview && region.productIds.includes(id)) || null); }

export async function refreshStorefront({ products = [] } = {}) {
  const current = ++generation, mode = getCloudState().mode;
  state.regions = []; state.shops = []; state.ready = false; state.error = '';
  try {
    let next;
    if (mode === 'local') {
      const data = localStorefront(products);
      next = { regions: data.regions, shops: data.shops };
    } else if (mode === 'cloud') next = directory(await apiRequest('/api/v1/storefront'));
    else throw new CloudError('请先确认连接状态，再读取产区与店铺。', 0, 'MODE_UNAVAILABLE');
    if (current !== generation) return getStorefrontState();
    if (getCloudState().mode !== mode) throw new CloudError('连接状态已变化，请重新读取产区与店铺。', 409, 'mode_changed');
    state.regions = next.regions; state.shops = next.shops; state.ready = true;
  } catch (error) {
    if (current !== generation) return getStorefrontState();
    state.regions = []; state.shops = []; state.ready = true;
    state.error = error?.message || '产区与店铺暂时无法读取，请重试。';
  }
  return getStorefrontState();
}
