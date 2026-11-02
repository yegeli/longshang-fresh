'use strict';
const cloud=require('wx-server-sdk');
const {CloudbaseStore}=require('./lib/store');
const {runtimeConfig}=require('./lib/config');
const {createMarketApi}=require('./lib/api');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV,throwOnNotFound:false});
let api;
try {api=createMarketApi({store:new CloudbaseStore(cloud.database({throwOnNotFound:false})),getContext:()=>cloud.getWXContext(),env:runtimeConfig()});}
catch {api=async()=>({status:503,body:{error:{code:'cloudbase_unconfigured',message:'云函数运行配置无效，请管理员检查部署。'}}});}
exports.main=async event=>api(event);
