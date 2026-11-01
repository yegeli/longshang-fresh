import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as model from '../public/model.js';
import { esc, icon } from '../public/ui.js';

// Execute the shipped buyer controller with a small DOM adapter. These checks
// exercise its asynchronous click/submit paths without controlling a browser.
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('deps',`with(deps){${source}\nreturn {createBuyerCloudOrder,refreshBuyerOrders,render,cloudOrderGate,cloudOrderNotice,getPendingCloudOrder,miniProduct,afterSale,afterSaleProgress,getOrders:()=>orders,inventoryPanel,checkout,getDraft:()=>afterDraft,setDraft:value=>{afterDraft=value;},setOrders:value=>{orders=value;ordersReady=true;},getElement:()=>app};}`);
const copy=value=>JSON.parse(JSON.stringify(value));
function element(){return {innerHTML:'',dataset:{},scrollTop:0,hidden:false,children:{length:0},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],querySelector:()=>null,focus(){}};}
function makeOrder(id='DEMO-CLOUD-ONE',version=1){
  model.setCatalog(model.BASE_CATALOG);
  return {...model.createOrder({productId:'jingtai-apple',variant:'small',quantity:1,address:'gansu'},id),version,updatedAt:new Date().toISOString()};
}
async function harness({user={id:'buyer-one',name:'模拟买家'},orders=[],quotedTotal=5590,submit,mutate,storageFails=false,stock=20,batch=null,quotedBatchId}={}){
  const elements=new Map(['#app','#tabbar','#modal-root','#catalog-sync','#toast','.workspace'].map(key=>[key,element()]));
  const events={},windowEvents={},sessionValues=new Map(),requests=[],localOrderReads=[];
  let currentUser=user,currentOrders=copy(orders),submitCount=0,quoteCount=0,orderReader;
  const sessionStorage={getItem:key=>sessionValues.get(key)||null,setItem:(key,value)=>{if(storageFails)throw new Error('blocked');sessionValues.set(key,value);},removeItem:key=>sessionValues.delete(key)};
  const document={querySelector:key=>elements.get(key)||null,querySelectorAll:()=>[],addEventListener:(name,fn)=>{events[name]=fn;},activeElement:{matches:()=>false},hidden:false,title:'',createElement:()=>element()};
  const location={hash:'#/home',origin:'https://example.test'};
  const cloud=()=>({mode:'cloud',session:{user:currentUser,canManage:false},lastSyncedAt:'',error:''});
  const deps={...model,esc,icon,document,location,window:{addEventListener:(name,fn)=>{windowEvents[name]=fn;}},sessionStorage,localStorage:{getItem:key=>{if(key===model.STORAGE_KEY)localOrderReads.push(key);return null;},setItem(){throw new Error('Cloud orders must not write localStorage');}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,crypto:globalThis.crypto,
    refreshBuyerInventory:async()=>{},inventoryFor:()=>batch,availability:()=>({available:stock>0,stock,message:stock?'可售20份':'该规格暂时缺货'}),inventoryFingerprint:()=>'',initializeCatalog:async()=>model.BASE_CATALOG,readCatalog:()=>model.BASE_CATALOG,refreshCatalog:async()=>model.BASE_CATALOG,CATALOG_KEY:'catalog',hydrateMedia:async()=>[],imageFor:p=>p?.image||'assets/apples.jpg',videoFor:()=>'',mediaErrorFor:()=>'',isCloudMode:()=>true,getCloudState:cloud,initializeCloudMode:async()=>cloud(),
    loadCloudOrders:async()=>orderReader?orderReader():({orders:copy(currentOrders),lastSyncedAt:new Date().toISOString()}),loadCloudOrder:async id=>{const order=currentOrders.find(value=>value.id===id);if(!order)throw Object.assign(new Error('not found'),{status:404});return copy(order);},
    quoteCloudOrder:async(items,address)=>{quoteCount++;return {total:quotedTotal,items:items.map(item=>({...item,...(quotedBatchId?{batchId:quotedBatchId}: {})})),address,productVersions:{'jingtai-apple':1},inventoryVersions:{'jingtai-apple':4}};},createOrderRequestKey:()=>`ORDER-test-${++submitCount}`,
    submitCloudOrder:async request=>{requests.push(copy(request));return submit?submit(request,requests.length):makeOrder();},mutateCloudOrder:async(...args)=>{requests.push(args);return mutate?mutate(...args):makeOrder(args[0],2);},
    createExperience:()=>({decorateHome:html=>html,beforeRender(){},routes:{mine:()=>'<p>我的</p>'},handleClick:()=>false,handleSubmit:()=>false,handleChange:()=>false,storage(){},refresh(){},count:()=>0,removeOrderedItems(){}}),
    FormData:class{constructor(form){this.values=form.fields||{};}get(key){return this.values[key]??null;}}
  };
  const api=await run(deps);await new Promise(resolve=>setImmediate(resolve));
  return {...api,events,windowEvents,requests,localOrderReads,sessionValues,location,elements,setUser:value=>{currentUser=value;},setServerOrders:value=>{currentOrders=copy(value);},setOrderReader:value=>{orderReader=value;},counts:()=>({quoteCount,keys:submitCount})};
}

test('buyer cloud orders require login and never read local order storage',async()=>{
  const ui=await harness({user:null});
  assert.match(ui.cloudOrderGate(),/登录后同步订单与售后/);
  assert.match(ui.cloudOrderGate(),/target="_top"/);
  assert.match(ui.cloudOrderGate(),/return_to=%2Findex.html%23%2Forders/);
  assert.deepEqual(ui.localOrderReads,[]);
  await assert.rejects(ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590),/请先登录/);
  assert.equal(ui.requests.length,0);
});

