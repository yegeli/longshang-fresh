import { isCloudMode, apiRequest, requireManager, cloudMediaUrl } from './cloud-client.js';
// Local demo uses IndexedDB; cloud mode uses the authenticated media API.
const DB_NAME = 'longshang-demo-media-v1';
const STORE = 'files';
const cache = new Map();
const errors = new Map();
let database;

function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持保存本机素材，请使用预设素材')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(new Error('无法打开本机素材库，请检查浏览器存储权限'));
    request.onblocked = () => reject(new Error('素材库正在被其他页面使用，请关闭旧页面后重试'));
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function readMedia(id, kind) {
  if (isCloudMode()) return cloudMediaUrl(id);
  if (cache.has(id)) return cache.get(id).kind === kind ? cache.get(id).url : '';
  const db = await openDatabase();
  const item = await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('本机素材读取失败，请重新选择素材'));
  });
  if (!item || item.kind !== kind || !(item.blob instanceof Blob)) throw new Error('本机素材已丢失，请在后台重新选择；暂用预设图片或隐藏视频');
  const url = URL.createObjectURL(item.blob);
  cache.set(id, { url, kind, source: item.source || '' });
  return url;
}

export async function hydrateMedia(products) {
  const refs = new Map();
  for (const product of products) {
    if (product.imageMediaId) refs.set(product.imageMediaId, 'image');
    if (product.videoMediaId) refs.set(product.videoMediaId, 'video');
  }
  const result = await Promise.all([...refs].map(async ([id, kind]) => {
    try { await readMedia(id, kind); errors.delete(id); return null; }
    catch (error) { errors.set(id, error.message); return error.message; }
  }));
  return [...new Set(result.filter(Boolean))];
}

export function imageFor(product) {
  return (isCloudMode() && product?.imageMediaId ? cloudMediaUrl(product.imageMediaId) : cache.get(product?.imageMediaId)?.url) || product?.image || 'assets/apples.jpg';
}
export function videoFor(product) {
  // A missing replacement must never silently play the old footage.
  return product?.videoMediaId ? (isCloudMode() ? cloudMediaUrl(product.videoMediaId) : cache.get(product.videoMediaId)?.url || '') : product?.video || '';
}
export function mediaErrorFor(product) {
  return [...new Set([errors.get(product?.imageMediaId), errors.get(product?.videoMediaId)].filter(Boolean))].join('；');
}

function validatePlayable(file, kind) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const media = kind === 'image' ? new Image() : document.createElement('video');
    const ready = kind === 'image' ? 'load' : 'loadedmetadata';
    const timer = setTimeout(() => finish(new Error('素材读取超时，请换一个较小的文件重试')), 12000);
    function finish(error) {
      clearTimeout(timer);
      media.removeEventListener(ready, onReady);
      media.removeEventListener('error', onError);
      media.removeAttribute('src');
      if (kind === 'video') media.load();
      URL.revokeObjectURL(url);
      error ? reject(error) : resolve();
    }
    function onReady() {
      if (kind === 'image' && (!media.naturalWidth || !media.naturalHeight)) return finish(new Error('图片内容无效，请换一个文件'));
      if (kind === 'video' && (!media.videoWidth || !Number.isFinite(media.duration) || media.duration <= 0)) return finish(new Error('视频内容无效，请选择可播放的短视频'));
      finish();
    }
    function onError() { finish(new Error(kind === 'image' ? '无法读取这张图片，请选择 JPG、PNG、WebP 或 GIF' : '当前浏览器无法播放此视频，请使用 H.264 编码的 MP4 或可播放的 WebM')); }
    media.addEventListener(ready, onReady, { once: true });
    media.addEventListener('error', onError, { once: true });
    if (kind === 'video') media.preload = 'metadata';
    media.src = url;
  });
}

export async function saveMedia(file, kind, { source = '' } = {}) {
  const types = kind === 'image' ? ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] : kind === 'video' ? ['video/mp4', 'video/webm'] : [];
  const limit = kind === 'image' ? 5 : 30;
  if (!(file instanceof Blob) || !types.includes(file.type)) throw new Error(kind === 'image' ? '请选择 JPG、PNG、WebP 或 GIF 图片' : '请选择 MP4 或 WebM 视频');
  if (!file.size || file.size > limit * 1024 * 1024) throw new Error(`文件大小需大于 0 且不超过 ${limit}MB`);
  if (isCloudMode()) {
    requireManager();
    if (typeof source !== 'string' || !source.trim() || source.length > 500) throw new Error('请填写素材来源及授权说明，最多500字');
  }
  await validatePlayable(file, kind);
  if (isCloudMode()) {
    const saved = await apiRequest(`/api/v1/media?kind=${kind}`, { method: 'POST', headers: {
      'Content-Type': file.type, 'X-File-Name': encodeURIComponent(String(file.name || '素材').slice(0,200)),
      'X-Media-Source': encodeURIComponent(source.trim())
    }, body: file });
    if (!saved?.id || !saved?.url) throw new Error('云端素材响应异常，未替换原素材');
    cache.set(saved.id, { url: saved.url, kind, source: saved.source || source.trim() });
    errors.delete(saved.id); return saved;
  }
  const db = await openDatabase();
  const id = `media-${crypto.randomUUID()}`;
  const item = { id, kind, source: String(source).trim().slice(0,500), blob: file, name: String(file.name || '本机素材').slice(0,200), type: file.type, size: file.size, createdAt: new Date().toISOString() };
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(item);
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(new Error('素材未保存：浏览器空间不足或存储被禁用，请换一个较小文件'));
  });
  const url = URL.createObjectURL(file);
  cache.set(id, { url, kind, source: item.source });
  errors.delete(id);
  return { id, url, name: item.name, type: item.type, size: item.size, source: item.source };
}
