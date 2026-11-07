import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryCloudbaseDB} from './fixtures/cloudbase-db.mjs';
const require = createRequire(import.meta.url);
const {createProvision} = require('../cloudfunctions/provision/lib/provision');
const {digest, markerKey, schemaVersion, manifestHash} = require('../cloudfunctions/provision/lib/contract');
const APPID = 'wx1111111111111111', ENV = 'cloud1-probe-test';
const account = 'wechat:' + digest(APPID + '\0operator');
const start = {operation: 'storage-probe-start', apply: true}, finish = {operation: 'storage-probe-finish', apply: true};
const key = markerKey('media-storage-probe');
function fixture() {
  const memory = new MemoryCloudbaseDB(), files = new Map(), writes = [], deletes = [];
  const config = {WECHAT_APP_ID: APPID, CLOUDBASE_ENV_ID: ENV, PROVISION_OPERATOR_ACCOUNT_ID: account};
  const context = {APPID, ENV, OPENID: 'operator'};
  const state = {memory, files, writes, deletes, config, context, acl: 'PRIVATE', metaAcl: 'ADMINONLY', managerCreations: 0};
  const idFor = path => 'cloud://' + ENV + '.bucket/' + path;
  memory.write('lsf_meta', markerKey('provision-ready'), {id: 'provision-ready', appId: APPID, envId: ENV, schemaVersion, manifestHash, ready: true});
  const manager = {commonService: () => ({call: async request => {
    assert.deepEqual(request, {Action: 'DescribeSafeRule', Param: {EnvId: ENV, CollectionName: 'lsf_meta', WxAppId: APPID}});
    return {AclTag: state.metaAcl};
  }}), storage: {
    getStorageAcl: async options => {assert.deepEqual(options, {withRule: true});return {acl: state.acl};},
    getUploadMetadata: async () => assert.fail('Manager must never pre-mint probe metadata'),
    getFileInfo: async path => {const bytes = files.get(idFor(path));if (!bytes) throw Object.assign(Error('missing'), {statusCode: 404});return {Size: (bytes.length / 1024).toFixed(2)};},
    deleteFile: async paths => {assert.deepEqual(paths, [state.marker().path]);deletes.push(idFor(paths[0]));files.delete(idFor(paths[0]));}
  }};
  const cloud = {
    uploadFile: async ({cloudPath, fileContent}) => {
      assert.match(cloudPath, /^lsf-media\/probes\/[a-f0-9]{48}\.png$/);assert.ok(Buffer.isBuffer(fileContent));
      const marker = state.marker();assert.equal(marker.path, cloudPath, 'Key is persisted before upload');
      assert.equal(marker.fileID, null, 'Probe must receive the file ID only from the wx SDK upload');assert.equal(marker.state, 'uploading');
      writes.push(cloudPath);files.set(idFor(cloudPath), Buffer.from(fileContent));
      if (state.uploadResponseLost) throw Object.assign(Error('SECRET_TOKEN lost response'), {code: 'InternalError'});
      return {fileID: idFor(cloudPath)};
    },
    getTempFileURL: async ({fileList}) => {assert.deepEqual(fileList, [{fileID: state.marker().fileID, maxAge: 300}]);return {fileList: [{fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://probe.tcb.qcloud.la/test?signature=short-lived'}]};},
    downloadFile: async ({fileID}) => {state.downloads = (state.downloads || 0) + 1;return {fileContent: files.get(fileID)};},
    deleteFile: async ({fileList}) => {
      assert.equal(fileList.length, 1);assert.equal(fileList[0], state.marker().fileID);deletes.push(fileList[0]);
      if (state.deleteFailure) return {fileList: [{fileID: fileList[0], status: -503002}]};
      const existed = files.delete(fileList[0]);return {fileList: [{fileID: fileList[0], status: existed ? 0 : -503003}]};
    }
  };
  state.marker = () => memory.read('lsf_meta', key);
  state.invoke = createProvision({getConfig: () => config, getContext: () => context, createManager: env => {assert.equal(env, ENV);state.managerCreations++;return manager;}, getDatabase: () => memory, getStorage: () => cloud, now: () => Date.parse('2026-11-07T00:00:00Z')});
  return state;
}
test('probe requires explicit apply and exact trusted operator before any resource access', async () => {
  const f = fixture();
  for (const operation of [start.operation, finish.operation]) for (const body of [{operation}, {operation, apply: false}, {operation, apply: true, path: 'other'}, {operation, apply: true, nonce: 'other'}, {operation, apply: true, clientDenied: true}])
    assert.equal((await f.invoke(body)).status, 400);
  assert.equal(f.managerCreations, 0);
  for (const change of [f => delete f.config.PROVISION_OPERATOR_ACCOUNT_ID, f => {f.context.OPENID = 'buyer';}, f => {f.context.APPID = 'wx2222222222222222';}, f => {f.context.ENV = 'other-env';}]) {
    const denied = fixture();change(denied);assert.notEqual((await denied.invoke(start)).status, 200);assert.equal(denied.managerCreations, 0);
  }
});
test('one persisted probe uses a fixed small PNG and repeated start never overwrites it', async () => {
  const f = fixture(), result = await f.invoke(start);
  assert.equal(result.status, 200);assert.equal(result.body.replayed, false);assert.match(result.body.probe.path, /^lsf-media\/probes\/[a-f0-9]{48}\.png$/);
  assert.equal(f.writes.length, 1);assert.ok(!/SECRET_TOKEN|PRIVATE_TOKEN|authorization/.test(JSON.stringify(result)));
  assert.deepEqual((await f.invoke(start)).body.probe, result.body.probe);assert.equal(f.writes.length, 1);
  const finished = await f.invoke(finish);assert.equal(finished.status, 200);assert.equal(finished.body.fileIntact, true);assert.equal(finished.body.serverReadable, true);assert.equal(finished.body.cleanedUp, true);assert.equal(finished.body.ownerMetadataAvailable, false);
  assert.equal(f.files.size, 0);assert.equal(f.marker().state, 'finished');assert.equal(f.memory.read('lsf_meta', markerKey('media-storage-ready')), null, 'Probe never enables media readiness');
  assert.equal((await f.invoke(finish)).body.replayed, true);assert.equal(f.deletes.length, 1);
  const next = await f.invoke(start);assert.equal(next.status, 200);assert.notEqual(next.body.probe.path, result.body.probe.path);
});
test('lost upload response leaves a single recoverable file and never creates another on retry', async () => {
  const f = fixture();f.uploadResponseLost = true;
  const failed = await f.invoke(start);assert.equal(failed.status, 503);assert.ok(!JSON.stringify(failed).includes('SECRET_TOKEN'));
  const replay = await f.invoke(start);assert.equal(replay.status, 200);assert.equal(replay.body.probe.representative, false);assert.equal(replay.body.probe.needsCleanup, true);assert.equal(replay.body.probe.fileID, null);assert.equal(f.writes.length, 1);
  const cleaned = await f.invoke(finish);assert.equal(cleaned.body.fileIntact, false);assert.equal(cleaned.body.representative, false);assert.equal(cleaned.body.cleanedUp, true);assert.equal(f.files.size, 0);
});
test('overwritten, deleted or oversized probe cannot pass and only its own file is cleaned', async () => {
  for (const mode of ['overwrite', 'delete', 'oversize']) {
    const f = fixture();await f.invoke(start);const row = f.marker();f.files.set('unrelated-file', Buffer.from('preserve'));
    if (mode === 'delete') f.files.delete(row.fileID);
    else f.files.set(row.fileID, Buffer.alloc(mode === 'oversize' ? 2048 : 20));
    const result = await f.invoke(finish);assert.equal(result.status, 200);assert.equal(result.body.fileIntact, false);assert.equal(result.body.cleanedUp, true);
    assert.equal(f.files.size, 1);assert.ok(f.files.has('unrelated-file'));if (mode === 'oversize') assert.equal(f.downloads || 0, 0);
  }
});
test('foreign marker, unsafe metadata and public storage never create or delete files', async () => {
  for (const type of ['foreign', 'unsafe', 'public']) {
    const f = fixture();if (type === 'foreign') f.memory.write('lsf_meta', key, {id: 'foreign'});if (type === 'unsafe') f.metaAcl = 'READONLY';if (type === 'public') f.acl = 'READONLY';
    assert.notEqual((await f.invoke(start)).status, 200);assert.equal(f.writes.length, 0);assert.equal(f.deletes.length, 0);
  }
});
test('cleanup failure preserves the active exact probe for a later finish', async () => {
  const f = fixture();await f.invoke(start);f.deleteFailure = true;
  assert.equal((await f.invoke(finish)).body.error.code, 'storage_probe_cleanup_incomplete');assert.equal(f.marker().state, 'active');
  assert.equal((await f.invoke(start)).body.replayed, true);assert.equal(f.writes.length, 1);
  f.deleteFailure = false;assert.equal((await f.invoke(finish)).body.cleanedUp, true);
});
