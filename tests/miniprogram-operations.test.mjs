import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),model=require('../miniprogram/services/generated/model.js');
const {orderHistory}=require('../miniprogram/pages/order/history.js');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const tap=dataset=>({currentTarget:{dataset}}),input=value=>({detail:{value}});
const A='wechat:'+'a'.repeat(64),B='wechat:'+'b'.repeat(64),merchantId='MERCHANT-11111111-1111-4111-8111-111111111111';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture({mode='cloud',role='admin',permissions=['products','orders','aftersales']}={}){
  const requests=[],messages=[];
  const state={session:{user:{id:A},canManage:role!=='buyer',role,permissions,merchant:{name:'模拟采购者',region:'甘肃'}},
    products:[{...clone(model.BASE_CATALOG[0]),version:1,status:'published'},{...clone(model.BASE_CATALOG[2]),id:'demo-pear',name:'景泰梨',version:1,status:'draft'}],
    inventories:[{productId:'jingtai-apple',configured:true,stocks:{small:8,family:4}}],
    orders:[{id:'DEMO-APPLE',version:1,status:'created',product:'景泰苹果',quantity:1,total:5900,shipping:0,merchantNote:'模拟内部备注',items:[{productId:'jingtai-apple',product:'景泰苹果',quantity:1,unitPrice:5900,variant:'small'}]},
      {id:'DEMO-PEAR',version:1,status:'created',product:'景泰梨',quantity:1,total:4900,shipping:0,fulfillment:{status:'shipped',tracking:'DEMO-PEAR-TRACK',carrier:'模拟物流'},items:[{productId:'demo-pear',product:'景泰梨',quantity:1,unitPrice:4900,variant:'small'}]}],
    history:()=>({events:[],nextCursor:null})};
  const market={mode,imageFor:()=>'/assets/apples.jpg',assetUrl:value=>value,
    getSession:async()=>clone(state.session),
    getManagementProducts:async()=>{requests.push('products');return {products:clone(state.products)};},
    getManagementInventory:async()=>({inventories:clone(state.inventories)}),
    listManagementOrders:async()=>({orders:clone(state.orders)}),
    saveManagementOrderNote:async(id,payload,actor)=>{
      const order=state.orders.find(row=>row.id===id);if(actor!==state.session.user.id)throw Object.assign(Error('账号已切换'),{code:'stale_session'});
      requests.push({method:'note',id,payload,actor});
      if(state.conflict||payload.expectedVersion!==order.version)throw Object.assign(Error('订单版本已变化，请重新读取'),{code:'version_conflict',status:409});
      order.merchantNote=payload.note;order.version++;return {order:clone(order)};
    },
    getOrder:async()=>({order:clone(state.buyerOrder||state.orders[0])})};
  for(const [kind,method] of [['product','getManagementProductHistory'],['inventory','getManagementInventoryHistory'],['merchant','getWechatMerchantAudit']])market[method]=async(id,cursor)=>{requests.push({kind,id,cursor});return state.history(kind,id,cursor);};
  const wx={stopPullDownRefresh(){},showToast:e=>messages.push(e.title),showModal:e=>e.success({confirm:true}),getStorageSync:()=>[],navigateTo(){},switchTab(){},pageScrollTo(){}};
  const modules=new Map();let definition;
  function load(path){path=resolve(path);if(!path.endsWith('.js'))path+='.js';if(path===resolve('miniprogram/services/market.js'))return {getMarket:()=>market};if(modules.has(path))return modules.get(path).exports;
    const module={exports:{}};modules.set(path,module);vm.runInContext(readFileSync(path,'utf8'),vm.createContext({wx,console,module,exports:module.exports,Page:value=>{definition=value;},require:relative=>load(resolve(dirname(path),relative))}),{filename:path});return module.exports;}
  async function open(name,query={}){const path=resolve('miniprogram/pages',name,'index.js');modules.delete(path);load(path);const page={...definition,data:clone(definition.data),setData(patch){Object.assign(this.data,clone(patch));}};page.onLoad(query);await page.onShow();return page;}
  return {state,market,requests,messages,open};
}
const event=(id,extra={})=>({id,action:'adjusted',createdAt:'2026-11-01T10:00:00Z',before:{stocks:{small:5,family:3},batchCode:'DEMO-A'},after:{stocks:{small:4,family:3},batchCode:'DEMO-A'},...extra});

