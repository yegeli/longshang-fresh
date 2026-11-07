import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),model=require('../miniprogram/services/generated/model.js');
const picker=require('../miniprogram/pages/manage-product/media-picker.js');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const event=dataset=>({currentTarget:{dataset}}),input=(field,value)=>({...event({field}),detail:{value}});
function fixture(){
  const state={userId:'merchant-a',role:'merchant',permissions:['products'],products:[{...clone(model.BASE_CATALOG[0]),version:1,status:'published'}],saved:[],uploads:[],messages:[],previews:[],previewRequests:[],picks:[],catalogReads:0,defer:false};
  const session=()=>({user:{id:state.userId},role:state.role,permissions:state.permissions,canManage:state.role==='admin'||state.permissions.length>0});
  const stock={productId:'jingtai-apple',version:1,stocks:{small:8,family:3},batchCode:'DEMO-MEDIA',harvestDate:'',note:''};
  const urls=new Map();
  const market={mode:'cloud',newRequestKey:()=> 'NATIVE-0123456789abcdef',getSession:async()=>session(),
    assetUrl:path=>'/'+path.replace(/^\//,''),imageFor:p=>p.imageMediaId?urls.get(p.imageMediaId)||market.assetUrl(p.image):market.assetUrl(p.image),videoFor:p=>p.videoMediaId?urls.get(p.videoMediaId)||'':'',
    getManagementProducts:async()=>({products:clone(state.products)}),getManagementInventory:async()=>({inventories:[clone(stock)]}),
    saveManagementProduct:async(product,version,actorId)=>{assert.equal(actorId,state.userId);const saved={...clone(product),version:version+1};state.saved.push(saved);state.products=[saved];return {product:saved};},
    saveManagementInventory:async(id,body)=>({inventory:{...stock,...clone(body),version:body.expectedVersion+1}}),
    getCatalog:async()=>{state.catalogReads++;return {products:clone(state.products)};},getInventory:async()=>({inventories:[stock]}),
    getManagementMedia:async(id,actorId)=>{state.previewRequests.push({id,actorId});return {url:'https://media.example.test/renewed/'+id,expiresAt:new Date(Date.now()+300000).toISOString()};},
    getShopping:async()=>({state:{favorites:[],recent:['jingtai-apple']}}),
    uploadProductMedia(options){
      let resolveUpload,rejectUpload;
      const transfer={options,aborted:false,resolve:result=>{urls.set(result.mediaId,result.url);resolveUpload(result);},reject:error=>rejectUpload(error)};
      const promise=new Promise((resolve,reject)=>{resolveUpload=resolve;rejectUpload=reject;});
      state.uploads.push(transfer);
      if(!state.defer)transfer.resolve({mediaId:'MEDIA-'+state.uploads.length,url:'https://media.example.test/'+state.uploads.length});
      return {promise,abort(){transfer.aborted=true;}};
    }
  };
  const wx={showModal:options=>options.success({confirm:state.confirm!==false}),showToast:options=>state.messages.push(options.title),stopPullDownRefresh(){},
    chooseMedia(options){state.picks.push(options);if(state.pickError)options.fail(state.pickError);else options.success({tempFiles:[state.file||{tempFilePath:'/tmp/synthetic-image.jpg',size:400}]});},
    getImageInfo:options=>options.success({type:state.imageType||'jpeg'}),getVideoInfo:options=>options.success({duration:state.duration||20}),
    previewImage:options=>state.previews.push(options),navigateTo(){},switchTab(){}};
  const modules=new Map();let definition;
  function load(path){
    path=resolve(path);if(!path.endsWith('.js'))path+='.js';
    if(path===resolve('miniprogram/services/market.js'))return {getMarket:()=>market};
    if(modules.has(path))return modules.get(path).exports;
    const module={exports:{}};modules.set(path,module);
    vm.runInContext(readFileSync(path,'utf8'),vm.createContext({wx,console,module,exports:module.exports,Page:value=>{definition=value;},require:relative=>load(resolve(dirname(path),relative))}),{filename:path});
    return module.exports;
  }
  async function open(name='manage-product',query={id:'jingtai-apple'}){
    const file=resolve('miniprogram/pages',name,'index.js');modules.delete(file);load(file);
    const page={...definition,data:clone(definition.data),setData(patch){Object.assign(this.data,clone(patch));}};
    page.onLoad(query);await page.onShow();assert.equal(page.data.error,'');return page;
  }
  return {state,market,wx,open};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('merchant image selection stages a cloud binding without publishing or losing edited price on picker return',async()=>{
  const r=fixture(),page=await r.open();page.field(input('smallPrice','38.50'));
  await page.chooseMedia(event({kind:'image'}));assert.equal(page.data.mediaDirty,true);assert.equal(page.data.product.imageMediaId,'MEDIA-1');
  assert.equal(r.state.saved.length,0);assert.equal(r.state.products[0].imageMediaId,undefined);assert.equal(page.data.smallPrice,'38.50');
  await page.onShow();assert.equal(page.data.smallPrice,'38.50');assert.equal(page.data.product.imageMediaId,'MEDIA-1');
  assert.deepEqual(clone(r.state.picks[0].sourceType),['album','camera']);assert.equal(r.state.picks[0].maxDuration,60);assert.equal(r.state.uploads[0].options.mimeType,'image/jpeg');
  await page.saveProduct();assert.equal(r.state.saved[0].imageMediaId,'MEDIA-1');assert.equal(r.state.saved[0].variants[0].price,3850);assert.equal(page.data.mediaDirty,false);
  page.previewMediaImage();assert.equal(r.state.previews[0].current,'https://media.example.test/1');
});

test('native picker hide/show preserves the unsaved form and double taps open only one picker',async()=>{
  const r=fixture(),page=await r.open();page.field(input('smallPrice','31.80'));
  let complete;r.wx.chooseMedia=options=>{r.state.picks.push(options);complete=()=>options.success({tempFiles:[{tempFilePath:'/tmp/synthetic-image.jpg',size:400}]});};
  const first=page.chooseMedia(event({kind:'image'})),second=page.chooseMedia(event({kind:'image'}));await tick();
  page.onHide();await page.onShow();assert.equal(page.data.smallPrice,'31.80');assert.equal(r.state.picks.length,1);
  complete();await Promise.all([first,second]);assert.equal(page.data.product.imageMediaId,'MEDIA-1');assert.equal(page.data.smallPrice,'31.80');
});

test('merchant video can be replaced, saved with source notes, removed and default image restored',async()=>{
  const r=fixture(),page=await r.open();r.state.file={tempFilePath:'/tmp/synthetic-harvest.mp4',size:1024,duration:20};
  await page.chooseMedia(event({kind:'video'}));assert.equal(page.data.product.videoMediaId,'MEDIA-1');
  page.field(input('videoTitle','模拟采摘介绍'));page.field(input('videoNote','测试生成的演示素材，不代表真实景泰实拍。'));
  await page.saveProduct();assert.match(r.state.saved[0].videoNote,/演示素材/);
  await page.chooseMedia(event({kind:'video'}));assert.equal(page.data.product.videoMediaId,'MEDIA-2');assert.equal(r.state.saved.length,1);
  page.removeVideo();assert.equal(page.data.product.videoMediaId,'');assert.equal(page.data.mediaVideoUrl,'');
  r.state.file={tempFilePath:'/tmp/synthetic-image.jpg',size:1024};await page.chooseMedia(event({kind:'image'}));
  page.restoreImage();assert.equal(page.data.product.imageMediaId,'');assert.equal(page.data.mediaImageUrl,'/assets/apples.jpg');
  await page.saveProduct();assert.equal(r.state.saved.at(-1).videoMediaId,'');assert.equal(r.state.saved.at(-1).imageMediaId,'');
});

test('picker cancellation is quiet, new drafts block selection, and unsupported/oversize media never upload',async()=>{
  const r=fixture(),page=await r.open('manage-product',{});await page.chooseMedia(event({kind:'image'}));assert.equal(r.state.picks.length,0);assert.match(r.state.messages.at(-1),/先保存商品草稿/);
  const existing=await r.open();r.state.pickError={errMsg:'chooseMedia:fail cancel'};await existing.chooseMedia(event({kind:'image'}));assert.equal(existing.data.mediaError,'');
  delete r.state.pickError;r.state.file={tempFilePath:'/tmp/synthetic-image.jpg',size:5*1024*1024+1};await existing.chooseMedia(event({kind:'image'}));assert.match(existing.data.mediaError,/5 MiB/);
  r.state.file={tempFilePath:'/tmp/synthetic-harvest.mov',size:1024,duration:20};await existing.chooseMedia(event({kind:'video'}));assert.match(existing.data.mediaError,/MP4/);
  r.state.file={tempFilePath:'/tmp/synthetic-harvest.mp4',size:1024,duration:121};r.state.duration=121;await existing.chooseMedia(event({kind:'video'}));assert.match(existing.data.mediaError,/120秒/);
  assert.equal(r.state.uploads.length,0);
});

test('upload reports only actual progress; cancellation and retries ignore late completion and preserve input',async()=>{
  const r=fixture(),page=await r.open();r.state.defer=true;page.field(input('familyPrice','72.30'));
  const first=page.chooseMedia(event({kind:'image'}));await tick();assert.equal(page.data.uploading,true);assert.equal(page.data.uploadPercent,-1);
  r.state.uploads[0].options.onProgress(37);assert.equal(page.data.uploadPercent,37);r.state.uploads[0].options.onProgress({progress:100,phase:'verifying'});assert.equal(page.data.uploadPhase,'verifying');page.cancelUpload();assert.equal(r.state.uploads[0].aborted,true);assert.equal(page.data.mediaRetry,true);
  const retry=page.retryUpload();await tick();r.state.uploads[0].resolve({mediaId:'STALE',url:'https://media.example.test/stale'});await first;
  assert.notEqual(page.data.product.imageMediaId,'STALE');assert.equal(page.data.uploading,true);
  r.state.uploads[1].resolve({mediaId:'RETRY',url:'https://media.example.test/retry'});await retry;
  assert.equal(page.data.product.imageMediaId,'RETRY');assert.equal(page.data.familyPrice,'72.30');assert.equal(page.data.uploading,false);
});

test('permission changes, account switches and leaving the page prevent applying an upload result',async()=>{
  for(const change of [r=>{r.state.userId='merchant-b';},r=>{r.state.permissions=[];},(r,page)=>page.onUnload()]){
    const r=fixture(),page=await r.open();r.state.defer=true;
    const upload=page.chooseMedia(event({kind:'image'}));await tick();change(r,page);
    r.state.uploads[0].resolve({mediaId:'REVOKED',url:'https://media.example.test/revoked'});await upload;
    assert.notEqual(page.data.product.imageMediaId,'REVOKED');assert.equal(r.state.saved.length,0);
  }
});

test('failed upload retries explicitly and stock save keeps pending media and price edits',async()=>{
  const r=fixture(),page=await r.open();r.state.defer=true;
  const upload=page.chooseMedia(event({kind:'image'}));await tick();r.state.uploads[0].reject(Error('模拟网络失败'));await upload;
  assert.equal(page.data.mediaRetry,true);assert.match(page.data.mediaError,/模拟网络失败/);
  r.state.defer=false;await page.retryUpload();page.field(input('smallPrice','21.30'));page.field(input('reason','模拟补货核对'));
  await page.saveStock();assert.equal(page.data.smallPrice,'21.30');assert.equal(page.data.product.imageMediaId,'MEDIA-2');assert.equal(page.data.mediaDirty,true);assert.equal(r.state.saved.length,0);
});

test('signed preview refresh preserves unsaved media, prices and video source without automatic error loops',async()=>{
  const r=fixture(),page=await r.open();await page.chooseMedia(event({kind:'image'}));r.state.file={tempFilePath:'/tmp/synthetic-harvest.mp4',size:1024,duration:20};await page.chooseMedia(event({kind:'video'}));
  page.field(input('smallPrice','28.80'));page.field(input('videoNote','模拟素材来源说明'));
  page.mediaFailed();page.mediaFailed();assert.equal(r.state.previewRequests.length,0);
  await page.refreshMediaPreview(event({kind:'image'}));await page.refreshMediaPreview(event({kind:'video'}));
  assert.equal(page.data.product.imageMediaId,'MEDIA-1');assert.equal(page.data.product.videoMediaId,'MEDIA-2');assert.equal(page.data.mediaDirty,true);
  assert.equal(page.data.mediaImageUrl,'https://media.example.test/renewed/MEDIA-1');assert.equal(page.data.mediaVideoUrl,'https://media.example.test/renewed/MEDIA-2');
  assert.equal(page.data.smallPrice,'28.80');assert.equal(page.data.videoNote,'模拟素材来源说明');assert.equal(r.state.saved.length,0);assert.equal(r.state.previewRequests.length,2);
});

test('late preview renewal cannot restore removed or replaced media or update after account change',async()=>{
  const r=fixture(),page=await r.open();await page.chooseMedia(event({kind:'image'}));
  let finish;r.market.getManagementMedia=()=>new Promise(resolve=>{finish=resolve;});
  const renewal=page.refreshMediaPreview(event({kind:'image'}));await tick();page.restoreImage();finish({url:'https://media.example.test/obsolete'});await renewal;
  assert.equal(page.data.mediaImageUrl,'/assets/apples.jpg');assert.equal(page.data.product.imageMediaId,'');
  await page.chooseMedia(event({kind:'image'}));const activeUrl=page.data.mediaImageUrl;
  const another=page.refreshMediaPreview(event({kind:'image'}));await tick();r.state.userId='merchant-b';finish({url:'https://media.example.test/wrong-account'});await another;
  assert.equal(page.data.mediaImageUrl,activeUrl);assert.equal(page.data.allowed,false);
});

test('explicit reload asks before discarding unsaved media or price changes',async()=>{
  const r=fixture(),page=await r.open();page.field(input('smallPrice','19.90'));r.state.confirm=false;await page.reloadProduct();assert.equal(page.data.smallPrice,'19.90');
  r.state.confirm=true;await page.reloadProduct();assert.notEqual(page.data.smallPrice,'19.90');
});

test('media picker reads actual file size when absent and permits only supported decoded image formats',async()=>{
  const api={getFileSystemManager:()=>({stat:options=>options.success({stats:{size:2048}})}),getImageInfo:options=>options.success({type:'webp'})};
  assert.deepEqual(await picker.validate(api,{tempFilePath:'/tmp/synthetic-no-extension'},'image'),{filePath:'/tmp/synthetic-no-extension',size:2048,mimeType:'image/webp'});
  api.getImageInfo=options=>options.success({type:'gif'});await assert.rejects(picker.validate(api,{tempFilePath:'/tmp/synthetic.gif',size:1024},'image'),/JPEG/);
});

test('buyer opens saved cloud image directly and sees the bound video with explicit demonstration provenance',async()=>{
  const r=fixture();r.state.file={tempFilePath:'/tmp/synthetic-harvest.mp4',size:1024,duration:20};const manage=await r.open();await manage.chooseMedia(event({kind:'video'}));await manage.saveProduct();
  const product=await r.open('product');assert.equal(product.data.video,'https://media.example.test/1');product.previewImage();assert.equal(r.state.previews[0].current,'/assets/apples.jpg');product.videoFailed();assert.equal(product.data.videoError,true);
  const markup=readFileSync(resolve('miniprogram/pages/product/index.wxml'),'utf8');assert.match(markup,/bindtap="previewImage"/);assert.match(markup,/binderror="videoFailed"/);assert.match(markup,/暂不代表真实景泰采摘或供货/);
});


test('temporary cloud media signing failure keeps buyer product usable and distinguishes unavailable video from missing video',async()=>{
  const r=fixture();r.state.products[0]={...r.state.products[0],imageMediaId:'UNAVAILABLE-IMAGE',videoMediaId:'UNAVAILABLE-VIDEO',mediaUnavailable:true};
  const product=await r.open('product');assert.equal(product.data.error,'');assert.equal(product.data.product.mediaUnavailable,true);
  assert.equal(product.data.video,'');assert.equal(product.data.videoUnavailable,true);assert.equal(product.data.imageFallback,true);assert.equal(product.data.product.image,'/assets/apples.jpg');assert.equal(product.data.variant.stock,8);
  await tick();assert.equal(r.state.catalogReads,1);await product.refresh();assert.equal(r.state.catalogReads,2);assert.equal(r.state.saved.length,0);
  delete r.state.products[0].videoMediaId;await product.refresh();assert.equal(product.data.videoUnavailable,false);assert.equal(product.data.video,'');
  const markup=readFileSync(resolve('miniprogram/pages/product/index.wxml'),'utf8');assert.match(markup,/wx:elif="{{videoUnavailable}}"/);assert.match(markup,/云端素材暂时无法读取，请稍后刷新重试/);assert.match(markup,/当前展示默认示意图 · 非景泰实拍/);
});