test('an uncertain cloud checkout reuses its saved key and exact request on retry',async()=>{
  const ui=await harness({submit:(request,count)=>{if(count===1)throw Object.assign(new Error('network unavailable'),{status:0});return makeOrder();}});
  const items=[{productId:'jingtai-apple',variant:'small',quantity:1}];
  await assert.rejects(ui.createBuyerCloudOrder(items,'gansu',5590),/network/);
  assert.equal(ui.getOrders().length,0,'An uncertain write must not create a local success record');
  assert.ok(ui.getPendingCloudOrder());
  const result=await ui.createBuyerCloudOrder(items,'gansu',5590);
  assert.equal(result.id,'DEMO-CLOUD-ONE');
  assert.deepEqual(ui.requests[0],ui.requests[1]);
  assert.equal(ui.counts().quoteCount,1,'Retry resolves the original request before asking for a new quote');
  assert.equal(ui.getOrders().length,1);
  assert.equal(ui.getPendingCloudOrder(),null);
  assert.deepEqual(ui.localOrderReads,[]);
});

test('a changed server amount requires another confirmation and does not submit an order',async()=>{
  const ui=await harness({quotedTotal:6000});
  await assert.rejects(ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590),/核对最新金额后再次点击/);
  assert.equal(ui.requests.length,0);
  assert.equal(ui.getPendingCloudOrder(),null);
});

test('a different checkout cannot replace an unresolved request; blocked retry storage prevents a write',async()=>{
  const ui=await harness({submit:()=>{throw Object.assign(new Error('uncertain'),{status:503});}});
  await assert.rejects(ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590));
  await assert.rejects(ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:2}],'gansu',10580),/上次下单结果尚未确认/);
  assert.equal(ui.requests.length,1);
  const blocked=await harness({storageFails:true});
  await assert.rejects(blocked.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590),/尚未创建订单/);
  assert.equal(blocked.requests.length,0);
});

test('refreshing after account change clears the previous account orders and after-sale draft',async()=>{
  const old=makeOrder();const ui=await harness({orders:[old]});
  ui.setDraft({orderId:old.id,description:'旧账号未提交内容',expectedVersion:1});
  ui.setUser({id:'buyer-two',name:'另一个模拟账号'});ui.setServerOrders([]);
  await ui.refreshBuyerOrders(true);
  assert.deepEqual(ui.getOrders(),[]);
  assert.equal(ui.getDraft().description,'');
  ui.setUser(null);await ui.refreshBuyerOrders(true);
  assert.match(ui.cloudOrderGate(),/登录后同步/);
});

test('buyer after-sale submission preserves draft/version after a conflict and sends no local record',async()=>{
  const order=makeOrder();const ui=await harness({orders:[order],mutate:()=>{throw Object.assign(new Error('订单已更新，请刷新后重试'),{status:409});}});
  ui.setDraft({orderId:order.id,type:'refund',reason:'damaged',description:'测试保留问题描述',hasEvidence:true,expectedVersion:1});
  const submitButton={disabled:false};const errorNode={textContent:''};
  const form={id:'aftersale-form',dataset:{order:order.id},fields:{type:'refund',reason:'damaged',description:'测试保留问题描述'},querySelector:selector=>selector==='[type=submit]'?submitButton:errorNode};
  await ui.events.submit({target:form,preventDefault(){}});
  assert.match(errorNode.textContent,/订单已更新/);
  assert.equal(ui.getDraft().description,'测试保留问题描述');
  assert.equal(ui.getDraft().expectedVersion,1);
  assert.equal(ui.getOrders()[0].afterSale,undefined);
  assert.equal(ui.requests[0][1],'aftersale');
  assert.equal(ui.requests[0][2].expectedVersion,1);
});