test('workbench search and status filters use full authorized arrays and survive refresh',async()=>{
  const r=fixture(),page=await r.open('workbench');
  assert.equal(page.data.counts.products,2);assert.equal(page.data.counts.low,1);assert.equal(page.data.counts.unconfigured,1);
  page.search(input('苹果'));assert.deepEqual(clone(page.data.visibleProducts.map(row=>row.id)),['jingtai-apple']);
  page.search(input('梨'));assert.deepEqual(clone(page.data.visibleProducts.map(row=>row.id)),['demo-pear']);
  page.filter(tap({value:'draft'}));await page.refresh();assert.equal(page.data.productQuery,'梨');assert.equal(page.data.productFilter,'draft');assert.equal(page.data.visibleProducts.length,1);assert.equal(page.data.products.length,2);
  page.chooseTab(tap({tab:'orders'}));page.search(input('苹果'));assert.equal(page.data.visibleOrders[0].id,'DEMO-APPLE');
  page.search(input('PEAR-TRACK'));assert.equal(page.data.visibleOrders[0].id,'DEMO-PEAR');assert.equal(page.data.counts.waiting,1);assert.equal(page.data.counts.shipped,1);
  page.filter(tap({value:'shipped'}));await page.refresh();assert.equal(page.data.orderQuery,'PEAR-TRACK');assert.equal(page.data.orderFilter,'shipped');assert.equal(page.data.orders.length,2);
});

test('order note saves keep selected order and filters, advance version, and retain input on conflict',async()=>{
  const r=fixture(),page=await r.open('workbench');page.chooseTab(tap({tab:'orders'}));page.search(input('APPLE'));page.selectOrder(tap({id:'DEMO-APPLE'}));
  page.field({...input('  模拟包装已核对  '),...tap({field:'note'})});await page.saveNote();
  assert.equal(page.data.selected.id,'DEMO-APPLE');assert.equal(page.data.selected.version,2);assert.equal(page.data.note,'模拟包装已核对');assert.equal(page.data.orderQuery,'APPLE');assert.equal(page.data.orders.length,2);
  const write=r.requests.find(row=>row.method==='note');assert.deepEqual(clone(write.payload),{expectedVersion:1,note:'模拟包装已核对'});assert.equal(write.actor,A);
  page.field({...input('尚未保存的备注'),...tap({field:'note'})});r.state.conflict=true;await page.saveNote();assert.match(page.data.error,/版本已变化/);assert.equal(page.data.note,'尚未保存的备注');assert.equal(page.data.selected.version,2);
  await page.refresh();assert.equal(page.data.note,'尚未保存的备注');
});

test('after-sale-only workbench never exposes or edits internal notes and clears old role data after change',async()=>{
  const r=fixture({role:'merchant',permissions:['aftersales']});r.state.orders[0].afterSale={status:'submitted',type:'refund',description:'模拟包装问题'};
  const page=await r.open('workbench');assert.equal(page.data.tab,'after');assert.equal(page.data.visibleOrders.length,1);assert.equal(page.data.counts.waiting,0);assert.equal(r.requests.includes('products'),false);
  page.selectOrder(tap({id:'DEMO-APPLE'}));assert.equal(page.data.selected.merchantNote,undefined);page.field({...input('越权备注'),...tap({field:'note'})});await page.saveNote();assert.match(page.data.error,/没有订单备注权限/);assert.equal(r.requests.some(row=>row.method==='note'),false);
  r.state.session={user:{id:B},role:'buyer',permissions:[],canManage:false};await page.refresh();assert.equal(page.data.allowed,false);assert.equal(page.data.orders.length,0);assert.equal(page.data.selected,null);
});

