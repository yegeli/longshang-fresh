import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {createMarket}=require('../miniprogram/services/market.js');
const model=require('../miniprogram/services/generated/model.js');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const API='https://management.example.test',idA='wechat:'+ 'a'.repeat(64),idB='wechat:'+ 'b'.repeat(64),token='wxs_'+ 'a'.repeat(64);
const event=dataset=>({currentTarget:{dataset}});
function fixture({role='admin',permissions=['products','orders','aftersales'],mode='cloud'}={}){
  const storage=new Map(),requests=[],messages=[],copies=[];
  storage.set('longshang-native-auth:'+API,{token,expiresAt:new Date(Date.now()+3600000).toISOString()});
  const state={userId:idA,role,permissions,products:[{...clone(model.BASE_CATALOG[0]),status:'published',version:1}],
    inventories:[{productId:'jingtai-apple',configured:true,stocks:{small:8,family:4},version:1,batchCode:'DEMO-A',harvestDate:'',note:''}],merchants:[],
    orders:[{id:'DEMO-MANAGEMENT',version:1,status:'created',product:'景泰苹果',quantity:1,total:5900,shipping:0,items:[{productId:'jingtai-apple',product:'景泰苹果',variant:'small',quantity:1,unitPrice:5900}]}]};
  const session=()=>({user:{id:state.userId,name:'微信用户'},role:state.role,permissions:state.permissions,canManage:state.role==='admin'||state.role==='merchant'&&state.permissions.length>0,merchant:state.role==='merchant'?{name:'模拟采购者',region:'甘肃',status:'enabled'}:null});
  const wx={
    getStorageSync:key=>clone(storage.get(key)),setStorageSync:(key,value)=>storage.set(key,clone(value)),removeStorageSync:key=>storage.delete(key),
    showModal:options=>options.success({confirm:true}),showToast:options=>messages.push(options.title),stopPullDownRefresh(){},
    setClipboardData:options=>{copies.push(options.data);options.success({});},navigateTo(){},switchTab(){},
    request(options){
      requests.push(options);const path=new URL(options.url).pathname;let result;
      if(path==='/api/v1/session')result=session();
      else if(path==='/api/v1/admin/products')result={products:state.products};
      else if(path==='/api/v1/admin/inventory')result={inventories:state.inventories};
      else if(path==='/api/v1/admin/orders')result={orders:state.orders,nextCursor:null};
      else if(path==='/api/v1/admin/wechat/merchants'){
        if(options.method==='POST'){const input=options.data;state.merchants.push({...input,id:'MERCHANT-EXAMPLE',version:1});result={merchant:state.merchants[0]};}
        else result={merchants:state.merchants};
      }else if(path.startsWith('/api/v1/admin/products/')){
        if(state.conflict){options.success({statusCode:409,data:{error:{code:'version_conflict',message:'商品已更新，请重新读取。'}}});return;}
        state.products=[{...clone(options.data.product),version:options.data.expectedVersion+1}];result={product:state.products[0]};
      }else if(path.startsWith('/api/v1/admin/inventory/')){
        state.inventories=[{productId:path.split('/').pop(),...clone(options.data),version:options.data.expectedVersion+1}];result={inventory:state.inventories[0]};
      }else if(path.endsWith('/ship')){state.orders[0]={...state.orders[0],fulfillment:{status:'shipped',carrier:options.data.carrier,tracking:options.data.tracking},version:state.orders[0].version+1};result={order:state.orders[0]};}
      else if(path.endsWith('/aftersale/resolve')){state.orders[0]={...state.orders[0],afterSale:{...state.orders[0].afterSale,status:'resolved',merchantReply:options.data.reply},version:state.orders[0].version+1};result={order:state.orders[0]};}
      else if(path==='/api/v1/me/shopping')result={state:{cart:[],favorites:[],recent:[],preferredAddress:'gansu'},version:0};
      else if(path==='/api/v1/products')result={products:state.products};
      else if(path==='/api/v1/inventory')result={inventories:state.inventories};
      else throw Error('Unexpected fixture path '+path);
      options.success({statusCode:200,data:clone(result)});
    }
  };
  const market=createMarket(wx,{mode,apiBase:API}),modules=new Map();let definition;
  function load(path){
    path=resolve(path);if(!path.endsWith('.js'))path+='.js';
    if(path===resolve('miniprogram/services/market.js'))return {getMarket:()=>market};
    if(modules.has(path))return modules.get(path).exports;
    const module={exports:{}};modules.set(path,module);
    vm.runInContext(readFileSync(path,'utf8'),vm.createContext({wx,console,module,exports:module.exports,Page:value=>{definition=value;},require:relative=>load(resolve(dirname(path),relative))}),{filename:path});return module.exports;
  }
  async function open(name,query={}){
    const path=resolve('miniprogram/pages',name,'index.js');modules.delete(path);definition=null;load(path);
    const page={...definition,data:clone(definition.data),setData(patch){Object.assign(this.data,clone(patch));}};
    page.onLoad(query);await page.onShow();return page;
  }
  return {wx,market,state,requests,messages,copies,open};
}

