'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {fail}=require('./store');
const KEYS=['WECHAT_APP_ID','BOOTSTRAP_ADMIN_ACCOUNT_ID','CLOUDBASE_ENV_ID'];
function runtimeConfig(environment=process.env,filename=path.join(__dirname,'..','runtime.config.json')) {
 let local={};try{local=JSON.parse(fs.readFileSync(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')fail(503,'cloudbase_unconfigured','云函数运行配置无效。');}
 if(!local||typeof local!=='object'||Array.isArray(local)||Object.keys(local).some(k=>!KEYS.includes(k)))fail(503,'cloudbase_unconfigured','云函数运行配置包含不支持的字段。');
 const result={};for(const name of KEYS){const configured=local[name],override=environment[name];if(configured!==undefined&&typeof configured!=='string'||override!==undefined&&typeof override!=='string')fail(503,'cloudbase_unconfigured','云函数运行配置无效。');if(configured&&override&&configured!==override)fail(503,'cloudbase_unconfigured','云函数环境变量与部署配置不一致。');if(override||configured)result[name]=override||configured;}
 if(result.CLOUDBASE_ENV_ID&&!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(result.CLOUDBASE_ENV_ID)||result.WECHAT_APP_ID&&!/^wx[a-f0-9]{16}$/.test(result.WECHAT_APP_ID)||result.BOOTSTRAP_ADMIN_ACCOUNT_ID&&!/^wechat:[a-f0-9]{64}$/.test(result.BOOTSTRAP_ADMIN_ACCOUNT_ID))fail(503,'cloudbase_unconfigured','云函数运行配置编号无效。');return result;
}
module.exports={runtimeConfig};