test('stale note account is rejected and removes previous private workbench data',async()=>{
  const r=fixture(),page=await r.open('workbench');page.chooseTab(tap({tab:'orders'}));page.selectOrder(tap({id:'DEMO-APPLE'}));r.state.session.user.id=B;await page.saveNote();assert.equal(page.data.allowed,false);assert.equal(page.data.orders.length,0);assert.equal(page.data.note,'');assert.match(page.data.error,/账号已切换/);
});

test('record page rejects mock, unauthorized role, and invalid navigation before history read',async()=>{
  const mock=fixture({mode:'mock'});assert.equal((await mock.open('records',{kind:'product',id:'jingtai-apple'})).data.allowed,false);assert.equal(mock.requests.length,0);
  const merchant=fixture({role:'merchant',permissions:['products']});assert.equal((await merchant.open('records',{kind:'merchant',id:merchantId})).data.allowed,false);assert.equal(merchant.requests.length,0);
  const buyer=fixture({role:'buyer',permissions:[]});assert.equal((await buyer.open('records',{kind:'inventory',id:'jingtai-apple'})).data.allowed,false);
  const admin=fixture();assert.match((await admin.open('records',{kind:'other',id:'jingtai-apple'})).data.error,/入口无效/);assert.equal(admin.requests.length,0);
});

test('record pagination preserves loaded entries on errors, deduplicates and rejects cursor loops',async()=>{
  const r=fixture();r.state.history=()=>({events:[event('1'),event('1'),event('2')],nextCursor:'first'});
  const page=await r.open('records',{kind:'inventory',id:'jingtai-apple'});assert.equal(page.data.events.length,2);
  r.state.history=()=>{throw Error('模拟网络中断');};await page.more();assert.equal(page.data.events.length,2);assert.equal(page.data.nextCursor,'first');assert.match(page.data.moreError,/网络中断/);
  r.state.history=()=>({events:[event('2'),event('3')],nextCursor:'second'});await page.more();assert.deepEqual(clone(page.data.events.map(row=>row.id)),['1','2','3']);
  r.state.history=()=>({events:[event('4')],nextCursor:'first'});await page.more();assert.match(page.data.moreError,/分页重复/);assert.equal(page.data.events.length,3);assert.equal(page.data.nextCursor,'second');
  r.state.history=()=>({events:[event('3'),event('4')],nextCursor:null});await page.more();assert.deepEqual(clone(page.data.events.map(row=>row.id)),['1','2','3','4']);assert.equal(page.data.nextCursor,null);
});

test('records discard late pagination after hide and clear records after account or permission changes',async()=>{
  const r=fixture();r.state.history=()=>({events:[event('1')],nextCursor:'next'});const page=await r.open('records',{kind:'inventory',id:'jingtai-apple'});
  const wait=deferred();r.state.history=()=>wait.promise;const pending=page.more();await new Promise(resolve=>setImmediate(resolve));page.onHide();wait.resolve({events:[event('late')],nextCursor:null});await pending;assert.equal(page.data.events.length,0);assert.equal(page.data.allowed,false);
  r.state.history=()=>({events:[event('fresh')],nextCursor:'next'});await page.onShow();assert.equal(page.data.events[0].id,'fresh');
  const changed=deferred();r.state.history=()=>changed.promise;const next=page.more();await new Promise(resolve=>setImmediate(resolve));r.state.session.user.id=B;changed.resolve({events:[event('other-account')],nextCursor:null});await next;assert.equal(page.data.events.length,0);assert.equal(page.data.allowed,false);assert.match(page.data.error,/账号或权限已变化/);
});

