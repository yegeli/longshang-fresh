import { isCloudMode } from './cloud-client.js';
import { loadInventories } from './inventory-store.js';
import { isProductAvailable } from './model.js';

let inventories = new Map(), ready = false, error = '', generation = 0;
export function inventoryFingerprint() { return JSON.stringify([ready, error, [...inventories.values()]]); }
export function inventoryFor(id) { const value = inventories.get(id); return value ? structuredClone(value) : null; }
export async function refreshBuyerInventory() {
  const current = ++generation;
  if (!isCloudMode()) { inventories.clear(); ready = false; error = ''; return; }
  try {
    const data = await loadInventories();
    if (current !== generation) return;
    inventories = new Map(data.inventories.map(item => [item.productId, item])); ready = true; error = '';
  } catch {
    if (current !== generation) return;
    inventories.clear(); ready = false; error = '库存暂时无法读取，请刷新后再选购。';
  }
}
export function availability(product, variant, quantity = 1) {
  if (!isProductAvailable(product)) return { available: false, stock: 0, message: '暂未上架' };
  if (!isCloudMode()) return { available: true, stock: null, message: '' };
  if (!ready) return { available: false, stock: null, message: error || '正在读取库存…' };
  const inventory = inventories.get(product.id);
  if (!inventory?.configured) return { available: false, stock: 0, message: '待备货 · 尚未设置库存' };
  const stock = inventory.stocks[variant] ?? 0;
  return { available: Number.isSafeInteger(quantity) && quantity > 0 && quantity <= stock, stock,
    message: stock === 0 ? '该规格暂时缺货' : quantity > stock ? `仅剩 ${stock} 份，请减少数量` : `可售 ${stock} 份${stock <= 5 ? ' · 余量不多' : ''}` };
}
