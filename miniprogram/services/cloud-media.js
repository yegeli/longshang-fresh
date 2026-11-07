// Upload through authenticated cloud functions: no public upload credentials,
// extra request domain, or client storage permission is needed.
const CHUNK_SIZE = 256 * 1024;
const TYPES = { image: ['image/jpeg', 'image/png', 'image/webp'], video: ['video/mp4'] };
const failure = (code, message) => Object.assign(new Error(message), { code });
const MEDIA_ID = /^CLOUD-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i;

function createMediaUploader({ wxApi, request, authorize, checkIdentity, getGeneration, newKey }) {
  const attempts = new Map();
  return function upload(input) {
    const revision = getGeneration();
    let cancelled = false, stopped = false, rejectCancellation, attemptIdentity;
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const guard = () => {
      if (cancelled) throw failure('upload_cancelled', '上传已取消，可重新选择或重试。');
      if (stopped) throw failure('upload_stopped', '上传已停止，请重试。');
      checkIdentity(input.expectedUserId, revision);
    };
    const operation = (async () => {
      if (!input || !TYPES[input.kind] || !TYPES[input.kind].includes(input.mimeType)
        || typeof input.filePath !== 'string' || !input.filePath || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.productId || '')
        || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > (input.kind === 'image' ? 5 : 20) * 1024 * 1024)
        throw failure('media_invalid', '请选择5MB以内的JPG、PNG、WebP图片，或20MB以内的MP4视频。');
      if (input.kind === 'video' && (!Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 120))
        throw failure('media_invalid', '请选择2分钟以内的MP4视频。');
      guard(); await authorize(input.expectedUserId); guard();
      if (!wxApi.getFileSystemManager) throw failure('media_runtime_missing', '当前微信无法读取所选文件，请升级微信后重试。');
      const fs = wxApi.getFileSystemManager();
      const identity = [input.expectedUserId, input.productId, input.kind, input.filePath, input.size, input.mimeType].join('|');
      attemptIdentity = identity;
      let key = attempts.get(identity);
      if (!key) { key = newKey(); attempts.set(identity, key); if (attempts.size > 20) attempts.delete(attempts.keys().next().value); }
      const call = async (path, body, retry = true) => {
        guard();
        try { const value = await request(path, 'POST', body, { timeout: 30000 }); guard(); return value; }
        catch (error) {
          guard();
          if (retry && error.code === 'network_error') return call(path, body, false);
          throw error;
        }
      };
      const ticket = await call('/api/v1/admin/media/uploads', { productId: input.productId, kind: input.kind,
        contentType: input.mimeType, size: input.size, source: input.source || '商家上传的模拟演示素材，非真实景泰采摘记录。', idempotencyKey: key });
      if (!MEDIA_ID.test(ticket.mediaId || '')) throw failure('response_invalid', '云端上传编号无效。');
      const base = '/api/v1/admin/media/' + ticket.mediaId;
      if (ticket.state !== 'ready') {
        const count = Math.ceil(input.size / CHUNK_SIZE);
        if (ticket.chunkSize !== CHUNK_SIZE || ticket.chunkCount !== count || !Array.isArray(ticket.uploadedChunks)
          || ticket.uploadedChunks.some(index => !Number.isInteger(index) || index < 0 || index >= count))
          throw failure('response_invalid', '云端分块上传配置无效。');
        const done = new Set(ticket.uploadedChunks), queue = Array.from({ length: count }, (_, index) => index).filter(index => !done.has(index));
        const progress = () => { if (!cancelled && !stopped && typeof input.onProgress === 'function') input.onProgress({ progress: Math.floor(done.size / count * 100), phase: done.size === count ? 'verifying' : 'uploading' }); };
        progress();
        const worker = async () => {
          while (queue.length) {
            guard(); const index = queue.shift(), length = Math.min(CHUNK_SIZE, input.size - index * CHUNK_SIZE);
            const data = await new Promise((resolve, reject) => fs.readFile({ filePath: input.filePath, position: index * CHUNK_SIZE, length, encoding: 'base64',
              success: result => resolve(result.data), fail: () => reject(failure('media_read_failed', '所选文件无法读取，请重新选择。')) }));
            guard();
            if (typeof data !== 'string' || data.length !== Math.ceil(length / 3) * 4) throw failure('media_size_changed', '所选文件已变化，请重新选择。');
            await call(base + '/chunks', { index, data }); done.add(index); progress();
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
      }
      const result = await call(base + '/complete', {}); guard();
      if (result.mediaId !== ticket.mediaId || result.state !== 'ready' || typeof result.url !== 'string' || !/^https:\/\//i.test(result.url))
        throw failure('response_invalid', '云端素材未完成校验，请重试。');
      attempts.delete(identity);
      return result;
    })();
    const promise = Promise.race([operation, cancellation]).catch(error => {
      stopped = true;
      if (['media_upload_expired', 'media_retry_limit', 'media_chunk_conflict', 'media_size_changed', 'media_size_mismatch', 'media_type_invalid'].includes(error.code)) attempts.delete(attemptIdentity);
      throw error;
    });
    return { promise, abort() { if (!cancelled) { cancelled = true; rejectCancellation(failure('upload_cancelled', '上传已取消，可重新选择或重试。')); } } };
  };
}
module.exports = { createMediaUploader, CHUNK_SIZE };