test('native management is unavailable to mock accounts and cloud buyers even when opened directly',async()=>{
  const mock=fixture({mode:'mock'});
  await assert.rejects(mock.market.getManagementProducts(),{code:'cloud_only'});
  assert.equal((await mock.open('workbench')).data.allowed,false);
  assert.equal((await mock.open('merchants')).data.allowed,false);
  const buyer=fixture({role:'buyer',permissions:[]});
  assert.equal((await buyer.open('workbench')).data.allowed,false);
  assert.equal((await buyer.open('merchants')).data.allowed,false);
  await assert.rejects(buyer.market.shipManagementOrder('DEMO-X',{expectedVersion:1,carrier:'模拟',tracking:'DEMO-X'},idA),{code:'forbidden'});
  assert.equal(buyer.requests.some(row=>row.method==='POST'),false);
});

test('after-sale-only native workbench reads authorized orders without requesting product or shipping APIs',async()=>{
  const r=fixture({role:'merchant',permissions:['aftersales']});
  r.state.orders[0].afterSale={status:'submitted',type:'refund',description:'模拟包装问题'};
  const page=await r.open('workbench');
  assert.equal(page.data.allowed,true);assert.equal(page.data.tab,'after');assert.equal(page.data.canProducts,false);assert.equal(page.data.canOrders,false);
  assert.equal(r.requests.some(row=>row.url.includes('/admin/products')),false);
  page.selectOrder(event({id:r.state.orders[0].id}));await page.operate(event({action:'resolve'}));
  assert.equal(page.data.error,'');assert.equal(r.state.orders[0].afterSale.status,'resolved');
  await assert.rejects(r.market.shipManagementOrder(r.state.orders[0].id,{expectedVersion:2,carrier:'模拟',tracking:'DEMO'},idA),{code:'forbidden'});
});

test('native workbench ships a cloud order with its version and preserves no client role fields',async()=>{
  const r=fixture({role:'merchant',permissions:['orders']});const page=await r.open('workbench');
  page.selectOrder(event({id:r.state.orders[0].id}));page.field({currentTarget:{dataset:{field:'tracking'}},detail:{value:'DEMO-PHONE'}});
  await page.operate(event({action:'ship'}));assert.equal(page.data.error,'');assert.equal(r.state.orders[0].fulfillment.tracking,'DEMO-PHONE');
  const write=r.requests.find(row=>row.url.endsWith('/ship'));
  assert.deepEqual(clone(write.data),{expectedVersion:1,carrier:'模拟物流',tracking:'DEMO-PHONE'});
  assert.equal(write.header.Authorization,'Bearer '+token);
});

test('management write refuses stale page account before sending any write',async()=>{
  const r=fixture();const page=await r.open('workbench');page.selectOrder(event({id:r.state.orders[0].id}));
  r.state.userId=idB;await page.operate(event({action:'ship'}));
  assert.match(page.data.error,/账号已切换/);assert.equal(r.requests.some(row=>row.url.endsWith('/ship')),false);
});

