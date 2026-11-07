'use strict';
const {randomBytes} = require('node:crypto');
const {digest, markerKey, matchesMarker} = require('./contract');
const META = 'lsf_meta', ID = 'media-storage-probe';
// A fixed public-domain one-pixel PNG, never a merchant/customer upload.
const CONTENT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l94AAAAASUVORK5CYII=', 'base64');
const HASH = digest(CONTENT);
const PATH = /^lsf-media\/probes\/[a-f0-9]{48}\.png$/;
const clean = value => {const {_id, ...data} = value;return data;};
const valueOf = result => Array.isArray(result.data) ? result.data[0] : result.data;
async function storageProbe({operation, appId, envId, accountId, createManager, getDatabase, getStorage, now, step, reject}) {
  if (typeof getStorage !== 'function') reject(503, 'storage_probe_unconfigured', '服务端存储探针尚未配置。');
  const manager = createManager(envId), cloud = getStorage();
  const rule = await step('DescribeSafeRule', META, () => manager.commonService('tcb', '2018-06-08').call({
    Action: 'DescribeSafeRule', Param: {EnvId: envId, CollectionName: META, WxAppId: appId}
  }));
  if (rule?.AclTag !== 'ADMINONLY') reject(409, 'collection_permission_unsafe', 'META 当前微信规则不是仅管理端读写；未创建存储探针。');
  const db = getDatabase(), doc = database => database.collection(META).doc(markerKey(ID));
  const read = async database => valueOf(await doc(database).get());
  const provision = await step('ReadReadyMarker', META, async () => valueOf(await db.collection(META).doc(markerKey('provision-ready')).get()));
  if (!matchesMarker(provision, appId, envId) || provision.id !== 'provision-ready' || provision.ready !== true)
    reject(409, 'verification_incomplete', '当前应用集合尚未核验就绪；未创建存储探针。');
  const belongs = row => {
    if (!row || row.id !== ID || row.appId !== appId || row.envId !== envId || row.operatorAccountId !== accountId || !/^[a-f0-9]{48}$/.test(row.nonce || '') || row.expectedHash !== HASH || !['uploading', 'active', 'finished'].includes(row.state) || !PATH.test(row.path || '') || row.path !== 'lsf-media/probes/' + row.nonce + '.png' || !(row.fileID === null && row.state !== 'active' || typeof row.fileID === 'string' && row.fileID.startsWith('cloud://' + envId + '.') && row.fileID.endsWith('/' + row.path)))
      reject(409, 'project_marker_conflict', '已有存储探针归属或格式不匹配；未创建或删除任何文件。');
    return row;
  };
  const transaction = async action => {const tx = await db.startTransaction();try {const result = await action(tx);await tx.commit();return result;} catch (error) {await tx.rollback().catch(() => {});throw error;}};
  const describe = async (row, replayed) => {
    let serverURL;
    if (row.state === 'active') {
      const signed = await step('GetProbeServerURL', undefined, () => cloud.getTempFileURL({fileList: [{fileID: row.fileID, maxAge: 300}]}));
      const item = signed?.fileList?.find(file => file.fileID === row.fileID);
      if (!item || item.status !== 0 || typeof item.tempFileURL !== 'string' || !item.tempFileURL.startsWith('https://'))
        reject(503, 'storage_probe_url_unavailable', '服务端探针链接尚未确认；请保留当前探针并重试。');
      serverURL = item.tempFileURL;
    }
    return {status: 200, body: {probe: {nonce: row.nonce, fileID: row.fileID, path: row.path, representative: row.state === 'active', ...(serverURL ? {serverURL} : {needsCleanup: true})}, replayed, storageRulesChanged: false}};
  };
  if (operation === 'storage-probe-start') {
    const previous = await step('ReadStorageProbe', META, () => read(db));
    if (previous && belongs(previous).state !== 'finished') return describe(previous, true);
    const acl = await step('GetStorageAcl', undefined, () => manager.storage.getStorageAcl({withRule: true}));
    if (!['PRIVATE', 'ADMINONLY'].includes(acl?.acl)) reject(409, 'storage_probe_not_private', '仅在现有私有存储规则下运行受控探针；未修改共享规则。');
    const nonce = randomBytes(24).toString('hex'), path = 'lsf-media/probes/' + nonce + '.png';
    const row = {id: ID, appId, envId, operatorAccountId: accountId, nonce, path, fileID: null, expectedHash: HASH, state: 'uploading', createdAt: new Date(now()).toISOString()};
    belongs(row);
    await step('ClaimStorageProbe', META, () => transaction(async tx => {
      const current = await read(tx);if (current && belongs(current).state !== 'finished') reject(409, 'storage_probe_busy', '已有未清理的存储探针，请完成现有探针。');
      await doc(tx).set({data: row});
    }));
    // The FIRST object operation for this new random path MUST be the same
    // wx-server-sdk uploadFile call as commerce media. Pre-minting metadata via
    // Manager could affect file ownership and invalidate this security probe.
    const upload = await step('UploadStorageProbe', undefined, () => cloud.uploadFile({cloudPath: path, fileContent: CONTENT}));
    const saved = {...row, fileID: upload?.fileID, state: 'active'};belongs(saved);
    await step('SaveUploadedStorageProbe', META, () => transaction(async tx => {
      const current = belongs(await read(tx));if (current.nonce !== nonce || current.state !== 'uploading') reject(409, 'storage_probe_changed', '探针记录已变化，请重新核对。');
      await doc(tx).set({data: saved});
    }));
    return describe(saved, false);
  }
  const row = await step('ReadStorageProbe', META, () => read(db));
  if (!row) reject(409, 'storage_probe_missing', '没有待核对的存储探针。');
  belongs(row);
  if (row.state === 'finished') return {status: 200, body: {...row.result, replayed: true}};
  const finishRecord = async result => {
    await step('FinishStorageProbe', META, () => transaction(async tx => {
      const current = belongs(await read(tx));if (current.nonce !== row.nonce) reject(409, 'storage_probe_changed', '探针记录已变化，请重新核对。');
      await doc(tx).set({data: {...clean(current), state: 'finished', result}});
    }));
    return {status: 200, body: {...result, replayed: false}};
  };
  if (row.state === 'uploading') {
    // A lost SDK response means ownership/creation cannot be used as evidence.
    // The official path-based delete cleans only this previously persisted key;
    // it does not mint upload metadata or adopt any other objects.
    await step('DeleteUncertainStorageProbe', undefined, () => manager.storage.deleteFile([row.path]));
    return finishRecord({nonce: row.nonce, representative: false, serverReadable: false, fileIntact: false, cleanedUp: true, ownerMetadataAvailable: false, storageRulesChanged: false, checkedAt: new Date(now()).toISOString()});
  }
  let intact = false, readable = false;
  try {
    // Manager SDK 5.9.4 reports Size in KiB, not bytes. Guard the tiny probe
    // before invoking the SDK's buffered download to avoid reading a large
    // unexpectedly overwritten object into this function's memory.
    const info = await step('GetProbeFileInfo', undefined, () => manager.storage.getFileInfo(row.path));
    if (typeof info?.Size !== 'string' || !/^\d+(?:\.\d+)?$/.test(info.Size) || Number(info.Size) > 1)
      reject(409, 'storage_probe_size_invalid', '探针文件大小异常；本次未下载。');
    const downloaded = await step('DownloadStorageProbe', undefined, () => cloud.downloadFile({fileID: row.fileID}));
    readable = Buffer.isBuffer(downloaded?.fileContent);
    intact = readable && downloaded.fileContent.length === CONTENT.length && digest(downloaded.fileContent) === HASH;
  } catch (error) {
    // A direct-client deletion or overwrite is a failed probe, never readiness.
    const code = error?.code ?? error?.errCode;
    if (!['NoSuchKey', 'ResourceNotFound', 'STORAGE_FILE_NONEXIST', -503003, 'storage_probe_size_invalid'].includes(code) && error?.statusCode !== 404) throw error;
  }
  const deleted = await step('DeleteStorageProbe', undefined, () => cloud.deleteFile({fileList: [row.fileID]}));
  const deletion = deleted?.fileList?.find(item => item.fileID === row.fileID);
  if (!deletion || ![0, -503003].includes(deletion.status)) reject(503, 'storage_probe_cleanup_incomplete', '探针清理尚未确认，请重试finish；未创建新探针。');
  const result = {nonce: row.nonce, representative: true, serverReadable: readable, fileIntact: intact, cleanedUp: true, ownerMetadataAvailable: false, storageRulesChanged: false, checkedAt: new Date(now()).toISOString()};
  // No successful client denial is accepted as an input, and this operation
  // deliberately never writes or enables media-storage-ready.
  return finishRecord(result);
}
module.exports = {storageProbe};
