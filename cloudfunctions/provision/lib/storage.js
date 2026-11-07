'use strict';
const {digest, markerKey, matchesMarker} = require('./contract');
const META = 'lsf_meta';
const MARKER = 'media-storage-ready';
const MEDIA_POLICY = 'server-owned-display-v1';
const ACLS = ['READONLY', 'PRIVATE', 'ADMINWRITE', 'ADMINONLY', 'CUSTOM'];

// This inspects storage only. It never changes a shared bucket's rules, ACL,
// objects, lifecycle, domains or execution role. The only write is our fixed
// protected readiness record, including invalidation of an older snapshot.
async function storageInspect({appId, envId, accountId, createManager, getDatabase, now, step, reject}) {
  const manager = createManager(envId);
  const safety = await step('DescribeSafeRule', META, () => manager.commonService('tcb', '2018-06-08').call({
    Action: 'DescribeSafeRule', Param: {EnvId: envId, CollectionName: META, WxAppId: appId}
  }));
  if (safety?.AclTag !== 'ADMINONLY')
    reject(409, 'collection_permission_unsafe', 'META 当前微信规则不是仅管理端读写；未写入媒体就绪标记。');
  const db = getDatabase();
  const read = async name => {
    const result = await db.collection(META).doc(markerKey(name)).get();
    return Array.isArray(result.data) ? result.data[0] : result.data;
  };
  const provision = await step('ReadReadyMarker', META, () => read('provision-ready'));
  if (!matchesMarker(provision, appId, envId) || provision.id !== 'provision-ready' || provision.ready !== true)
    reject(409, 'verification_incomplete', '当前应用集合尚未核验就绪；未写入媒体就绪标记。');
  const previous = await step('ReadMediaStorageMarker', META, () => read(MARKER));
  if (previous && (previous.id !== MARKER || previous.appId !== appId || previous.envId !== envId))
    reject(409, 'project_marker_conflict', '已有媒体就绪标记归属不匹配；未覆盖。');
  const record = db.collection(META).doc(markerKey(MARKER));
  if (previous?.ready === true)
    await step('InvalidateMediaStorageMarker', META, () => record.set({data: {
      id: MARKER, appId, envId, acl: 'UNVERIFIED', mediaPolicy: MEDIA_POLICY, ready: false, verifiedAt: new Date(now()).toISOString()
    }}));
  const info = await step('GetStorageAcl', undefined, () => manager.storage.getStorageAcl({withRule: true}));
  if (!info || !ACLS.includes(info.acl))
    reject(409, 'storage_permission_unknown', '共享存储权限无法确认；未更改存储规则。');
  let privateProbeVerified = false, probeVerifiedAt;
  if (info.acl === 'PRIVATE') {
    const probe = await step('ReadCompletedStorageProbe', META, () => read('media-storage-probe'));
    const result = probe?.result, checked = Date.parse(result?.checkedAt);
    privateProbeVerified = !!probe && probe.id === 'media-storage-probe' && probe.appId === appId && probe.envId === envId && probe.operatorAccountId === accountId && probe.state === 'finished' && /^[a-f0-9]{48}$/.test(probe.nonce || '') && result?.nonce === probe.nonce && result.representative === true && result.fileIntact === true && result.cleanedUp === true && Number.isFinite(checked) && checked <= now();
    if (privateProbeVerified) probeVerifiedAt = result.checkedAt;
  }
  // PRIVATE is accepted for non-sensitive product display assets after a
  // representative integrity probe. It does NOT prove client read isolation:
  // actual wx.cloud tests could read server-created files by their full ID.
  const storageReady = info.acl === 'ADMINONLY' || info.acl === 'PRIVATE' && privateProbeVerified;
  const verifiedAt = new Date(now()).toISOString();
  const hasCustomRule = info.acl === 'CUSTOM' && info.rule !== undefined;
  const storage = {acl: info.acl, hasCustomRule, ...(hasCustomRule ? {ruleHash: digest(JSON.stringify(info.rule))} : {})};
  // Never spread a read-back document: the SDK reserves the returned _id.
  await step('SaveMediaStorageMarker', META, () => record.set({data: {
    id: MARKER, appId, envId, acl: info.acl, mediaPolicy: MEDIA_POLICY, ready: storageReady, verifiedAt,
    ...(probeVerifiedAt ? {probeVerifiedAt} : {})
  }}));
  return {status: 200, body: {storage, mediaPolicy: MEDIA_POLICY, storageReady, ...(info.acl === 'PRIVATE' ? {privateProbeVerified} : {}), verificationSnapshot: true, verifiedAt, storageRulesChanged: false}};
}
module.exports = {storageInspect};
