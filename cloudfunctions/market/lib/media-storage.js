'use strict';
const https=require('node:https');
const {fail}=require('./store');
function trustedURL(value) {
 let url;try{url=new URL(value);}catch{fail(503,'media_storage_invalid','云存储链接无效。');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||!/(?:^|\.)(?:tcb\.qcloud\.la|tcloudbaseapp\.com|myqcloud\.com|tcloudbase\.com)$/.test(url.hostname))fail(503,'media_storage_invalid','云存储链接来源无效。');return url;
}
function readBounded(url,maximum,request=https.get) {
 return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,data)=>{if(settled)return;settled=true;error?reject(error):resolve(data);};
  const req=request(trustedURL(url),response=>{
   if(response.statusCode!==200){response.resume();return finish(new Error('Cloud media download failed'));}
   const declared=response.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){response.destroy();return finish(Object.assign(new Error('Cloud media object exceeds maximum'),{mediaTooLarge:true}));}
   const chunks=[];let length=0;response.on('data',part=>{length+=part.length;if(length>maximum){response.destroy();finish(Object.assign(new Error('Cloud media object exceeds maximum'),{mediaTooLarge:true}));}else chunks.push(part);});response.on('error',error=>finish(error));response.on('aborted',()=>finish(new Error('Cloud media response aborted')));response.on('end',()=>{if(declared!==undefined&&Number(declared)!==length)return finish(new Error('Cloud media length differs'));finish(null,Buffer.concat(chunks));});
  });req.on('error',error=>finish(error));req.setTimeout(6000,()=>{req.destroy();finish(new Error('Cloud media download timed out'));});
 });
}
function createMediaStorage(cloud,{request=https.get}={}) {
 async function urls(fileIds,maxAge=300) {
  const result={};for(let offset=0;offset<fileIds.length;offset+=50){const list=fileIds.slice(offset,offset+50),response=await cloud.getTempFileURL({fileList:list.map(fileID=>({fileID,maxAge}))});for(const id of list){const file=response?.fileList?.find(f=>f.fileID===id);if(!file||file.status!==0||typeof file.tempFileURL!=='string')fail(503,'media_storage_unavailable','云素材暂时无法读取，请稍后重试。');trustedURL(file.tempFileURL);result[id]=file.tempFileURL;}}return result;
 }
 async function write(cloudPath,bytes) {const result=await cloud.uploadFile({cloudPath,fileContent:bytes});if(typeof result?.fileID!=='string'||!result.fileID.startsWith('cloud://'))fail(503,'media_storage_invalid','云素材上传未确认，请重试。');return result.fileID;}
 async function removeMany(fileIds){
  const ids=[...new Set(fileIds)],report={deleted:[],failed:[]};
  for(let offset=0;offset<ids.length;offset+=50){const batch=ids.slice(offset,offset+50);
   try{const response=await cloud.deleteFile({fileList:batch});for(const fileId of batch){const file=response?.fileList?.find(f=>f.fileID===fileId);if(file?.status===0)report.deleted.push(fileId);else report.failed.push({fileId,status:Number.isInteger(file?.status)?file.status:null});}}
   catch(error){for(const fileId of batch)report.failed.push({fileId,status:Number.isInteger(error?.errCode)?error.errCode:null});}
  }
  // wx-server-sdk maps missing to -503003 and authority errors to -503002;
  // generic status 1 is NOT absence. Even the official missing-code guidance
  // lists insufficient permissions as a possible cause, so only explicit
  // success removes a cleanup checkpoint. Continue later batches regardless.
  if(report.failed.length)throw Object.assign(new Error('Cloud media cleanup incomplete'),{deleteReport:report});return report;
 }
 async function readChunks(chunks) {
  const links=await urls(chunks.map(c=>c.fileId)),values=new Array(chunks.length);let next=0;
  await Promise.all(Array.from({length:Math.min(4,chunks.length)},async()=>{for(;;){const index=next++;if(index>=chunks.length)return;const chunk=chunks[index];try{values[index]=await readBounded(links[chunk.fileId],chunk.size,request);}catch(error){if(error.mediaTooLarge)fail(413,'media_too_large','云端文件超过声明大小，请重新上传。');throw error;}if(values[index].length!==chunk.size)fail(422,'media_size_mismatch','云端分块长度不一致，请重新上传。');}}));return values;
 }
 return {urls,write,readChunks,removeMany,remove:fileId=>removeMany([fileId])};
}
module.exports={createMediaStorage,readBounded,trustedURL};
