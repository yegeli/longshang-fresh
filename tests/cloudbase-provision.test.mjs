import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryCloudbaseDB} from './fixtures/cloudbase-db.mjs';
const require=createRequire(import.meta.url);
const {createProvision,indexName,validateIndexes,LEASE_MS,INVOCATION_BUDGET_MS,VERIFY_WINDOW_MS}=require('../cloudfunctions/provision/lib/provision');
const {manifest,manifestHash,canonicalManifest,digest,markerKey}=require('../cloudfunctions/provision/lib/contract');
const {runtimeConfig}=require('../cloudfunctions/provision/lib/config');
const APPID='wx1111111111111111',ENV_ID='cloud1-test-environment';
const account=openid=>'wechat:'+digest(APPID+'\0'+openid);
const copy=value=>structuredClone(value);
const idIndex=()=>({Name:'_id_',Unique:true,Keys:[{Name:'_id',Direction:'1'}]});
const wechatIndexes=()=>[
 {Name:'_openid_1',Keys:[{Name:'_openid',Direction:'1'}],Unique:false,Sparse:false,PartialFilterExpression:''},
 {Name:'_id_',Keys:[{Name:'_id',Direction:'1'}],Unique:false,Sparse:false,PartialFilterExpression:''}
];
function fixture({operator=true}={}) {
  const memory=new MemoryCloudbaseDB(),tables=new Map(),calls=[];
  let time=Date.parse('2026-11-03T03:00:00.000Z');
  const config={WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV_ID,...(operator?{PROVISION_OPERATOR_ACCOUNT_ID:account('operator')}:{})};
  const context={APPID,OPENID:'operator',ENV:ENV_ID};
  const state={memory,tables,calls,config,context,hook:null,dbCalls:0,managerCreations:0,created:[],indexWrites:[],runtimeWrites:[],runtimeInfo:{FunctionName:'longshang-market',Timeout:3,Status:'Active',MemorySize:128,Role:'PRIVATE_ROLE',Environment:{Variables:[{Key:'PRIVATE_KEY',Value:'SECRET_TOKEN'}]},CodeInfo:'PRIVATE_CODE'},envInfo:{EnvInfo:{EnvId:ENV_ID,Databases:[{Status:'RUNNING',InstanceId:'tnt-example'}]}}};
  state.provisionRuntimeInfo={...copy(state.runtimeInfo),FunctionName:'longshang-provision'};
  // Model the SDK boundary: all real reads include _id, while doc.set may not
  // write it, including a read/spread/set cycle inside a transaction.
  const boundary=database=>({
    collection(name){
      const collection=database.collection(name),originalDoc=collection.doc.bind(collection);
      collection.doc=id=>{
        const d=originalDoc(id),set=d.set.bind(d);
        d.set=async({data})=>{assert.equal(Object.hasOwn(data,'_id'),false,'SDK doc.set rejects the reserved _id field');state.documentWrites=(state.documentWrites||0)+1;return set({data});};
        return d;
      };
      return collection;
    },
    commit:()=>database.commit(),rollback:()=>database.rollback()
  });
  const db={
    collection(name){assert.ok(manifest.collections.includes(name),'No nonmanifest collection access');state.dbCalls++;const collection=memory.collection(name);const originalDoc=collection.doc.bind(collection);collection.doc=id=>{const d=originalDoc(id);const get=d.get.bind(d);d.get=async()=>{if(!tables.has(name))throw Object.assign(Error('missing collection'),{code:'DATABASE_COLLECTION_NOT_EXIST'});return get();};return d;};collection.count=async()=>({total:memory.dump(name).length});return collection;},
    startTransaction:async()=>boundary(await memory.startTransaction())
  };
  const common={async call(request){
    const {Action,Param}=request;calls.push(copy(request));await state.hook?.(request);
    assert.equal(Param.EnvId,ENV_ID);
    if(Action==='GetFunction'){
      assert.ok(['longshang-market','longshang-provision'].includes(Param.FunctionName));
      assert.deepEqual(Param,{EnvId:ENV_ID,FunctionName:Param.FunctionName});
      return copy(Param.FunctionName==='longshang-market'?state.runtimeInfo:state.provisionRuntimeInfo);
    }
    if(Action==='UpdateFunctionConfiguration'){
      assert.ok(['longshang-market','longshang-provision'].includes(Param.FunctionName));
      assert.deepEqual(Param,{EnvId:ENV_ID,FunctionName:Param.FunctionName,Timeout:Param.FunctionName==='longshang-market'?30:15});
      state.runtimeWrites.push(copy(request));
      if(!state.delayRuntime)(Param.FunctionName==='longshang-market'?state.runtimeInfo:state.provisionRuntimeInfo).Timeout=Param.Timeout;
      return {};
    }
    const name=Param.TableName||Param.CollectionName;
    assert.ok(manifest.collections.includes(name),'No nonmanifest management API');
    const table=tables.get(name);if(state.apiLatency)time+=state.apiLatency;
    if(Action==='CreateTable'){
      assert.deepEqual(Param,{EnvId:ENV_ID,TableName:name,PermissionInfo:{EnvId:ENV_ID,AclTag:'ADMINONLY'}});
      if(table)throw Object.assign(Error('already exists'),{code:'ResourceUnavailable.ResourceExist'});
      tables.set(name,{acl:'ADMINONLY',rule:'ADMINONLY',Indexes:wechatIndexes()});state.created.push(name);if(state.throwAfterCreate){state.throwAfterCreate=false;throw Object.assign(Error('SECRET_TOKEN lost response'),{code:'InternalError'});}return {};
    }
    if(!table)throw Object.assign(Error('missing table'),{code:'ResourceNotFound.Table'});
    if(Action==='DescribeTable')return {Indexes:copy(table.Indexes)};
    if(Action==='DescribeDatabaseACL')return {AclTag:table.acl};
    if(Action==='DescribeSafeRule'){assert.equal(Param.WxAppId,APPID);return {AclTag:table.rule};}
    if(Action==='UpdateTable'){
      assert.ok(!('DropIndexes' in Param));assert.equal(Param.CreateIndexes.length,1);
      const index=Param.CreateIndexes[0];assert.ok(!table.Indexes.some(i=>i.Name===index.IndexName),'Never recreate an existing index');
      state.indexWrites.push(copy(request));
      if(!state.delayIndexes)table.Indexes.push({Name:index.IndexName,Unique:index.MgoKeySchema.MgoIsUnique,Keys:copy(index.MgoKeySchema.MgoIndexKeys)});
      if(state.throwAfterIndex){state.throwAfterIndex=false;throw Object.assign(Error('SECRET_TOKEN lost response'),{code:'InternalError'});}return {};
    }
    throw Error('Unexpected API '+Action);
  }};
  const invoke=createProvision({getConfig:()=>config,getContext:()=>context,createManager:id=>{assert.equal(id,ENV_ID);state.managerCreations++;return {commonService:(service,version)=>{assert.equal(service,'tcb');assert.equal(version,'2018-06-08');return common;},env:{getEnvInfo:async()=>copy(state.envInfo)}};},getDatabase:()=>db,now:()=>time});
  state.invoke=async event=>{const before=calls.length;const result=await invoke(event);assert.ok(calls.length-before<=2,'Each invocation uses at most two control-plane requests');return result;};
  state.addTable=(name,{acl='ADMINONLY',rule=acl,indexes=wechatIndexes()}={})=>tables.set(name,{acl,rule,Indexes:copy(indexes)});
  state.advance=ms=>{time+=ms;};
  state.marker=name=>memory.read('lsf_meta',markerKey(name));
  return state;
}
const apply={operation:'provision',apply:true};
async function complete(f,{maximum=250}={}) {
 for(let i=0;i<maximum;i++){const result=await f.invoke(apply);assert.equal(result.status,200,JSON.stringify(result));if(result.body.ready)return result;assert.equal(result.body.needsRetry,true);}
 assert.fail('Bounded server-selected steps did not finish');
}
async function until(f,predicate){for(let i=0;i<250;i++){if(predicate(f.marker('provision-state')))return;const r=await f.invoke(apply);assert.equal(r.status,200,JSON.stringify(r));}assert.fail('Checkpoint not reached');}
test('identity and denied/forged requests never initialize the manager or touch database state',async()=>{
 const f=fixture({operator:false});assert.deepEqual(await f.invoke({operation:'identity'}),{status:200,body:{accountId:account('operator')}});assert.equal(f.managerCreations,0);assert.equal(f.dbCalls,0);assert.equal((await f.invoke()).body.error.code,'operator_unconfigured');
 for(const body of [{...apply,collection:'users'},{...apply,phase:'finalize'},{...apply,accountId:account('operator')},{operation:'inspect',apply:true},{operation:'identity',apply:false},[],null])assert.equal((await f.invoke(body)).status,400);
 assert.equal(f.managerCreations,0);assert.equal(f.dbCalls,0);
});
test('trusted application, environment and exact operator binding precede all resource access',async()=>{
 const f=fixture();f.context.OPENID='buyer';assert.equal((await f.invoke(apply)).body.error.code,'operator_forbidden');f.context.OPENID='operator';f.context.ENV='other-env';assert.equal((await f.invoke(apply)).body.error.code,'environment_mismatch');f.context.ENV=ENV_ID;f.context.APPID='wx2222222222222222';assert.equal((await f.invoke(apply)).body.error.code,'wechat_context_invalid');assert.equal(f.managerCreations,0);
});
test('runtime actions require the same trusted app, environment and exact operator before resource access',async()=>{
 for(const operation of ['runtime-inspect','runtime-configure','provision-runtime-inspect','provision-runtime-configure']){
  const f=fixture({operator:false}),event={operation,...(operation.endsWith('configure')?{apply:true}:{})};
  assert.equal((await f.invoke(event)).body.error.code,'operator_unconfigured');
  f.config.PROVISION_OPERATOR_ACCOUNT_ID=account('operator');f.context.OPENID='buyer';assert.equal((await f.invoke(event)).body.error.code,'operator_forbidden');
  f.context.OPENID='operator';f.context.APPID='wx2222222222222222';assert.equal((await f.invoke(event)).body.error.code,'wechat_context_invalid');
  f.context.APPID=APPID;f.context.ENV='other-env';assert.equal((await f.invoke(event)).body.error.code,'environment_mismatch');
  assert.equal(f.calls.length,0);assert.equal(f.dbCalls,0);assert.equal(f.managerCreations,0);
 }
});
test('runtime operation target, timeout and privilege fields cannot be supplied by clients',async()=>{
 const f=fixture();
 for(const operation of ['runtime-configure','provision-runtime-configure'])for(const extra of [{name:'another-function'},{functionName:'longshang-market'},{timeout:30},{Timeout:30},{envId:ENV_ID},{role:'admin'},{memorySize:256},{envVariables:{}}])assert.equal((await f.invoke({operation,apply:true,...extra})).status,400);
 for(const operation of ['runtime-inspect','provision-runtime-inspect'])assert.equal((await f.invoke({operation,apply:true})).status,400);assert.equal(f.calls.length,0);assert.equal(f.dbCalls,0);
});
test('runtime inspection and configure without explicit apply are read-only and expose only an allowlist',async()=>{
 const f=fixture();
 for(const event of [{operation:'runtime-inspect'},{operation:'runtime-configure'},{operation:'runtime-configure',apply:false}]){
  const result=await f.invoke(event);assert.equal(result.status,200);assert.equal(result.body.dryRun,true);assert.equal(result.body.configured,false);
  assert.deepEqual(result.body.runtime,{functionName:'longshang-market',timeoutSeconds:3,targetTimeoutSeconds:30,active:true});
  assert.ok(!/PRIVATE|SECRET_TOKEN|Environment|CodeInfo|Role/.test(JSON.stringify(result)));
 }
 assert.equal(f.runtimeWrites.length,0);assert.equal(f.dbCalls,0);assert.equal(f.memory.dump().length,0);
});
test('runtime configure changes only the fixed timeout and requires a later active readback',async()=>{
 const f=fixture(),before=copy(f.runtimeInfo);
 const result=await f.invoke({operation:'runtime-configure',apply:true});assert.equal(result.status,200);assert.equal(result.body.needsVerification,true);assert.equal(result.body.configured,false);assert.equal(result.body.verificationSnapshot,false);
 assert.deepEqual(f.calls.map(c=>c.Action),['GetFunction','UpdateFunctionConfiguration']);assert.deepEqual(f.runtimeInfo,{...before,Timeout:30});
 const inspected=await f.invoke({operation:'runtime-inspect'});assert.equal(inspected.body.configured,true);assert.equal(inspected.body.verificationSnapshot,true);
 assert.equal((await f.invoke({operation:'runtime-configure',apply:true})).body.configured,true);assert.equal(f.runtimeWrites.length,1);assert.equal(f.dbCalls,0);
});
test('provision runtime targets only its own fixed 15 seconds with explicit apply and Active readback',async()=>{
 const f=fixture(),marketBefore=copy(f.runtimeInfo),provisionBefore=copy(f.provisionRuntimeInfo);
 for(const event of [{operation:'provision-runtime-inspect'},{operation:'provision-runtime-configure'},{operation:'provision-runtime-configure',apply:false}]){
  const result=await f.invoke(event);assert.equal(result.status,200);assert.equal(result.body.dryRun,true);assert.deepEqual(result.body.runtime,{functionName:'longshang-provision',timeoutSeconds:3,targetTimeoutSeconds:15,active:true});
 }
 assert.equal(f.runtimeWrites.length,0);
 const applied=await f.invoke({operation:'provision-runtime-configure',apply:true});assert.equal(applied.body.configured,false);assert.equal(applied.body.needsVerification,true);
 assert.deepEqual(f.provisionRuntimeInfo,{...provisionBefore,Timeout:15});assert.deepEqual(f.runtimeInfo,marketBefore);
 f.provisionRuntimeInfo.Status='Updating';assert.equal((await f.invoke({operation:'provision-runtime-inspect'})).body.configured,false);
 assert.equal((await f.invoke({operation:'provision-runtime-configure',apply:true})).body.error.code,'function_not_active');assert.equal(f.runtimeWrites.length,1);
 f.provisionRuntimeInfo.Status='Active';assert.equal((await f.invoke({operation:'provision-runtime-inspect'})).body.configured,true);
 assert.equal((await f.invoke({operation:'provision-runtime-configure',apply:true})).body.configured,true);assert.equal(f.runtimeWrites.length,1);assert.equal(f.dbCalls,0);
});
test('runtime updating or unverified provider output never reports readiness or blindly resubmits',async()=>{
 const f=fixture();f.delayRuntime=true;await f.invoke({operation:'runtime-configure',apply:true});
 assert.equal((await f.invoke({operation:'runtime-inspect'})).body.configured,false);
 f.runtimeInfo.Status='Updating';f.runtimeInfo.Timeout=30;assert.equal((await f.invoke({operation:'runtime-inspect'})).body.configured,false);
 assert.equal((await f.invoke({operation:'runtime-configure',apply:true})).body.error.code,'function_not_active');assert.equal(f.runtimeWrites.length,1);
 f.runtimeInfo.Status='Active';assert.equal((await f.invoke({operation:'runtime-inspect'})).body.configured,true);
 for(const patch of [{FunctionName:'another-function'},{Timeout:'30'},{Timeout:0}]){const other=fixture();Object.assign(other.runtimeInfo,patch);assert.equal((await other.invoke({operation:'runtime-configure',apply:true})).body.error.code,'function_configuration_unknown');assert.equal(other.runtimeWrites.length,0);}
});
test('runtime provider failures retain only sanitized action and error code without credentials',async()=>{
 for(const action of ['GetFunction','UpdateFunctionConfiguration']){
  const f=fixture();f.hook=async request=>{if(request.Action===action)throw Object.assign(Error('SECRET_TOKEN PRIVATE_ROLE PRIVATE_CODE'),{code:'UnauthorizedOperation.CAM',headers:{Authorization:'SECRET_TOKEN'}});};
  const result=await f.invoke({operation:'runtime-configure',apply:true});assert.equal(result.status,503);assert.equal(result.body.error.operation,action);assert.equal(result.body.error.providerCode,'UnauthorizedOperation.CAM');assert.ok(!/SECRET_TOKEN|PRIVATE|headers|Authorization/.test(JSON.stringify(result)));assert.equal(f.dbCalls,0);
 }
});
test('confirmed SDK INVALID_PARAM is preserved as a fixed error category without provider text',async()=>{
 const f=fixture();f.hook=async()=>{throw Object.assign(Error('SECRET_TOKEN cannot write _id'),{code:'INVALID_PARAM'});};
 const result=await f.invoke({operation:'runtime-inspect'});assert.equal(result.status,503);assert.equal(result.body.error.providerCode,'INVALID_PARAM');assert.ok(!/SECRET_TOKEN|cannot write|stack/.test(JSON.stringify(result)));
});
test('default inspection is read-only and metadata is atomically locked before checkpoints exist',async()=>{
 const f=fixture();let r=await f.invoke();assert.equal(r.body.ready,false);assert.equal(r.body.dryRun,true);assert.equal(f.calls.length,0);assert.equal(f.tables.size,0);
 r=await f.invoke(apply);assert.equal(r.body.ready,false);assert.deepEqual(f.created,['lsf_meta']);assert.equal(f.memory.dump().length,0);assert.equal(f.calls[0].Action,'CreateTable');
 r=await f.invoke({operation:'provision'});assert.equal(r.body.dryRun,true);assert.equal(f.memory.dump().length,0);
 await f.invoke(apply);assert.equal(f.marker('provision-state').formatVersion,2);assert.equal(f.marker('provision-ready'),null);assert.equal(f.tables.get('lsf_meta').acl,'ADMINONLY');
});
test('bounded calls finish exactly the manifest, then separate final receipts permit readiness',async()=>{
 const f=fixture();const result=await complete(f);assert.equal(result.body.ready,true);assert.equal(f.created.length,13);assert.deepEqual([...f.created].sort(),[...manifest.collections].sort());assert.equal(f.indexWrites.length,manifest.indexes.length);assert.ok(f.calls.every(c=>!['ModifyDatabaseACL','ModifySafeRule','DeleteTable','RunCommands'].includes(c.Action)));
 const state=f.marker('provision-state'),marker=f.marker('provision-ready');assert.equal(state.phase,'complete');assert.equal(marker.roundId,state.roundId);assert.equal(marker.verificationMode,'sequential_snapshot');assert.equal(marker.manifestHash,manifestHash);assert.equal(marker.envId,ENV_ID);assert.equal(marker.operatorAccountId,account('operator'));
 for(const name of manifest.collections){assert.equal(state.receipts[name].acl.roundId,state.roundId);assert.equal(state.receipts[name].rule.manifestHash,manifestHash);assert.ok(state.receipts[name].structure);}
 for(const item of manifest.indexes)assert.ok(state.receipts[item.collection]['indexDefinitionVerified:'+indexName(item)]);
 const written=f.indexWrites.length;assert.equal((await f.invoke(apply)).body.ready,true);assert.equal((await f.invoke()).body.ready,true);assert.equal(f.indexWrites.length,written);assert.equal(f.memory.dump().length,2);
});
test('real SDK document ids never become checkpoint payload during lease acquisition, completion or renewed verification',async()=>{
 const f=fixture();await f.invoke(apply);await f.invoke(apply);
 assert.equal(f.marker('provision-state')._id,markerKey('provision-state'),'Fixture reads include the actual database id');
 const resumed=await f.invoke(apply);assert.equal(resumed.status,200);assert.ok(f.documentWrites>=3);
 await complete(f);f.advance(VERIFY_WINDOW_MS+1);assert.equal((await f.invoke(apply)).status,200);await complete(f);
 for(const row of f.memory.dump())assert.equal(Object.hasOwn(row.data,'_id'),false,'Reserved field is not persisted as application data');
});
test('unknown metadata and nonempty existing collections are never silently adopted',async()=>{
 const meta=fixture();meta.addTable('lsf_meta',{acl:'PRIVATE'});assert.equal((await meta.invoke(apply)).body.error.code,'collection_permission_unsafe');assert.equal(meta.memory.dump().length,0);
 const f=fixture();f.addTable('lsf_orders');f.memory.write('lsf_orders','foreign',{private:'preserve'});await until(f,s=>s?.phase==='prepare'&&s.cursor===5&&s.action==='count');const result=await f.invoke(apply);assert.equal(result.body.error.code,'collection_data_unknown');assert.equal(f.memory.read('lsf_orders','foreign').private,'preserve');assert.equal(f.marker('provision-ready'),null);
});
test('each call checks current META safety and every collection has both final ACL receipts',async()=>{
 const f=fixture();await f.invoke(apply);await f.invoke(apply);const before=f.marker('provision-state');f.tables.get('lsf_meta').rule='PRIVATE';const r=await f.invoke(apply);assert.equal(r.body.error.code,'collection_permission_unsafe');assert.deepEqual(f.marker('provision-state'),before);
 const other=fixture();await until(other,s=>s?.phase==='verify'&&s.cursor===1&&s.action==='rule');other.tables.get('lsf_users').rule='READONLY';assert.equal((await other.invoke(apply)).body.error.code,'collection_permission_unsafe');assert.equal(other.marker('provision-ready'),null);
});
test('unknown indexes fail without deleting or rebuilding existing definitions',async()=>{
 const f=fixture();const item=manifest.indexes[0];f.addTable(item.collection,{indexes:[idIndex(),{Name:'foreign',Unique:false,Keys:[{Name:'foreign',Direction:'1'}]}]});await until(f,s=>s?.cursor===3&&s.action==='describe');const result=await f.invoke(apply);assert.equal(result.status,409);assert.equal(result.body.error.code,'collection_structure_unknown');assert.equal(f.marker('provision-ready'),null);assert.equal(f.indexWrites.length,0);
});
test('actual WeChat built-in index metadata is accepted only with the exact known key and flag shapes',()=>{
 assert.deepEqual(validateIndexes('lsf_meta',{Indexes:wechatIndexes()}),[]);
 assert.deepEqual(validateIndexes('lsf_meta',{Indexes:[idIndex()]}),[],'Preserve the former unique _id metadata form');
 for(const base of wechatIndexes())for(const patch of [{Name:'foreign'},{Keys:[{Name:'foreign',Direction:'1'}]},{Keys:[{Name:base.Keys[0].Name,Direction:'-1'}]},{Sparse:true},{PartialFilterExpression:'{"foreign":true}'},{Unique:'false'},...(base.Name==='_openid_1'?[{Unique:true}]:[])])
  assert.throws(()=>validateIndexes('lsf_meta',{Indexes:[{...base,...patch}]}),error=>error.code==='collection_structure_unknown');
 const withoutFlags={...wechatIndexes()[1]};delete withoutFlags.Sparse;assert.throws(()=>validateIndexes('lsf_meta',{Indexes:[withoutFlags]}),error=>error.code==='collection_structure_unknown');
 assert.throws(()=>validateIndexes('lsf_meta',{Indexes:[...wechatIndexes(),{Name:'extra',Unique:false,Keys:[{Name:'foreign',Direction:'1'}]}]}),error=>error.code==='collection_structure_unknown');
});
test('lost index-write response recovers from persisted intent and never repeats the destructive request',async()=>{
 const f=fixture();await until(f,s=>s?.action==='index-write');f.throwAfterIndex=true;const failed=await f.invoke(apply);assert.equal(failed.status,503);assert.ok(!JSON.stringify(failed).includes('SECRET_TOKEN'));assert.equal(f.marker('provision-state').action,'index-recover');const before=f.indexWrites.length;
 assert.equal((await f.invoke(apply)).body.error.code,'provision_busy');f.advance(LEASE_MS+1);assert.equal((await f.invoke(apply)).status,200);assert.equal(f.indexWrites.length,before);await complete(f);assert.equal(f.indexWrites.length,manifest.indexes.length);
});
test('lost atomic META-create response is recovered without creating or overwriting another collection',async()=>{
 const f=fixture();f.throwAfterCreate=true;assert.equal((await f.invoke(apply)).status,503);assert.equal(f.created.length,1);const recovered=await f.invoke(apply);assert.equal(recovered.status,200);assert.equal(f.created.length,1);assert.equal(f.marker('provision-state').formatVersion,2);await complete(f);assert.equal(f.created.length,13);
});
test('a slow metadata check exhausts the invocation budget before another cloud action starts',async()=>{
 const f=fixture();await f.invoke(apply);await f.invoke(apply);const version=f.marker('provision-state').version,callCount=f.calls.length;f.apiLatency=INVOCATION_BUDGET_MS+1;const r=await f.invoke(apply);assert.equal(r.body.reason,'time_budget');assert.equal(f.calls.length-callCount,1);assert.equal(f.marker('provision-state').version,version);f.apiLatency=0;await complete(f);
});
test('an expired final verification window discards old receipts and starts a fresh final pass',async()=>{
 const f=fixture();await until(f,s=>s?.phase==='verify'&&s.cursor===2);const old=f.marker('provision-state').verificationStartedAt;assert.ok(Object.keys(f.marker('provision-state').receipts).length);f.advance(VERIFY_WINDOW_MS+1);const r=await f.invoke(apply);assert.equal(r.status,200);const reset=f.marker('provision-state');assert.equal(reset.cursor,0);assert.equal(reset.action,'rule');assert.notEqual(reset.verificationStartedAt,old);assert.deepEqual(Object.keys(reset.receipts),['lsf_meta']);await complete(f);
});
test('a later apply renews an expired completed snapshot instead of trusting old receipts',async()=>{
 const f=fixture();await complete(f);const round=f.marker('provision-state').roundId;f.advance(VERIFY_WINDOW_MS+1);const r=await f.invoke(apply);assert.equal(r.body.ready,false);assert.equal(r.body.reason,'verification_snapshot_expired');assert.equal(f.marker('provision-ready').ready,false);assert.notEqual(f.marker('provision-state').roundId,round);assert.deepEqual(f.marker('provision-state').receipts,{});await complete(f);assert.equal(f.indexWrites.length,manifest.indexes.length);
});
test('an asynchronous index not yet visible is polled without re-issuing its creation',async()=>{
 const f=fixture();await until(f,s=>s?.action==='index-write');f.delayIndexes=true;await f.invoke(apply);const result=await f.invoke(apply);assert.equal(result.body.ready,false);assert.equal(result.body.reason,'index_definition_pending');assert.equal(f.marker('provision-ready'),null);assert.equal(f.marker('provision-state').action,'index-recover');
 for(let i=0;i<5;i++)assert.equal((await f.invoke(apply)).body.reason,'index_definition_pending');assert.equal(f.indexWrites.length,1);
 // Simulate the control plane completing its accepted asynchronous build.
 const request=f.indexWrites[0],index=request.Param.CreateIndexes[0];f.tables.get(request.Param.TableName).Indexes.push({Name:index.IndexName,Unique:false,Keys:copy(index.MgoKeySchema.MgoIndexKeys)});
 await f.invoke(apply);assert.equal(f.indexWrites.length,1);f.delayIndexes=false;await complete(f);assert.equal(f.indexWrites.length,manifest.indexes.length);
});
test('runtime configuration refuses credentials, unsupported keys and mismatched deployment identifiers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lsf-provision-')),file=join(dir,'runtime.config.json');try{const value={WECHAT_APP_ID:APPID,CLOUDBASE_ENV_ID:ENV_ID};writeFileSync(file,JSON.stringify(value));assert.deepEqual(runtimeConfig({},file),value);assert.throws(()=>runtimeConfig({CLOUDBASE_ENV_ID:'other-env'},file),/invalid_config/);for(const extra of [{AppSecret:'never'},{secretId:'never'},{role:'admin'},{PROVISION_OPERATOR_ACCOUNT_ID:'buyer'}]){writeFileSync(file,JSON.stringify({...value,...extra}));assert.throws(()=>runtimeConfig({},file),/invalid_config/);}}finally{rmSync(dir,{recursive:true,force:true});}
});
test('independent deployable packages retain an identical manifest fingerprint',()=>{const market=require('../cloudfunctions/market/lib/provision-contract');assert.equal(canonicalManifest,market.canonicalManifest);assert.equal(manifestHash,market.manifestHash);assert.deepEqual(manifest,require('../cloudfunctions/market/collections.json'));});