test('cloud order pages hide clear controls and keep snapshot image/name after catalog changes',async()=>{
  const order=makeOrder();order.image='assets/pear.jpg';order.product='下单时的模拟苹果名称';
  const ui=await harness({orders:[order]});ui.location.hash='#/orders';ui.render();
  assert.doesNotMatch(ui.getElement().innerHTML,/data-action="clear-orders"/);
  assert.match(ui.getElement().innerHTML,/订单与售后保存在云端/);
  assert.match(ui.miniProduct(order),/assets\/pear.jpg/);
  assert.match(ui.miniProduct(order),/下单时的模拟苹果名称/);
});


test('an in-flight checkout account change cannot delete either account pending key',async()=>{
  let ui;
  const pendingB={userId:'buyer-two',fingerprint:'other',request:{idempotencyKey:'ORDER-B-KEEP'}};
  ui=await harness({submit:()=>{
    ui.sessionValues.set('longshang-cloud-pending-order-v1:buyer-two',JSON.stringify(pendingB));
    ui.setUser({id:'buyer-two',name:'另一模拟买家'});
    throw Object.assign(new Error('登录账户已变化'),{status:409,code:'account_changed'});
  }});
  await assert.rejects(ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590),/账户已变化/);
  assert.deepEqual(ui.getPendingCloudOrder(),pendingB);
  assert.ok(ui.sessionValues.has('longshang-cloud-pending-order-v1:buyer-one'),'The uncertain original account request must remain recoverable');
  assert.equal(ui.getOrders().length,0);
});