test('native price and stock forms preserve product details, use distinct versions and surface conflicts',async()=>{
  const r=fixture();const page=await r.open('manage-product',{id:'jingtai-apple'});
  assert.equal(page.data.allowed,true);page.field({currentTarget:{dataset:{field:'smallPrice'}},detail:{value:'39.90'}});
  await page.saveProduct();assert.equal(page.data.error,'');assert.equal(r.state.products[0].variants[0].price,3990);assert.equal(r.state.products[0].summary,model.BASE_CATALOG[0].summary);
  page.field({currentTarget:{dataset:{field:'smallStock'}},detail:{value:'6'}});page.field({currentTarget:{dataset:{field:'reason'}},detail:{value:'模拟核对'}});
  await page.saveStock();assert.equal(page.data.error,'');assert.equal(r.state.inventories[0].stocks.small,6);
  const write=r.requests.find(row=>row.url.includes('/admin/inventory/')&&row.method==='PUT');assert.equal(write.data.expectedVersion,1);
  r.state.conflict=true;await page.saveProduct();assert.match(page.data.error,/重新读取/);assert.equal(r.state.products[0].version,2);
});

test('administrator binds exact WeChat account with separate permissions; merchants cannot open authorization page',async()=>{
  const r=fixture();const page=await r.open('merchants');
  for(const [field,value] of Object.entries({userId:idB,name:'景泰模拟采购者',region:'甘肃 · 景泰'}))page.field({currentTarget:{dataset:{field}},detail:{value}});
  page.toggle({currentTarget:{dataset:{field:'orders'}},detail:{value:true}});await page.save();
  assert.equal(page.data.error,'');const write=r.requests.find(row=>row.url.endsWith('/admin/wechat/merchants')&&row.method==='POST');
  assert.deepEqual(clone(write.data),{userId:idB,name:'景泰模拟采购者',region:'甘肃 · 景泰',status:'enabled',permissions:['orders']});
  const merchant=fixture({role:'merchant'});assert.equal((await merchant.open('merchants')).data.allowed,false);
});

test('mine copies the server-issued account identifier without copying session credentials',async()=>{
  const r=fixture({role:'buyer',permissions:[]});const page=await r.open('mine');await page.copyAccount();
  assert.deepEqual(r.copies,[idA]);assert.ok(!r.copies.includes(token));
});

test('newly authorized procurement account can create its own draft, then configure stock and publish',async()=>{
  const r=fixture({role:'merchant',permissions:['products']});r.state.products=[];r.state.inventories=[];
  const page=await r.open('manage-product');assert.equal(page.data.isNew,true);
  page.template(event({id:'pear'}));
  page.field({currentTarget:{dataset:{field:'name'}},detail:{value:'景泰梨模拟商品'}});
  await page.saveStock();assert.match(page.data.error,/先保存商品草稿/);
  await page.saveProduct();assert.equal(page.data.error,'');assert.equal(page.data.isNew,false);
  assert.equal(r.state.products[0].name,'景泰梨模拟商品');assert.equal(r.state.products[0].status,'draft');assert.equal(page.data.inventory.version,0);assert.equal(page.data.inventory.stocks.small,0);
  const created=r.requests.find(row=>row.url.includes('/admin/products/')&&row.method==='PUT');assert.equal(created.data.expectedVersion,0);assert.match(created.data.product.id,/^demo-pear-/);
  for(const [field,value] of Object.entries({smallStock:'2',familyStock:'1',batchCode:'DEMO-PEAR',reason:'模拟首次配置'}))page.field({currentTarget:{dataset:{field}},detail:{value}});
  await page.saveStock();assert.equal(page.data.error,'');assert.equal(page.data.inventory.stocks.small,2);
  page.published({detail:{value:true}});await page.saveProduct();assert.equal(page.data.error,'');assert.equal(r.state.products[0].status,'published');
});
