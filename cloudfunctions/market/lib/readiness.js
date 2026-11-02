'use strict';
const {fail}=require('./store');
const {schemaVersion,manifestHash}=require('./provision-contract');
const ENV_ID=/^[a-z0-9][a-z0-9_-]{1,127}$/;
async function requireReady(store,caller,context,env) {
 // ENV is injected by wx-server-sdk from the current cloud runtime, while the
 // expected environment is deployment configuration. Neither comes from event.
 if(!ENV_ID.test(env.CLOUDBASE_ENV_ID||'')||context.ENV!==env.CLOUDBASE_ENV_ID)fail(503,'cloudbase_not_ready','云端环境配置尚未核验，请管理员完成初始化。');
 let marker;try{marker=await store.get('meta','provision-ready');}catch{fail(503,'cloudbase_not_ready','云端集合、安全规则与索引尚未核验，请管理员完成初始化。');}
 if(!marker||marker.id!=='provision-ready'||marker.ready!==true||marker.schemaVersion!==schemaVersion||marker.manifestHash!==manifestHash||marker.appId!==caller.appId||marker.envId!==env.CLOUDBASE_ENV_ID||typeof marker.verifiedAt!=='string'||!Number.isFinite(Date.parse(marker.verifiedAt))||!/^wechat:[a-f0-9]{64}$/.test(marker.operatorAccountId||''))fail(503,'cloudbase_not_ready','云端集合、安全规则与索引尚未核验，请管理员完成初始化。');
}
module.exports={ENV_ID,requireReady};
