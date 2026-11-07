import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMediaUploader, CHUNK_SIZE } = require('../miniprogram/services/cloud-media.js');
const { createMarket } = require('../miniprogram/services/market.js');
const id = 'CLOUD-00000000-0000-4000-8000-000000000001';
const user = 'wechat:' + 'a'.repeat(64);
const config = {mode:'cloud',transport:'cloudbase',cloudEnv:'cloud1-test',cloudFunction:'market'};
const expiry = () => new Date(Date.now()+60000).toISOString();
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(size = CHUNK_SIZE * 4 + 13) {
  const data = Buffer.alloc(size, 17), chunks = new Map(), keys = [], progress = [], calls = [];
  const state = {generation:0,live:0,peak:0,failIndex:null,read:0,completed:0};
  const result = {mediaId:id,state:'ready',url:'https://test.tcb.qcloud.la/mock-image',expiresAt:expiry()};
  const wxApi = {getFileSystemManager:()=>({readFile(o){state.read++;setImmediate(()=>o.success({data:data.subarray(o.position,o.position+o.length).toString('base64')}));}})};
  const request = async (path, method, body) => {
    calls.push({path,method,body});
    if (path.endsWith('/uploads')) {keys.push(body.idempotencyKey);return {mediaId:id,state:'pending',chunkSize:CHUNK_SIZE,chunkCount:Math.ceil(size/CHUNK_SIZE),uploadedChunks:[...chunks.keys()]};}
    if (path.endsWith('/chunks')) {
      state.live++;state.peak=Math.max(state.live,state.peak);await tick();state.live--;
      if (body.index===state.failIndex) throw Object.assign(Error('offline'),{code:'network_error'});
      chunks.set(body.index,Buffer.from(body.data,'base64'));return {mediaId:id,index:body.index,uploaded:true};
    }
    if (path.endsWith('/complete')) {state.completed++;return result;}
    throw Error('Unexpected path');
  };
  let key = 0;
  const upload = createMediaUploader({wxApi,request,authorize:async()=>{},getGeneration:()=>state.generation,newKey:()=> 'KEY-'+(++key),checkIdentity:(_,generation)=>{if(generation!==state.generation)throw Object.assign(Error('changed'),{code:'stale_session'});}});
  const input = {productId:'jingtai-apple',kind:'image',mimeType:'image/png',size,filePath:'/tmp/selected.png',expectedUserId:user,onProgress:value=>progress.push(value)};
  return {upload,input,data,chunks,keys,progress,state,calls,result};
}
test('native media uploads exact bounded chunks with concurrency three and real progress', async () => {
  const f=fixture();assert.deepEqual(await f.upload(f.input).promise,f.result);
  assert.deepEqual(Buffer.concat([...f.chunks.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value)),f.data);
  assert.ok(f.state.peak<=3);assert.equal(f.state.completed,1);
  assert.deepEqual(f.progress.at(-1),{progress:100,phase:'verifying'});
  assert.ok(f.calls.every(call=>call.method==='POST'));
  assert.ok(f.calls.filter(call=>call.path.endsWith('/chunks')).every(call=>Buffer.byteLength(JSON.stringify(call.body))<400*1024));
});
test('native retry reuses ticket and completed chunks; a successful new selection gets a new key', async () => {
  const f=fixture();f.state.failIndex=3;
  await assert.rejects(f.upload(f.input).promise,{code:'network_error'});await tick();
  const completeBefore=new Set(f.chunks.keys());f.state.failIndex=null;const start=f.calls.length;
  await f.upload(f.input).promise;
  assert.equal(f.keys[0],f.keys[1]);
  assert.ok(f.calls.slice(start).filter(call=>call.path.endsWith('/chunks')).every(call=>!completeBefore.has(call.body.index)));
  await f.upload(f.input).promise;assert.notEqual(f.keys[1],f.keys[2]);
});
test('cancel and account changes reject pending upload without complete or late progress', async () => {
  for(const kind of ['cancel','identity']) {
    const f=fixture();const task=f.upload(f.input);const rejected=assert.rejects(task.promise,{code:kind==='cancel'?'upload_cancelled':'stale_session'});
    if(kind==='cancel')task.abort();else f.state.generation++;
    await rejected;await tick();assert.equal(f.state.completed,0);assert.equal(f.progress.length,0);
  }
});
test('native media rejects unsupported and oversized selections before reading or requesting', async () => {
  for(const extra of [{size:5*1024*1024+1},{mimeType:'image/svg+xml'},{kind:'video',mimeType:'video/mp4',duration:121},{kind:'video',mimeType:'video/mp4',duration:0}]) {
    const f=fixture();await assert.rejects(f.upload({...f.input,...extra}).promise,{code:'media_invalid'});assert.equal(f.calls.length,0);assert.equal(f.state.read,0);
  }
});
test('CloudBase views display short signed URLs, fall back after expiry, and hydrate private order images',async()=>{
  const storage=new Map(),calls=[];
  storage.set('longshang-native-auth:cloudbase:cloud1-test:market',{token:'wxs_'+'b'.repeat(64),userId:user,expiresAt:expiry()});
  const wx={getStorageSync:key=>storage.get(key),setStorageSync:(key,v)=>storage.set(key,v),removeStorageSync:key=>storage.delete(key),cloud:{init(){},callFunction(o){calls.push(o.data);const path=o.data.path;const body=path.endsWith('/media/'+id)?{url:'https://test.tcb.qcloud.la/order.png',expiresAt:expiry()}:path==='/api/v1/session'?{user:{id:user},role:'admin',permissions:[],canManage:true}:{order:{id:'DEMO-TEST',items:[{productId:'jingtai-apple',imageMediaId:id,image:'assets/apples.jpg'}]}};o.success({result:{status:200,body}});}}};
  const market=createMarket(wx,config),product={imageMediaId:id,image:'assets/apples.jpg',imageUrl:'https://test.tcb.qcloud.la/image.png',imageExpiresAt:expiry(),videoUrl:'https://test.tcb.qcloud.la/video.mp4',videoExpiresAt:expiry()};
  assert.equal(market.imageFor(product),product.imageUrl);assert.equal(market.videoFor(product),product.videoUrl);
  assert.equal(market.imageFor({...product,imageExpiresAt:'2000-01-01'}),'/assets/apples.jpg');
  assert.equal(market.imageFor({...product,imageUrl:'http://unsafe.test/a'}),'/assets/apples.jpg');
  const result=await market.getOrder('DEMO-TEST');assert.equal(market.imageFor(result.order.items[0]),'https://test.tcb.qcloud.la/order.png');
  assert.equal(calls.at(-1).sessionToken,'wxs_'+'b'.repeat(64));assert.equal(calls.at(-1).expectedUserId,user);
  await assert.rejects(market.getManagementMedia(id,'wechat:'+'f'.repeat(64)),{code:'stale_session'});
  assert.equal([...storage.keys()].length,1);
});
