import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryCloudbaseDB} from './fixtures/cloudbase-db.mjs';
const require = createRequire(import.meta.url);
const {createProvision} = require('../cloudfunctions/provision/lib/provision');
const {digest, markerKey, schemaVersion, manifestHash} = require('../cloudfunctions/provision/lib/contract');
const APPID = 'wx1111111111111111', ENV = 'cloud1-storage-test';
const operator = 'wechat:' + digest(APPID + '\0operator');
const request = {operation: 'storage-inspect'};
const mediaKey = markerKey('media-storage-ready');
function fixture() {
  const memory = new MemoryCloudbaseDB(), calls = [];
  const config = {WECHAT_APP_ID: APPID, CLOUDBASE_ENV_ID: ENV, PROVISION_OPERATOR_ACCOUNT_ID: operator};
  const context = {APPID, ENV, OPENID: 'operator'};
  const state = {memory, calls, config, context, acl: {acl: 'ADMINONLY'}, metaAcl: 'ADMINONLY', managerCreations: 0, databaseCalls: 0};
  memory.write('lsf_meta', markerKey('provision-ready'), {id: 'provision-ready', schemaVersion, manifestHash, appId: APPID, envId: ENV, ready: true});
  const manager = {
    commonService(service, version) {
      assert.equal(service, 'tcb');assert.equal(version, '2018-06-08');
      return {call: async value => {
        calls.push(value);
        assert.deepEqual(value, {Action: 'DescribeSafeRule', Param: {EnvId: ENV, CollectionName: 'lsf_meta', WxAppId: APPID}});
        return {AclTag: state.metaAcl};
      }};
    },
    storage: {getStorageAcl: async options => {
      assert.deepEqual(options, {withRule: true});calls.push({Action: 'GetStorageAcl'});
      if (state.failure) throw state.failure;
      return structuredClone(state.acl);
    }}
  };
  const db = {collection(name) {
    state.databaseCalls++;assert.equal(name, 'lsf_meta');
    const collection = memory.collection(name), original = collection.doc.bind(collection);
    collection.doc = key => {
      assert.ok([mediaKey, markerKey('provision-ready'), markerKey('media-storage-probe')].includes(key));
      const document = original(key), set = document.set.bind(document);
      document.set = async value => {assert.equal(key, mediaKey);assert.equal(Object.hasOwn(value.data, '_id'), false);return set(value);};
      return document;
    };
    return collection;
  }};
  state.invoke = createProvision({getContext: () => context, getConfig: () => config, createManager: id => {
    assert.equal(id, ENV);state.managerCreations++;return manager;
  }, getDatabase: () => db, now: () => Date.parse('2026-11-07T00:00:00Z')});
  state.marker = () => memory.read('lsf_meta', mediaKey);
  return state;
}
test('storage inspection verifies exact app, environment and operator before any resources', async () => {
  for (const mutation of [f => delete f.config.PROVISION_OPERATOR_ACCOUNT_ID, f => {f.context.OPENID = 'buyer';}, f => {f.context.APPID = 'wx2222222222222222';}, f => {f.context.ENV = 'other-env';}]) {
    const f = fixture();mutation(f);assert.notEqual((await f.invoke(request)).status, 200);
    assert.equal(f.calls.length, 0);assert.equal(f.managerCreations, 0);assert.equal(f.databaseCalls, 0);assert.equal(f.marker(), null);
  }
  const f = fixture();
  for (const extra of [{apply: true}, {apply: false}, {envId: ENV}, {path: 'other'}, {acl: 'ADMINONLY'}, {rule: {read: true}}, {fileID: 'cloud://anything'}])
    assert.equal((await f.invoke({...request, ...extra})).status, 400);
  assert.equal(f.calls.length, 0);
});
test('ADMINONLY storage inspection writes only the fixed project record and never mutates storage', async () => {
  const f = fixture(), result = await f.invoke(request);
  assert.equal(result.status, 200);assert.equal(result.body.storageReady, true);assert.equal(result.body.storageRulesChanged, false);
  assert.deepEqual(result.body.storage, {acl: 'ADMINONLY', hasCustomRule: false});
  const {_id, ...record} = f.marker();
  assert.deepEqual(record, {id: 'media-storage-ready', appId: APPID, envId: ENV, acl: 'ADMINONLY', mediaPolicy: 'server-owned-display-v1', ready: true, verifiedAt: '2026-11-07T00:00:00.000Z'});
  assert.equal(f.memory.dump().length, 2);assert.equal(f.calls.length, 2);
});
test('PRIVATE permits only display-media policy after a completed representative integrity probe', async () => {
  const f = fixture();f.acl = {acl: 'PRIVATE'};
  const nonce = 'a'.repeat(48), checkedAt = '2026-11-06T23:59:00.000Z';
  const probe = {id: 'media-storage-probe', appId: APPID, envId: ENV, operatorAccountId: operator, nonce, state: 'finished', result: {nonce, representative: true, fileIntact: true, cleanedUp: true, checkedAt}};
  for (const patch of [null, {appId: 'other-app'}, {envId: 'other-env'}, {operatorAccountId: 'other'}, {state: 'active'}, {nonce: 'other'}, {result: {...probe.result, representative: false}}, {result: {...probe.result, fileIntact: false}}, {result: {...probe.result, cleanedUp: false}}, {result: {...probe.result, checkedAt: '2026-11-08T00:00:00Z'}}, {result: {...probe.result, checkedAt: 'invalid'}}]) {
    if (patch) f.memory.write('lsf_meta', markerKey('media-storage-probe'), {...probe, ...patch});
    const rejected = await f.invoke(request);assert.equal(rejected.status, 200);assert.equal(rejected.body.storageReady, false);assert.equal(f.marker().ready, false);
  }
  f.memory.write('lsf_meta', markerKey('media-storage-probe'), probe);
  const permitted = await f.invoke(request);assert.equal(permitted.status, 200);assert.equal(permitted.body.storageReady, true);assert.equal(permitted.body.privateProbeVerified, true);
  assert.equal(f.marker().mediaPolicy, 'server-owned-display-v1');assert.equal(f.marker().probeVerifiedAt, checkedAt);assert.equal(f.marker().acl, 'PRIVATE');
  assert.equal(Object.hasOwn(f.marker(), 'readPrivate'), false, 'Integrity readiness never claims read confidentiality');
});
test('unsafe and custom storage rules invalidate previous readiness and return only a digest', async () => {
  for (const acl of ['READONLY', 'PRIVATE', 'ADMINWRITE', 'CUSTOM']) {
    const f = fixture();await f.invoke(request);const rawRule = {read: 'SECRET_TOKEN PRIVATE_RULE', write: true};
    f.acl = {acl, rule: rawRule};const result = await f.invoke(request);
    assert.equal(result.status, 200);assert.equal(result.body.storageReady, false);assert.equal(f.marker().ready, false);assert.equal(f.marker().acl, acl);
    assert.equal(result.body.storage.hasCustomRule, acl === 'CUSTOM');
    if (acl === 'CUSTOM') assert.equal(result.body.storage.ruleHash, digest(JSON.stringify(rawRule)));
    assert.ok(!/SECRET_TOKEN|PRIVATE_RULE|read|write/.test(JSON.stringify(result.body.storage)));
  }
});
test('inspection failure or unknown ACL invalidates an old ready snapshot and redacts provider details', async () => {
  for (const failure of [false, true]) {
    const f = fixture();await f.invoke(request);
    if (failure) f.failure = Object.assign(Error('SECRET_TOKEN PRIVATE_HEADERS'), {code: 'UnauthorizedOperation.CAM'});
    else f.acl = {acl: 'unexpected'};
    const result = await f.invoke(request);assert.notEqual(result.status, 200);assert.equal(f.marker().ready, false);
    assert.ok(!/SECRET_TOKEN|PRIVATE_HEADERS|stack/.test(JSON.stringify(result)));
    if (failure) assert.equal(result.body.error.providerCode, 'UnauthorizedOperation.CAM');
  }
});
test('unsafe metadata, incomplete project initialization and foreign marker stop storage inspection', async () => {
  const unsafe = fixture();unsafe.metaAcl = 'READONLY';assert.equal((await unsafe.invoke(request)).body.error.code, 'collection_permission_unsafe');assert.equal(unsafe.databaseCalls, 0);
  const incomplete = fixture();incomplete.memory.write('lsf_meta', markerKey('provision-ready'), {ready: false});
  assert.equal((await incomplete.invoke(request)).body.error.code, 'verification_incomplete');assert.equal(incomplete.calls.length, 1);assert.equal(incomplete.marker(), null);
  const foreign = fixture();foreign.memory.write('lsf_meta', mediaKey, {id: 'media-storage-ready', appId: 'other-app', envId: ENV, ready: true});
  const before = foreign.marker();assert.equal((await foreign.invoke(request)).body.error.code, 'project_marker_conflict');assert.deepEqual(foreign.marker(), before);assert.equal(foreign.calls.length, 1);
});