test('record presentation exposes known change summaries without raw user or media identifiers',async()=>{
  const r=fixture();r.state.history=kind=>({events:[kind==='product'?event('p',{action:'updated',actorRole:'merchant',actorId:'PRIVATE-ACTOR',userId:'PRIVATE-USER',version:2,changedFields:['summary','imageMediaId'],before:{name:'景泰苹果',status:'draft',prices:{small:5900,family:8900}},after:{name:'景泰苹果',status:'published',prices:{small:4900,family:8900},imageMediaId:'PRIVATE-MEDIA'}}):event('m',{action:'updated',userId:'PRIVATE-USER',before:{name:'模拟采购者',region:'甘肃',permissions:['products'],status:'enabled'},after:{name:'模拟采购者',region:'甘肃',permissions:['products','orders'],status:'disabled'}})],nextCursor:null});
  const product=await r.open('records',{kind:'product',id:'jingtai-apple'});assert.match(JSON.stringify(product.data.events),/¥49.00/);assert.match(JSON.stringify(product.data.events),/已绑定新图片/);assert.doesNotMatch(JSON.stringify(product.data.events),/PRIVATE/);
  const merchant=await r.open('records',{kind:'merchant',id:merchantId});assert.match(JSON.stringify(merchant.data.events),/订单发货/);assert.match(JSON.stringify(merchant.data.events),/已停用/);assert.doesNotMatch(JSON.stringify(merchant.data.events),/PRIVATE/);
});

test('buyer order history uses stored timestamps, includes repeated after-sale applications once, and removes internal note',async()=>{
  const submitted={id:'AFTER-1',type:'refund',reason:'模拟破损',description:'模拟外箱问题',status:'submitted',createdAt:'2026-11-01T11:00:00Z',updatedAt:'2026-11-01T11:00:00Z'};
  const withdrawn={...submitted,status:'withdrawn',updatedAt:'2026-11-01T12:00:00Z'};
  const resolved={...submitted,id:'AFTER-2',createdAt:'2026-11-01T13:00:00Z',status:'resolved',updatedAt:'2026-11-01T14:00:00Z',merchantReply:'模拟核对完成'};
  const r=fixture();r.state.buyerOrder={...r.state.orders[0],createdAt:'2026-11-01T08:00:00Z',fulfillment:{status:'shipped',carrier:'模拟物流',tracking:'DEMO-X',shippedAt:'2026-11-01T09:00:00Z'},receipt:{status:'received',receivedAt:'2026-11-01T10:00:00Z'},afterSaleHistory:[submitted,withdrawn,resolved],afterSale:resolved,merchantNote:'BUYER-MUST-NOT-SEE'};
  const page=await r.open('order',{id:'DEMO-APPLE'});assert.equal(page.data.timeline.length,7);assert.equal(page.data.timeline[1].title,'商家已模拟发货');assert.equal(page.data.timeline[2].title,'买家已确认模拟收货');assert.equal(page.data.timeline.at(-1).title,'商家完成模拟售后');assert.doesNotMatch(JSON.stringify(page.data),/BUYER-MUST-NOT-SEE/);
});

test('cancelled order explains safe original-batch release versus manual review without inventing cancel time',()=>{
  const base={status:'cancelled',createdAt:'2026-11-01T08:00:00Z',updatedAt:'2026-11-02T08:00:00Z'};
  const safe=orderHistory({...base,inventoryRelease:{status:'released'}});assert.match(safe.cancellation,/已回补原批次/);assert.equal(safe.timeline.at(-1).time,'未记录具体时间');
  assert.match(orderHistory({...base,stockRelease:{status:'review'}}).cancellation,/不会自动补入当前批次/);
  assert.match(orderHistory(base).cancellation,/需采购者核对/);assert.doesNotMatch(JSON.stringify(safe),/2026-11-02/);
});

