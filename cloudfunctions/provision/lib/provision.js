'use strict';
const { randomUUID } = require('node:crypto');
const { manifest, digest, schemaVersion, manifestHash, markerKey, matchesMarker } = require('./contract');
const { marketRuntime } = require('./runtime');
const META = 'lsf_meta';
const LEASE_MS = 6000;
const INVOCATION_BUDGET_MS = 2200;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const UNCERTAIN_WRITE_WAIT_MS = 65000;
const COLLECTION_NAMES = ['lsf_users','lsf_sessions','lsf_products','lsf_inventory','lsf_orders','lsf_order_requests','lsf_shopping','lsf_order_consumptions','lsf_merchants','lsf_merchant_ids','lsf_merchant_audit','lsf_inventory_events','lsf_meta'];
class ProvisionError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const reject = (status, code, message) => { throw new ProvisionError(status, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const expectedKeys = item => item.fields.map(([Name, order]) => ({ Name, Direction: order === 'asc' ? '1' : '-1' }));
const indexName = item => 'lsf_' + digest(JSON.stringify(item)).slice(0, 20);
const unique = value => value === true || value === 'true';
const validAccount = value => typeof value === 'string' && /^wechat:[a-f0-9]{64}$/.test(value);
const isReady = value => value?.id === 'provision-ready' && value.ready === true && validAccount(value.operatorAccountId) && typeof value.verifiedAt === 'string' && Number.isFinite(Date.parse(value.verifiedAt));
function sameKeys(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, i) => item.Name === expected[i].Name && String(item.Direction) === expected[i].Direction);
}
function matchingIndex(index, expected) { return !unique(index.Unique) && sameKeys(index.Keys, expectedKeys(expected)); }
function validateIndexes(collection, info) {
  if (!info || !Array.isArray(info.Indexes)) reject(409, 'collection_structure_unknown', '集合索引结构无法确认；未覆盖已有结构。');
  const wanted = manifest.indexes.filter(item => item.collection === collection);
  for (const index of info.Indexes) {
    const isId = index.Name === '_id_' && sameKeys(index.Keys, [{Name:'_id',Direction:'1'}]) && unique(index.Unique);
    if (!isId && !wanted.some(item => matchingIndex(index, item))) reject(409, 'collection_structure_unknown', '已有集合包含预期之外的索引；请管理员核对，不自动删除或重建。');
    if (wanted.some(item => index.Name === indexName(item) && !matchingIndex(index, item))) reject(409, 'index_conflict', '索引同名但结构不同；本次没有覆盖。');
  }
  return wanted.filter(item => !info.Indexes.some(index => matchingIndex(index, item)));
}
function providerCode(error) {
  const code = error && error.code;
  return typeof code === 'string' && /^(UnauthorizedOperation|FailedOperation|InternalError|InvalidParameter|InvalidParameterValue|MissingParameter|ResourceNotFound|ResourceUnavailable|LimitExceeded|AuthFailure|RequestLimitExceeded|UnsupportedOperation)(\.[A-Za-z][A-Za-z0-9]{0,40}){0,3}$/.test(code) ? code : 'provider_error';
}
const missingCollection = error => ['ResourceNotFound.Table','ResourceNotFound','DATABASE_COLLECTION_NOT_EXIST',-502005].includes(error?.code) || error?.errCode === -502005;
const collectionOrder = [META,...COLLECTION_NAMES.filter(name=>name!==META)];
function validState(state,appId,envId) {
  return matchesMarker(state,appId,envId) && state.id==='provision-state' && validAccount(state.operatorAccountId) && state.formatVersion===2 && /^[a-f0-9-]{36}$/.test(state.roundId||'') && Number.isSafeInteger(state.version) && state.version>0 && ['prepare','verify','complete'].includes(state.phase) && Number.isInteger(state.cursor) && state.cursor>=0 && state.cursor<13 && ['describe','create-write','create-recover','acl','rule','count','index-check','index-write','index-recover','finalize'].includes(state.action) && Number.isInteger(state.indexCursor) && state.indexCursor>=0 && state.indexCursor<=10 && state.ownedCollections && typeof state.ownedCollections==='object' && state.receipts && typeof state.receipts==='object';
}
function createProvision({getContext,getConfig,createManager,getDatabase,now=()=>Date.now()}) {
 return async function provision(event={}) {
  const startedAt=now();let operation='validate',collection;
  const step=async(name,target,action)=>{operation=name;collection=target;return action();};
  const reply=(state,extra={})=>({status:200,body:{ready:false,needsRetry:true,dryRun:false,manifestHash,progress:{phase:state?.phase||'bootstrap',collection:state?collectionOrder[state.cursor]:META,action:state?.action||'create-meta',version:state?.version||0},...extra}});
  try {
   if(!plain(event)||Object.keys(event).some(key=>!['operation','apply'].includes(key))||event.operation!==undefined&&!['identity','inspect','provision','runtime-inspect','runtime-configure'].includes(event.operation)||event.apply!==undefined&&typeof event.apply!=='boolean'||event.operation==='identity'&&event.apply!==undefined||event.apply===true&&!['provision','runtime-configure'].includes(event.operation))reject(400,'invalid_request','仅支持受控身份、初始化和商城运行配置操作；客户端不能选择目标、数值、集合、阶段、身份或权限。');
   let config;try{config=getConfig();}catch{reject(503,'provision_unconfigured','初始化函数配置无效。');}
   const context=getContext();
   if(!config||!/^wx[a-f0-9]{16}$/.test(config.WECHAT_APP_ID||'')||!context||context.APPID!==config.WECHAT_APP_ID||typeof context.OPENID!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(context.OPENID))reject(401,'wechat_context_invalid','请从对应小程序以本人微信调用。');
   if(!/^[A-Za-z0-9][A-Za-z0-9-]{1,100}$/.test(config.CLOUDBASE_ENV_ID||'')||context.ENV!==config.CLOUDBASE_ENV_ID)reject(503,'environment_mismatch','配置环境与当前可信环境不一致；未访问数据库。');
   const accountId='wechat:'+digest(context.APPID+'\0'+context.OPENID);
   if(event.operation==='identity')return {status:200,body:{accountId}};
   if(!validAccount(config.PROVISION_OPERATOR_ACCOUNT_ID))reject(403,'operator_unconfigured','请先核对 identity 并在服务端配置初始化操作者。');
   if(accountId!==config.PROVISION_OPERATOR_ACCOUNT_ID)reject(403,'operator_forbidden','当前微信账号不是初始化操作者。');
   if(event.operation==='runtime-inspect'||event.operation==='runtime-configure')return await marketRuntime({operation:event.operation,apply:event.apply,envId:config.CLOUDBASE_ENV_ID,createManager,step,reject});
   if(JSON.stringify(manifest.collections)!==JSON.stringify(COLLECTION_NAMES)||manifest.clientRules.read!==false||manifest.clientRules.write!==false||manifest.indexes.some(item=>!COLLECTION_NAMES.includes(item.collection)))reject(503,'manifest_invalid','部署集合清单无效。');
   const appId=config.WECHAT_APP_ID,envId=config.CLOUDBASE_ENV_ID,apply=event.operation==='provision'&&event.apply===true;
   const db=getDatabase(),doc=(database,name)=>database.collection(META).doc(markerKey(name));
   const read=async(database,name)=>{const result=await doc(database,name).get();return (Array.isArray(result.data)?result.data[0]:result.data)||null;};
   const tx=async action=>{const t=await db.startTransaction();try{const value=await action(t);await t.commit();return value;}catch(error){await t.rollback().catch(()=>{});throw error;}};
   let state,metaMissing=false;
   try{state=await step('ReadCheckpoint',META,()=>read(db,'provision-state'));}catch(error){if(!missingCollection(error))throw error;metaMissing=true;}
   let manager;
   const call=async(Action,name,extra={})=>{manager||=createManager(envId);return step(Action,name,()=>manager.commonService('tcb','2018-06-08').call({Action,Param:{EnvId:envId,...(['DescribeDatabaseACL','DescribeSafeRule'].includes(Action)?{CollectionName:name,...(Action==='DescribeSafeRule'?{WxAppId:appId}:{})}:{TableName:name}),...extra}}));};
   if(metaMissing){
    if(!apply)return reply(null,{dryRun:true,progress:{phase:'bootstrap',collection:META,action:'create-meta',version:0}});
    // A response lost after atomic creation is harmless: next invocation reads
    // the existing collection and verifies its rules instead of creating again.
    try{await call('CreateTable',META,{PermissionInfo:{EnvId:envId,AclTag:'ADMINONLY'}});}catch(error){if(error.code!=='ResourceUnavailable.ResourceExist')throw error;}
    return reply(null,{progress:{phase:'bootstrap',collection:META,action:'verify-meta',version:0}});
   }
   // This current check runs on every authorized call, before trusting any
   // checkpoint or receipts. A later administrator ACL change cannot make a
   // client-written state authoritative.
   const metaRule=await call('DescribeSafeRule',META);
   if(metaRule.AclTag!=='ADMINONLY')reject(409,'collection_permission_unsafe','META 当前微信规则不是仅管理端读写；未接管状态或修改资源。');
   const marker=await step('ReadReadyMarker',META,()=>read(db,'provision-ready'));
   if(marker&&(!matchesMarker(marker,appId,envId)||marker.id!=='provision-ready'||typeof marker.ready!=='boolean'))reject(409,'project_marker_conflict','已有就绪标记不属于当前应用、环境或清单。');
   if(state&&!validState(state,appId,envId))reject(409,'project_marker_conflict','已有初始化状态格式或归属不匹配；未覆盖。');
   if(!apply)return reply(state,{dryRun:true,ready:isReady(marker),needsRetry:!isReady(marker),verificationSnapshot:true,verifiedAt:marker?.verifiedAt||null});
   const base={id:'provision-state',schemaVersion,manifestHash,appId,envId,operatorAccountId:accountId,formatVersion:2};
   const receipt=roundId=>({roundId,manifestHash,verifiedAt:new Date(now()).toISOString()});
   if(!state){
    if(now()-startedAt>=INVOCATION_BUDGET_MS)return reply(null,{reason:'time_budget'});
    const acl=await call('DescribeDatabaseACL',META);
    if(acl.AclTag!=='ADMINONLY')reject(409,'collection_permission_unsafe','META 简易权限不是仅管理端读写；未存入初始化状态。');
    const count=await step('CountDocuments',META,()=>db.collection(META).count());
    if(!Number.isSafeInteger(count.total)||count.total<0)reject(409,'collection_count_unknown','无法确认 META 是否为空。');
    if(count.total&&!isReady(marker))reject(409,'collection_data_unknown','已有 META 数据归属无法确认；未接管。');
    const initial={...base,roundId:randomUUID(),version:1,phase:'prepare',cursor:0,action:'describe',indexCursor:0,ownedCollections:isReady(marker)?Object.fromEntries(COLLECTION_NAMES.map(name=>[name,true])):{[META]:true},receipts:{},owner:null,leaseUntil:0};
    state=await step('CreateCheckpoint',META,()=>tx(async t=>{const previous=await read(t,'provision-state');if(previous)reject(409,'provision_busy','另一调用已开始初始化，请重试。');await doc(t,'provision-state').set({data:initial});if(marker)await doc(t,'provision-ready').set({data:{...marker,ready:false}});return initial;}));
    return reply(state);
   }
   if(state.phase==='complete'){
    if(!isReady(marker))reject(409,'verification_incomplete','已完成状态缺少有效就绪标记。');
    if(now()-Date.parse(marker.verifiedAt)<=VERIFY_WINDOW_MS)return {status:200,body:{ready:true,needsRetry:false,dryRun:false,manifestHash,verificationSnapshot:true,verifiedAt:marker.verifiedAt,progress:{phase:'complete',version:state.version}}};
    if(now()-startedAt>=INVOCATION_BUDGET_MS)return reply(state,{reason:'time_budget'});
    const reset=await step('RestartVerification',META,()=>tx(async t=>{const current=await read(t,'provision-state');if(!validState(current,appId,envId)||current.version!==state.version)reject(409,'provision_busy','初始化进度已变化。');const fresh={...current,phase:'verify',roundId:randomUUID(),cursor:0,indexCursor:0,action:'acl',receipts:{},owner:null,leaseUntil:0,version:current.version+1,verificationStartedAt:new Date(now()).toISOString()};await doc(t,'provision-state').set({data:fresh});await doc(t,'provision-ready').set({data:{...marker,ready:false}});return fresh;}));
    return reply(reset,{reason:'verification_snapshot_expired'});
   }
   if(now()-startedAt>=INVOCATION_BUDGET_MS)return reply(state,{reason:'time_budget'});
   // Exactly one persisted work item is claimed per invocation. A timed-out
   // writer leaves a recovery action, never the destructive write action.
   const owner=randomUUID();let claimedWork;
   state=await step('AcquireCheckpointLease',META,()=>tx(async t=>{
    const current=await read(t,'provision-state');if(!validState(current,appId,envId)||current.version!==state.version)reject(409,'provision_busy','初始化进度已改变，请重试。');
    if(current.owner&&current.leaseUntil>now())reject(409,'provision_busy','另一次调用仍在执行，请六秒后重试。');
    let claimed={...current,owner,leaseUntil:now()+LEASE_MS,version:current.version+1};
    if(claimed.phase==='verify'&&now()-Date.parse(claimed.verificationStartedAt)>VERIFY_WINDOW_MS)claimed={...claimed,roundId:randomUUID(),cursor:0,action:'acl',indexCursor:0,receipts:{},verificationStartedAt:new Date(now()).toISOString()};
    claimedWork=claimed.action;
    const writeAction=claimed.action==='create-write'?'create-recover':claimed.action==='index-write'?'index-recover':null;
    if(writeAction)claimed={...claimed,action:writeAction};
    if(claimedWork==='index-write')claimed.mutation={collection:collectionOrder[claimed.cursor],indexId:indexName(manifest.indexes.filter(item=>item.collection===collectionOrder[claimed.cursor])[claimed.indexCursor]),attemptedAt:new Date(now()).toISOString(),acknowledged:false};
    await doc(t,'provision-state').set({data:claimed});return claimed;
   }));
   const target=collectionOrder[state.cursor],wanted=manifest.indexes.filter(item=>item.collection===target),work=claimedWork;
   let next={...state};
   const advanceCollection=()=>{next.indexCursor=0;if(next.cursor<12){next.cursor++;next.action=next.phase==='prepare'?'describe':'acl';}else if(next.phase==='prepare'){next.phase='verify';next.cursor=0;next.action='acl';next.receipts={};next.verificationStartedAt=new Date(now()).toISOString();}else next.action='finalize';};
   const note=(kind)=>{next.receipts={...next.receipts,[target]:{...(next.receipts[target]||{}),[kind]:receipt(next.roundId)}};};
   const describe=async()=>{try{return await call('DescribeTable',target);}catch(error){if(missingCollection(error))return null;throw error;}};
   const inspectIndexes=table=>{operation='ValidateIndexes';collection=target;return validateIndexes(target,table);};
   if(now()-startedAt>=INVOCATION_BUDGET_MS){next.action=work==='index-write'?'index-check':state.action;delete next.mutation;}
   else if(work==='describe'||work==='create-recover'){
    const table=await describe();if(!table){if(next.phase==='verify')reject(409,'collection_missing','最终复核发现集合不存在；未写入就绪标记。');next.action='create-write';}else{inspectIndexes(table);next.action='acl';}
   }else if(work==='create-write'){
    try{await call('CreateTable',target,{PermissionInfo:{EnvId:envId,AclTag:'ADMINONLY'}});}catch(error){if(error.code!=='ResourceUnavailable.ResourceExist')throw error;}
    next.action='create-recover';
   }else if(work==='acl'||work==='rule'){
    const answer=await call(work==='acl'?'DescribeDatabaseACL':'DescribeSafeRule',target);
    if(answer.AclTag!=='ADMINONLY')reject(409,'collection_permission_unsafe','集合当前权限不是仅管理端读写；未更改已有规则。');
    note(work);next.action=work==='acl'?'rule':next.phase==='prepare'?'count':'index-check';
   }else if(work==='count'){
    const count=await step('CountDocuments',target,()=>db.collection(target).count());
    if(!Number.isSafeInteger(count.total)||count.total<0)reject(409,'collection_count_unknown','无法确认已有集合是否为空。');
    if(count.total&&!next.ownedCollections[target])reject(409,'collection_data_unknown','已有集合包含无法确认归属的数据；未接管。');
    next.ownedCollections={...next.ownedCollections,[target]:true};next.action='index-check';
   }else if(work==='index-check'||work==='index-recover'){
    const table=await describe();if(!table)reject(409,'collection_missing','集合不存在，请管理员核对。');
    const missing=inspectIndexes(table);note('structure');
    const item=wanted[next.indexCursor];
    if(!item)advanceCollection();
    else if(missing.some(value=>indexName(value)===indexName(item))){
     if(next.phase==='verify')return await finish(next,{reason:'index_definition_pending'});
     if(work==='index-recover'&&next.mutation?.indexId===indexName(item)){
      // An acknowledged asynchronous request is polled, never re-issued. An
      // interrupted request with unknown outcome waits beyond the SDK's 60s
      // remote request timeout, then starts with another fresh definition read.
      if(next.mutation.acknowledged||now()-Date.parse(next.mutation.attemptedAt)<UNCERTAIN_WRITE_WAIT_MS)return await finish(next,{reason:'index_definition_pending'});
      next.action='index-check';delete next.mutation;
     }else next.action='index-write';
    }
    else {note('indexDefinitionVerified:'+indexName(item));next.indexCursor++;next.action='index-check';delete next.mutation;}
   }else if(work==='index-write'){
    const item=wanted[next.indexCursor];if(!item)reject(409,'checkpoint_invalid','索引进度无效。');
    await call('UpdateTable',target,{CreateIndexes:[{IndexName:indexName(item),MgoKeySchema:{MgoIsUnique:false,MgoIndexKeys:expectedKeys(item)}}]});next.action='index-recover';next.mutation={...next.mutation,acknowledged:true};
   }else if(work==='finalize'){
    if(next.phase!=='verify'||now()-Date.parse(next.verificationStartedAt)>VERIFY_WINDOW_MS)reject(409,'verification_expired','分步复核已过期，请重新检查。');
    for(const name of COLLECTION_NAMES){const kinds=['acl','rule','structure',...manifest.indexes.filter(item=>item.collection===name).map(item=>'indexDefinitionVerified:'+indexName(item))];for(const kind of kinds){const r=next.receipts[name]?.[kind];if(!r||r.roundId!==next.roundId||r.manifestHash!==manifestHash||!Number.isFinite(Date.parse(r.verifiedAt))||Date.parse(r.verifiedAt)<Date.parse(next.verificationStartedAt))reject(409,'verification_incomplete','分步复核凭证尚不完整；未写入就绪标记。');}}
    next.phase='complete';next.completedAt=new Date(now()).toISOString();return await finish(next,{},true);
   }else reject(409,'checkpoint_invalid','服务端初始化阶段无效。');
   return await finish(next);
   async function finish(value,extra={},ready=false){
    return step('SaveCheckpoint',META,()=>tx(async t=>{const current=await read(t,'provision-state');if(!validState(current,appId,envId)||current.owner!==owner||current.version!==state.version||current.leaseUntil<=now())reject(409,'provision_lease_lost','本次调用租约已结束，请重新调用恢复。');
     const saved={...value,owner:null,leaseUntil:0,version:current.version+1};await doc(t,'provision-state').set({data:saved});
     if(ready){const prior=await read(t,'provision-ready');if(prior&&!matchesMarker(prior,appId,envId))reject(409,'project_marker_conflict','就绪标记归属发生变化。');await doc(t,'provision-ready').set({data:{...base,id:'provision-ready',ready:true,verifiedAt:saved.completedAt,verificationStartedAt:saved.verificationStartedAt,verificationMode:'sequential_snapshot',roundId:saved.roundId}});}
     return reply(saved,{...extra,ready,needsRetry:!ready,...(ready?{verifiedAt:saved.completedAt,verificationSnapshot:true}:{})});
    }));
   }
  }catch(error){
   if(error instanceof ProvisionError)return {status:error.status,body:{ready:false,needsRetry:['provision_busy','provision_lease_lost'].includes(error.code),error:{code:error.code,message:error.message,operation,...(collection?{collection}:{})}}};
   return {status:503,body:{ready:false,needsRetry:true,error:{code:'provision_provider_error',message:'本步骤未确认完成；可按服务端进度重试。请结合操作名称与官方错误码检查当前执行角色或控制台。',operation,...(collection?{collection}:{}),providerCode:providerCode(error)}}};
  }
 };
}
module.exports={createProvision,indexName,validateIndexes,INVOCATION_BUDGET_MS,LEASE_MS,VERIFY_WINDOW_MS};