const experienceSource=(await readFile(new URL('../public/experience.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createExperience','function createExperience');
const loadExperience=new Function('deps',`with(deps){${experienceSource}\nreturn createExperience;}`);
function cartHarness(cloudMode=true){
  model.setCatalog(model.BASE_CATALOG);
  const initial=[{productId:'jingtai-apple',variant:'small',quantity:1,selected:true},{productId:'goji',variant:'small',quantity:2,selected:false}];
  const values=new Map([[model.CART_KEY,JSON.stringify(initial)]]),calls=[],notices=[];
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const factory=loadExperience({...model,esc,icon,localStorage:storage,isCloudMode:()=>cloudMode,getCloudState:()=>({session:{user:{id:'buyer-one'}}}),imageFor:p=>p?.image,SPECIALTY_GUIDES:[],COLLECTIONS:[]});
  let fail=true,localOrders=0,path='cart-checkout';
  const api={availability:()=>({available:true,stock:20,message:'可售20份'}),inventoryFor:()=>null,selection:{address:'gansu'},route:()=>[path],nav:value=>{path=value;},toast:value=>notices.push(value),render(){},updateTabs(){},title:()=>'',miniProduct:()=>'',newId:()=> 'DEMO-LOCAL-CART',addOrder:()=>{localOrders++;},createCloudOrder:async(...args)=>{calls.push(args);if(fail)throw new Error('temporary network failure');return makeOrder();}};
  const experience=factory(api);experience.routes['cart-checkout']();
  return {experience,values,initial,calls,notices,setFailure:value=>{fail=value;},localCount:()=>localOrders,getPath:()=>path};
}

test('cloud cart awaits confirmed success, preserves failed rows and submits the amount actually displayed',async()=>{
  const ui=cartHarness();
  model.setCatalog(model.BASE_CATALOG.map(product=>product.id==='jingtai-apple'?{...product,variants:product.variants.map(variant=>({...variant,price:variant.price+100}))}:product));
  await ui.experience.handleClick({action:'x-cart-submit'},{disabled:false});
  assert.deepEqual(JSON.parse(ui.values.get(model.CART_KEY)),ui.initial,'Failed checkout must retain every cart row');
  assert.equal(ui.calls[0][2],5590,'A background catalog cache update cannot silently change the displayed order total');
  assert.equal(ui.calls[0][3]['jingtai-apple::small'],4990);
  ui.setFailure(false);
  await ui.experience.handleClick({action:'x-cart-submit'},{disabled:false});
  assert.deepEqual(JSON.parse(ui.values.get(model.CART_KEY)),[ui.initial[1]],'Only the successfully ordered selection is removed');
  assert.equal(ui.localCount(),0,'Cloud flow must never call the local addOrder path');
  assert.equal(ui.getPath(),'order/DEMO-CLOUD-ONE');
});

test('static cart checkout keeps its local order flow and removes only selected rows',async()=>{
  const ui=cartHarness(false);
  await ui.experience.handleClick({action:'x-cart-submit'},{disabled:false});
  assert.equal(ui.localCount(),1);
  assert.equal(ui.calls.length,0);
  assert.deepEqual(JSON.parse(ui.values.get(model.CART_KEY)),[ui.initial[1]]);
  assert.equal(ui.getPath(),'order/DEMO-LOCAL-CART');
});


test('a delayed list read cannot erase a newly confirmed checkout',async()=>{
  const ui=await harness();let release;
  ui.setOrderReader(()=>new Promise(resolve=>{release=resolve;}));
  const reading=ui.refreshBuyerOrders();await new Promise(resolve=>setImmediate(resolve));
  const created=await ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590);
  release({orders:[],lastSyncedAt:new Date().toISOString()});await reading;
  assert.equal(ui.getOrders().length,1);
  assert.equal(ui.getOrders()[0].id,created.id);
});

test('a delayed read preserves a newer after-sale acknowledgement and its frozen draft version',async()=>{
  const original=makeOrder();
  const updated={...original,version:2,afterSale:{id:'AFTER-CLOUD-ONE',type:'refund',reason:'damaged',description:'问题描述',hasEvidence:false,status:'submitted',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}};
  const ui=await harness({orders:[original],mutate:()=>updated});let release;
  ui.setDraft({orderId:original.id,type:'refund',reason:'damaged',description:'问题描述',hasEvidence:false,expectedVersion:1});
  ui.setOrderReader(()=>new Promise(resolve=>{release=resolve;}));
  const reading=ui.refreshBuyerOrders(true);await new Promise(resolve=>setImmediate(resolve));
  const button={disabled:false},error={textContent:''};
  const form={id:'aftersale-form',dataset:{order:original.id},fields:{type:'refund',reason:'damaged',description:'问题描述'},querySelector:selector=>selector==='[type=submit]'?button:error};
  await ui.events.submit({target:form,preventDefault(){}});
  release({orders:[original],lastSyncedAt:new Date().toISOString()});await reading;
  assert.equal(ui.getOrders()[0].version,2);
  assert.equal(ui.getOrders()[0].afterSale.status,'submitted');
  assert.equal(ui.getDraft().expectedVersion,1,'A read begun before a write must not rebase the pending draft');
});

test('cloud checkout sends the confirmed inventory version and keeps it for uncertain retries',async()=>{
  const ui=await harness({submit:()=>{throw Object.assign(new Error('uncertain'),{status:503});}});
  await assert.rejects(ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590));
  assert.deepEqual(ui.requests[0].inventoryVersions,{'jingtai-apple':4});
  assert.deepEqual(ui.getPendingCloudOrder().request.inventoryVersions,{'jingtai-apple':4});
});

test('a changed harvest batch requires a fresh buyer confirmation without writing an order',async()=>{
  const ui=await harness({quotedBatchId:'BATCH-NEW'});
  await assert.rejects(ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590,undefined,{'jingtai-apple':'BATCH-OLD'}),/批次已更新/);
  assert.equal(ui.requests.length,0);assert.equal(ui.getPendingCloudOrder(),null);
});

test('zero stock disables checkout and batch descriptions are escaped in product and order UI',async()=>{
  const batch={configured:true,batchId:'BATCH-ONE',batchCode:'<img src=x onerror=alert(1)>',harvestDate:'2026-11-01',note:'<script>alert(1)</script>'};
  const ui=await harness({stock:0,batch});model.setCatalog(model.BASE_CATALOG);
  assert.match(ui.checkout(),/data-action="submit" disabled/);
  const panel=ui.inventoryPanel(model.BASE_CATALOG[0],'small',1);
  assert.match(panel,/该规格暂时缺货/);assert.match(panel,/&lt;script&gt;/);assert.ok(!panel.includes('<script>'));
  const item={...model.orderItems(makeOrder())[0],batchId:batch.batchId,batchCode:batch.batchCode,harvestDate:batch.harvestDate,batchNote:batch.note};
  assert.match(ui.miniProduct(item),/&lt;img/);
});