test('refresh keeps dirty note base version and requires deliberate reload before overwriting concurrent changes',async()=>{
  const r=fixture(),page=await r.open('workbench');page.chooseTab(tap({tab:'orders'}));page.selectOrder(tap({id:'DEMO-APPLE'}));page.field({...input('本机未保存备注'),...tap({field:'note'})});
  r.state.orders[0].merchantNote='电脑刚保存的备注';r.state.orders[0].version=2;await page.refresh();assert.equal(page.data.note,'本机未保存备注');assert.equal(page.data.noteVersion,1);assert.equal(page.data.selected.version,2);
  await page.saveNote();assert.match(page.data.error,/草稿仍保留/);assert.equal(r.requests.some(row=>row.method==='note'),false);assert.equal(r.state.orders[0].merchantNote,'电脑刚保存的备注');
  await page.reloadNote();assert.equal(page.data.noteVersion,2);assert.equal(page.data.note,'电脑刚保存的备注');page.field({...input('核对后修改的备注'),...tap({field:'note'})});await page.saveNote();assert.equal(r.state.orders[0].merchantNote,'核对后修改的备注');assert.equal(r.state.orders[0].version,3);
});

test('note editor ignores changes while save is in flight so successful callback cannot erase newer typed input',async()=>{
  const r=fixture(),page=await r.open('workbench');page.chooseTab(tap({tab:'orders'}));page.selectOrder(tap({id:'DEMO-APPLE'}));page.field({...input('本次提交的备注'),...tap({field:'note'})});
  const wait=deferred(),save=r.market.saveManagementOrderNote;r.market.saveManagementOrderNote=async(...args)=>{await wait.promise;return save(...args);};
  const pending=page.saveNote();assert.equal(page.data.processing,true);page.field({...input('飞行中不应接受的新输入'),...tap({field:'note'})});assert.equal(page.data.note,'本次提交的备注');page.chooseTab(tap({tab:'products'}));assert.equal(page.data.tab,'orders');wait.resolve();await pending;assert.equal(page.data.note,'本次提交的备注');assert.equal(page.data.selected.version,2);assert.equal(page.data.processing,false);
});

test('every backend product audit field has a readable change label',async()=>{
  const fields=['name','category','status','image','origin','subtitle','summary','storage','sizeNote','tags','facts','harvestSteps','variants','video','videoTitle','videoNote','imageMediaId','videoMediaId'];
  const labels=['名称','分类','状态','封面','产地介绍','副标题','简介','保存方式','大小与规格说明','标签','商品参数','采摘说明','规格与价格','视频','视频标题','视频介绍','云端图片','云端视频'];
  const r=fixture();r.state.history=()=>({events:[event('all-fields',{action:'updated',changedFields:fields,before:{name:'模拟苹果',status:'draft',prices:{small:5900,family:8900}},after:{name:'模拟苹果',status:'draft',prices:{small:5900,family:8900}}})],nextCursor:null});const page=await r.open('records',{kind:'product',id:'jingtai-apple'});
  const text=page.data.events[0].description;for(const label of labels)assert.ok(text.includes(label),'missing '+label);
});

test('new product without cloud media does not claim a removal that never happened',async()=>{
  const r=fixture();r.state.history=()=>({events:[event('new-product',{action:'created',before:null,after:{name:'新建模拟苹果',status:'draft',prices:{small:5900,family:8900},imageMediaId:'',videoMediaId:''}})],nextCursor:null});const page=await r.open('records',{kind:'product',id:'jingtai-apple'});assert.equal(page.data.allowed,true);assert.doesNotMatch(JSON.stringify(page.data.events),/已移除|已绑定新/);
});

test('buyer after-sale events translate saved reason codes and show an explicit fallback for unknown codes',()=>{
  for(const [reason,label] of [['damaged','商品或包装破损'],['spec','规格不符'],['delivery','配送问题'],['other','其他模拟问题'],['unknown-code','未分类的模拟问题']]){
    const result=orderHistory({createdAt:'2026-11-01T08:00:00Z',afterSale:{id:'AFTER-1',status:'submitted',type:'refund',reason,createdAt:'2026-11-01T09:00:00Z'}});assert.ok(result.timeline[1].detail.includes(label));assert.equal(result.timeline[1].time,'2026-11-01 17:00:00');assert.doesNotMatch(result.timeline[1].detail,/unknown-code|damaged|delivery/);
  }
});
