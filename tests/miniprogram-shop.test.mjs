import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v)),tick=()=>new Promise(r=>setImmediate(r));
const input=(field,value)=>({currentTarget:{dataset:{field}},detail:{value}});
const mediaId='CLOUD-00000000-0000-4000-8000-000000000001';
function fixture(){
 const state={role:'merchant',permissions:['products'],user:'merchant-a',writes:[],routes:[],confirm:true,reads:0,shop:{id:'shop-'+'a'.repeat(24),name:'景泰模拟采购店',description:'模拟店铺介绍',serviceNote:'人工咨询（模拟）',image:'assets/apples.jpg',imageMediaId:'',version:3,regionLabel:'甘肃景泰',procurementName:'模拟采购者'}};
 const session=()=>({user:{id:state.user},role:state.role,permissions:state.permissions,canManage:state.role==='admin'||state.role==='merchant'&&!!state.permissions.length});
 const market={mode:'cloud',transport:'cloudbase',getSession:async()=>state.sessionHook?state.sessionHook():session(),getManagementShop:async()=>{state.reads++;return {shop:clone(state.shop)};},assetUrl:p=>'/'+p,imageFor:s=>s.imageUrl||'/'+s.image,
  saveManagementShop:async(shop,version,actor)=>{state.writes.push({shop:clone(shop),version,actor});if(state.conflict)throw Object.assign(Error('资料已在其他设备更新'),{code:'version_conflict',status:409});state.shop={...state.shop,...clone(shop),version:version+1};return {shop:clone(state.shop)};},
  uploadShopImage:o=>{state.uploadInput=o;return {promise:state.uploadPromise||Promise.resolve({mediaId,url:'https://media.example.test/new-image'}),abort(){state.aborted=true;}};},
  getManagementMedia:async()=>({url:'https://media.example.test/renewed'}),getStorefront:async()=>({shops:[{id:state.shop.id,preview:false}]})};
 const wx={showModal:o=>o.success({confirm:state.confirm}),showToast(){},stopPullDownRefresh(){},navigateTo:o=>state.routes.push(o.url),switchTab:o=>state.routes.push(o.url),previewImage(){}};
 const modules=new Map();let spec;function load(file){file=resolve(file);if(!file.endsWith('.js'))file+='.js';if(file===resolve('miniprogram/services/market.js'))return {getMarket:()=>market};if(modules.has(file))return modules.get(file).exports;const module={exports:{}};modules.set(file,module);vm.runInNewContext(readFileSync(file,'utf8'),{wx,module,exports:module.exports,Page:s=>{spec=s;},require:n=>load(resolve(dirname(file),n))},{filename:file});return module.exports;}
 async function open(){load('miniprogram/pages/manage-shop/index.js');const p={...spec,data:clone(spec.data),setData(patch){Object.assign(this.data,clone(patch));}};p.onLoad({});await p.onShow();return p;}
 return {state,market,open,session};
}
test('shop editor saves exact profile fields and original version; conflicts and cancelled reload retain drafts',async()=>{
 const f=fixture(),p=await f.open();p.field(input('name','新店名（模拟）'));p.field(input('description','模拟介绍\n第二行'));p.field(input('serviceNote','人工回复，请稍后查看'));f.state.conflict=true;await p.save();assert.match(p.data.error,/其他设备/);assert.equal(p.data.name,'新店名（模拟）');assert.equal(p.data.shop.version,3);assert.equal(p.data.dirty,true);assert.equal(f.state.writes[0].actor,'merchant-a');assert.equal(f.state.writes[0].version,3);
 f.state.confirm=false;f.state.shop.version=6;await p.reload();assert.equal(p.data.shop.version,3);f.state.confirm=true;await p.reload();assert.equal(p.data.shop.version,6);assert.equal(p.data.dirty,false);
 f.state.conflict=false;p.field(input('name','云端新店名（模拟）'));await p.save();assert.equal(p.data.shop.version,7);assert.equal(p.data.dirty,false);assert.deepEqual(Object.keys(f.state.writes.at(-1).shop).sort(),['description','image','imageMediaId','name','serviceNote']);
});
test('shop editor denies buyers, unrelated permissions and stale account responses before showing private data',async()=>{
 for(const change of [f=>{f.state.role='buyer';},f=>{f.state.permissions=['aftersales'];},f=>{f.market.mode='mock';}]){const f=fixture();change(f);const p=await f.open();assert.equal(p.data.allowed,false);assert.equal(f.state.reads,0);}
 const f=fixture();f.market.getManagementShop=async()=>{f.state.user='merchant-b';return {shop:clone(f.state.shop)};};const p=await f.open();assert.equal(p.data.allowed,false);assert.equal(p.data.shop,null);
});
test('shop image completion preserves text typed while uploading and requires explicit profile save',async()=>{
 const f=fixture(),p=await f.open();let finish;f.state.uploadPromise=new Promise(r=>{finish=r;});p._selectedImage={filePath:'/tmp/mock.jpg',mimeType:'image/jpeg',size:100};const upload=p.startUpload();await tick();p.field(input('description','上传过程中编辑的模拟介绍'));finish({mediaId,url:'https://media.example.test/new-image'});await upload;
 assert.equal(f.state.uploadInput.shopId,f.state.shop.id);assert.equal(f.state.uploadInput.productId,undefined);assert.equal(p.data.description,'上传过程中编辑的模拟介绍');assert.equal(p.data.dirty,true);assert.equal(f.state.writes.length,0);assert.equal(p.data.imageMediaId,mediaId);await p.save();assert.equal(f.state.writes[0].shop.imageMediaId,mediaId);assert.equal(f.state.writes[0].shop.description,'上传过程中编辑的模拟介绍');
});
test('late shop image renewal never replaces a newly chosen default and clears the busy indicator',async()=>{
 const f=fixture();f.state.shop.imageMediaId=mediaId;const p=await f.open();let release,calls=0;f.state.sessionHook=()=>{if(++calls===2)return new Promise(r=>{release=r;});return f.session();};
 const renewal=p.refreshImage();await tick();assert.equal(typeof release,'function');assert.equal(p.data.refreshingImage,true);p.useDefault();assert.equal(p.data.refreshingImage,false);release(f.session());await renewal;
 assert.equal(p.data.imageMediaId,'');assert.equal(p.data.previewUrl,'/assets/apples.jpg');assert.equal(p.data.refreshingImage,false);
 p.setData({refreshingImage:true});p.onHide();assert.equal(p.data.refreshingImage,false);
});
test('shop editor returning from image picker keeps drafts; account change clears and aborts upload',async()=>{
 const f=fixture(),p=await f.open();p.field(input('name','还未保存的模拟店名'));p.onHide();await p.onShow();assert.equal(p.data.name,'还未保存的模拟店名');assert.equal(f.state.reads,1);
 f.state.uploadPromise=new Promise(()=>{});p._selectedImage={filePath:'/tmp/mock.jpg',mimeType:'image/jpeg',size:100};p.startUpload();await tick();f.state.user='merchant-b';await p.verify();assert.equal(p.data.allowed,false);assert.equal(p.data.name,'');assert.equal(p.data.shop,null);assert.equal(f.state.aborted,true);assert.equal(f.state.writes.length,0);
});
test('viewing the saved shop does not save a draft or navigate to an unpublished store',async()=>{
 const f=fixture(),p=await f.open();p.field(input('description','尚未保存'));f.state.confirm=false;await p.viewShop();assert.equal(f.state.routes.length,0);f.state.confirm=true;await p.viewShop();assert.equal(f.state.routes[0],'/pages/shop/index?id='+f.state.shop.id);assert.equal(p.data.description,'尚未保存');assert.equal(f.state.writes.length,0);
 f.market.getStorefront=async()=>({shops:[]});await p.viewShop();assert.match(p.data.error,/没有上架商品/);assert.equal(f.state.routes.length,1);
});
