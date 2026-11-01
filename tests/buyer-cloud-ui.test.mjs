import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as model from '../public/model.js';
import { esc, icon } from '../public/ui.js';
import { createJourney } from '../public/journey.js';
import { localStorefront } from '../public/storefront-data.js';

// Execute the shipped buyer controller with a small DOM adapter. These checks
// exercise its asynchronous click/submit paths without controlling a browser.
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('deps',`with(deps){${source}\nreturn {nav,route,productBack,backRoute,cartCleanupConfirmed,syncBuyerShopping,answerFor,orderStatus,matchesFilter,orderDetail,orderList,canReceive,createBuyerCloudOrder,refreshBuyerOrders,render,cloudOrderGate,cloudOrderNotice,getPendingCloudOrder,miniProduct,afterSale,afterSaleProgress,getOrders:()=>orders,inventoryPanel,checkout,getDraft:()=>afterDraft,setDraft:value=>{afterDraft=value;},setOrders:value=>{orders=value;ordersReady=true;},getElement:()=>app};}`);
const copy=value=>JSON.parse(JSON.stringify(value));
function element(){return {innerHTML:'',dataset:{},scrollTop:0,hidden:false,children:{length:0},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],querySelector:()=>null,focus(){}};}
function makeOrder(id='DEMO-CLOUD-ONE',version=1){
  model.setCatalog(model.BASE_CATALOG);
  return {...model.createOrder({productId:'jingtai-apple',variant:'small',quantity:1,address:'gansu'},id),version,updatedAt:new Date().toISOString()};
}
async function harness({user={id:'buyer-one',name:'模拟买家'},orders=[],quotedTotal=5590,submit,mutate,storageFails=false,stock=20,batch=null,quotedBatchId,cleanupDurable=true}={}){
  const elements=new Map(['#app','#tabbar','#modal-root','#catalog-sync','#toast','.workspace'].map(key=>[key,element()]));
  const events={},windowEvents={},sessionValues=new Map(),requests=[],localOrderReads=[],cleanupPrepared=[];
  let currentUser=user,currentOrders=copy(orders),submitCount=0,quoteCount=0,orderReader,inventoryReader=async()=>{},buyerReader;
  let directory={...localStorefront(model.BASE_CATALOG),ready:true,error:''};
  let buyerState={cart:[],favorites:[],recent:[],preferredAddress:'gansu',accountId:user?.id||'',ready:!!user,error:'',version:0};
  const getBuyerState=()=>copy(buyerState);
  const refreshBuyerState=async()=>{buyerState=buyerReader?await buyerReader():{...buyerState,accountId:currentUser?.id||'',ready:!!currentUser};return getBuyerState();};
  const getStorefrontState=()=>copy(directory);
  const shopForProduct=id=>directory.shops.find(shop=>shop.productIds.includes(id))||null;
  const regionForProduct=id=>directory.regions.find(region=>region.productIds.includes(id))||null;
  const sessionStorage={getItem:key=>sessionValues.get(key)||null,setItem:(key,value)=>{if(storageFails)throw new Error('blocked');sessionValues.set(key,value);},removeItem:key=>sessionValues.delete(key)};
  const document={querySelector:key=>elements.get(key)||null,querySelectorAll:()=>[],addEventListener:(name,fn)=>{events[name]=fn;},activeElement:{matches:()=>false},hidden:false,title:'',createElement:()=>element()};
  let hash='#/home';const location={get hash(){return hash;},set hash(value){hash=value.startsWith('#')?value:'#'+value;},origin:'https://example.test'};
  const cloud=()=>({mode:'cloud',session:{user:currentUser,canManage:false},lastSyncedAt:'',error:''});
  const deps={...model,esc,icon,document,location,window:{addEventListener:(name,fn)=>{windowEvents[name]=fn;}},sessionStorage,localStorage:{getItem:key=>{if(key===model.STORAGE_KEY)localOrderReads.push(key);return null;},setItem(){throw new Error('Cloud orders must not write localStorage');}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,crypto:globalThis.crypto,
    getBuyerState,refreshBuyerState,clearBuyerState:()=>{buyerState={...buyerState,cart:[],favorites:[],recent:[],ready:false};},mutateBuyerState:async transform=>{buyerState={...buyerState,...transform(copy(buyerState))};return getBuyerState();},
    refreshStorefront:async()=>getStorefrontState(),getStorefrontState,shopForProduct,regionForProduct,createJourney:api=>createJourney({...api,getStorefrontState}),
    refreshBuyerInventory:()=>inventoryReader(),inventoryFor:()=>batch,availability:()=>({available:stock>0,stock,message:stock?'可售20份':'该规格暂时缺货'}),inventoryFingerprint:()=>'',initializeCatalog:async()=>model.BASE_CATALOG,readCatalog:()=>model.BASE_CATALOG,refreshCatalog:async()=>model.BASE_CATALOG,CATALOG_KEY:'catalog',hydrateMedia:async()=>[],imageFor:p=>p?.image||'assets/apples.jpg',videoFor:()=>'',mediaErrorFor:()=>'',isCloudMode:()=>true,getCloudState:cloud,initializeCloudMode:async()=>cloud(),
    loadCloudOrders:async()=>orderReader?orderReader():({orders:copy(currentOrders),lastSyncedAt:new Date().toISOString()}),loadCloudOrder:async id=>{const order=currentOrders.find(value=>value.id===id);if(!order)throw Object.assign(new Error('not found'),{status:404});return copy(order);},
    quoteCloudOrder:async(items,address)=>{quoteCount++;return {total:quotedTotal,items:items.map(item=>({...item,...(quotedBatchId?{batchId:quotedBatchId}: {})})),address,productVersions:{'jingtai-apple':1},inventoryVersions:{'jingtai-apple':4}};},createOrderRequestKey:()=>`ORDER-test-${++submitCount}`,
    submitCloudOrder:async request=>{requests.push(copy(request));return submit?submit(request,requests.length):makeOrder();},mutateCloudOrder:async(...args)=>{requests.push(args);return mutate?mutate(...args):makeOrder(args[0],2);},
    createExperience:()=>({prepareOrderCleanup:(id,account)=>{cleanupPrepared.push({id,account});return cleanupDurable;},detailExtras:()=>'',productBar:()=>'',decorateHome:html=>html,beforeRender(){},routes:{mine:()=>'<p>我的</p>'},handleClick:()=>false,handleSubmit:()=>false,handleChange:()=>false,storage(){},refresh:refreshBuyerState,applyBuyerState(){},count:()=>0,removeOrderedItems(){}}),
    FormData:class{constructor(form){this.values=form.fields||{};}get(key){return this.values[key]??null;}}
  };
  const api=await run(deps);await new Promise(resolve=>setImmediate(resolve));
  return {...api,setInventoryReader:value=>{inventoryReader=value;},setBuyerReader:value=>{buyerReader=value;},getBuyerState,cleanupPrepared,setBusy:value=>{document.activeElement.matches=()=>value;},setDirectory:value=>{directory=value;},getDirectory:()=>copy(directory),events,windowEvents,requests,localOrderReads,sessionValues,location,elements,setUser:value=>{currentUser=value;},setServerOrders:value=>{currentOrders=copy(value);},setOrderReader:value=>{orderReader=value;},counts:()=>({quoteCount,keys:submitCount})};
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
  const api={getStorefrontState:()=>({ready:true,error:''}),shopForProduct:()=>({id:'shop-test',name:'模拟采购者',preview:false}),availability:()=>({available:true,stock:20,message:'可售20份'}),inventoryFor:()=>null,selection:{address:'gansu'},route:()=>[path],nav:value=>{path=value;},toast:value=>notices.push(value),render(){},updateTabs(){},title:()=>'',miniProduct:()=>'',newId:()=> 'DEMO-LOCAL-CART',addOrder:()=>{localOrders++;},createCloudOrder:async(...args)=>{calls.push(args);if(fail)throw new Error('temporary network failure');return makeOrder();}};
  const state=()=>({cart:JSON.parse(values.get(model.CART_KEY)),favorites:[],recent:[],preferredAddress:'gansu',ready:true,error:'',accountId:'buyer-one',version:1});
  api.getBuyerState=state;api.refreshBuyerState=async()=>state();
  api.mutateBuyerState=async transform=>{const draft=state();const next=transform(draft)||draft;values.set(model.CART_KEY,JSON.stringify(next.cart));return state();};
  api.consumeBuyerOrder=async()=>{const items=calls.at(-1)[0];values.set(model.CART_KEY,JSON.stringify(state().cart.flatMap(row=>{const ordered=items.find(item=>item.productId===row.productId&&item.variant===row.variant);return !ordered||!row.selected?[row]:row.quantity>ordered.quantity?[{...row,quantity:row.quantity-ordered.quantity}]:[];})));return state();};
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

test('new cloud orders require one resolved shop; directory failure cannot block an uncertain retry',async()=>{
  const ui=await harness({submit:(request,count)=>{if(count===1)throw Object.assign(new Error('uncertain'),{status:503});return makeOrder();}});
  const original=ui.getDirectory(),items=[{productId:'jingtai-apple',variant:'small',quantity:1}];
  ui.setDirectory({regions:[],shops:[],ready:true,error:'network failure'});
  await assert.rejects(ui.createBuyerCloudOrder(items,'gansu',5590),/店铺暂时无法确认/);
  assert.equal(ui.counts().quoteCount,0);
  ui.setDirectory({...original,shops:[{id:'shop-a',productIds:['jingtai-apple'],preview:false},{id:'shop-b',productIds:['goji'],preview:false}]});
  await assert.rejects(ui.createBuyerCloudOrder([...items,{productId:'goji',variant:'small',quantity:1}],'gansu',5590),/分开下单/);
  assert.equal(ui.counts().quoteCount,0);
  ui.setDirectory(original);
  await assert.rejects(ui.createBuyerCloudOrder(items,'gansu',5590),/uncertain/);
  ui.setDirectory({regions:[],shops:[],ready:true,error:'network failure'});
  assert.equal((await ui.createBuyerCloudOrder(items,'gansu',5590)).id,'DEMO-CLOUD-ONE');
  assert.deepEqual(ui.requests[0],ui.requests[1]);
});

test('region, shop and product navigation keeps the source, filter and scroll when returning',async()=>{
  const ui=await harness();model.setCatalog(model.BASE_CATALOG);
  async function click(dataset){
    const button={dataset,disabled:false};
    await ui.events.click({target:{classList:{contains:()=>false},closest:()=>button}});
    ui.windowEvents.hashchange({});
  }
  await click({action:'navigate',route:'region/gansu-jingtai'});
  assert.match(ui.getElement().innerHTML,/景泰/);
  ui.getElement().scrollTop=311;
  await click({action:'navigate',route:'shop/shop-local-demo'});
  assert.equal(ui.backRoute('shop','shop-local-demo','shops'),'region/gansu-jingtai');
  await ui.events.click({target:{classList:{contains:()=>false},closest:()=>({dataset:{action:'journey-shop-category',shop:'shop-local-demo',category:'fruit'}})}});
  ui.getElement().scrollTop=527;
  await click({action:'view-product',product:'jingtai-apple'});
  assert.equal(ui.productBack('jingtai-apple'),'shop/shop-local-demo');
  assert.match(ui.getElement().innerHTML,/journey-product-context/);
  await click({action:'navigate',route:'region/gansu-jingtai'});
  assert.equal(ui.backRoute('region','gansu-jingtai','regions'),'home','A product breadcrumb must not turn its ancestor into a child');
  assert.equal(ui.getElement().scrollTop,311);
  await click({action:'navigate',route:'shop/shop-local-demo'});
  assert.equal(ui.backRoute('shop','shop-local-demo','shops'),'region/gansu-jingtai');
  ui.getElement().scrollTop=527;
  await click({action:'view-product',product:'jingtai-apple'});
  await click({action:'back',route:ui.productBack('jingtai-apple')});
  assert.equal(ui.getElement().scrollTop,527);
  assert.match(ui.getElement().innerHTML,/data-category="fruit" class="is-selected"/);
  await click({action:'back',route:ui.backRoute('shop','shop-local-demo','shops')});
  assert.equal(ui.getElement().scrollTop,311);
});

test('search routes decode exactly once and malformed routes show a recovery page',async()=>{
  const ui=await harness();model.setCatalog(model.BASE_CATALOG);
  ui.location.hash='#/search/'+encodeURIComponent('苹果 100% / %25');ui.windowEvents.hashchange({});
  assert.deepEqual(ui.route(),['search','苹果 100% / %25']);
  assert.match(ui.getElement().innerHTML,/苹果 100% \/ %25/);
  ui.location.hash='#/search/%invalid';ui.windowEvents.hashchange({});
  assert.match(ui.getElement().innerHTML,/页面暂未找到/);
  assert.ok(!ui.getElement().innerHTML.includes('journey-hero'));
});

test('buyer confirmation uses the opened order version, then shows completed status with after-sale access',async()=>{
  const shipped={...model.shipOrder(makeOrder(),'模拟物流','DEMO-RECEIVE'),version:2};
  const received={...model.receiveOrder(shipped),version:3};
  const ui=await harness({orders:[shipped],mutate:()=>received});
  const button={dataset:{action:'receive-order',id:shipped.id},disabled:false};
  const click=()=>ui.events.click({target:{classList:{contains:()=>false},closest:()=>button}});
  await click();assert.match(ui.elements.get('#modal-root').innerHTML,/data-version="2"/);
  button.dataset={action:'confirm-receive',id:shipped.id,version:'2'};await click();
  assert.equal(ui.requests[0][1],'receive');assert.deepEqual(ui.requests[0][2],{expectedVersion:2});
  assert.equal(ui.getOrders()[0].version,3);assert.equal(ui.canReceive(ui.getOrders()[0]),false);
  assert.equal(ui.matchesFilter(received,'received'),true);assert.equal(ui.matchesFilter(received,'shipped'),false);
  const html=ui.orderDetail(received.id);assert.match(html,/已完成（模拟）/);assert.match(html,/买家已确认模拟收货/);
  assert.match(html,/申请售后/);assert.doesNotMatch(html,/data-action="receive-order"/);
});

test('receipt conflicts reload cloud truth and do not locally mark an order received',async()=>{
  const shipped={...model.shipOrder(makeOrder(),'模拟物流','DEMO-CONFLICT'),version:2};
  const newer={...shipped,version:3,afterSale:{id:'AFTER-ONE',status:'submitted',type:'refund',reason:'damaged',description:'模拟问题',hasEvidence:false,createdAt:shipped.createdAt,updatedAt:shipped.createdAt}};
  const ui=await harness({orders:[shipped],mutate:()=>{throw Object.assign(new Error('版本冲突'),{status:409});}});
  ui.setServerOrders([newer]);
  const button={dataset:{action:'confirm-receive',id:shipped.id,version:'2'},disabled:false};
  await ui.events.click({target:{classList:{contains:()=>false},closest:()=>button}});
  assert.equal(ui.getOrders()[0].version,3);assert.equal(ui.getOrders()[0].receipt,undefined);
  assert.equal(ui.canReceive(ui.getOrders()[0]),false);assert.equal(ui.elements.get('#modal-root').innerHTML,'');
});

test('all-orders list renders persisted cards and help topics keep their replies after adding onboarding FAQs',async()=>{
  const first=makeOrder(),second=makeOrder('DEMO-CLOUD-TWO');
  const ui=await harness({orders:[first,second]});
  assert.equal((ui.orderList().match(/class="order-card"/g)||[]).length,2);
  assert.match(ui.orderList(),/DEMO-CLOUD-TWO/);
  assert.match(ui.answerFor('运费多少'),/甘肃.*6 元/);
  assert.match(ui.answerFor('我要申请售后'),/申请售后/);
  assert.match(ui.answerFor('苹果有多大'),/75–85mm/);
  assert.match(ui.answerFor('手机电脑同步吗'),/同一账号/);
});

test('account changes during post-checkout inventory refresh cannot expose the old order to the new account',async()=>{
  const ui=await harness();let release;
  ui.setInventoryReader(()=>new Promise(resolve=>{release=resolve;}));
  const operation=ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590);
  for(let i=0;i<30&&!release;i++)await Promise.resolve();assert.ok(release);
  ui.setUser({id:'buyer-two'});release();
  await assert.rejects(operation,/登录账号已变化/);
  assert.deepEqual(ui.getOrders(),[]);assert.equal(ui.requests.length,1);
});

test('shopping refresh deferred during input redraws once the page becomes idle even without another data change',async()=>{
  const ui=await harness();const state={...ui.getBuyerState(),version:2,favorites:['jingtai-apple']};
  ui.setBuyerReader(async()=>state);ui.getElement().innerHTML='editing content';ui.setBusy(true);
  await ui.syncBuyerShopping();assert.equal(ui.getElement().innerHTML,'editing content');
  ui.setBusy(false);await ui.syncBuyerShopping();assert.notEqual(ui.getElement().innerHTML,'editing content');
});

test('cart recovery is registered before inventory awaits and original pending survives if the marker cannot persist',async()=>{
  for(const durable of [true,false]){
    const ui=await harness({cleanupDurable:durable});ui.location.hash='#/cart-checkout';let release;
    ui.setInventoryReader(()=>new Promise(resolve=>{release=resolve;}));
    const operation=ui.createBuyerCloudOrder([{productId:'jingtai-apple',variant:'small',quantity:1}],'gansu',5590);
    for(let i=0;i<30&&!release;i++)await Promise.resolve();assert.ok(release);
    assert.deepEqual(ui.cleanupPrepared,[{id:'DEMO-CLOUD-ONE',account:'buyer-one'}]);
    assert.equal(!!ui.getPendingCloudOrder(),!durable);
    release();await operation;
    ui.cartCleanupConfirmed('DEMO-CLOUD-ONE','buyer-two');assert.equal(!!ui.getPendingCloudOrder(),!durable);
    ui.cartCleanupConfirmed('DEMO-CLOUD-ONE','buyer-one');assert.equal(ui.getPendingCloudOrder(),null);
  }
});
