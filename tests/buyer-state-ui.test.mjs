import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as model from '../public/model.js';
import { esc, icon } from '../public/ui.js';

const source=(await readFile(new URL('../public/experience.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createExperience','function createExperience');
const load=new Function('deps',`with(deps){${source}\nreturn createExperience;}`);
const copy=value=>structuredClone(value);
const apple={productId:'jingtai-apple',variant:'small',quantity:2,selected:true};
const goji={productId:'goji',variant:'small',quantity:3,selected:false};
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};

function harness({cloud=true,user={id:'buyer-a',name:'模拟买家'},ready=true,rows=[apple,goji],favorites=[],recent=[],localRows=[goji],sessionValues=new Map(),sessionFails=false}={}){
  model.setCatalog(model.BASE_CATALOG);
  let state={accountId:user?.id||'',ready,loading:false,saving:false,error:'',cart:copy(rows),favorites:copy(favorites),recent:copy(recent),preferredAddress:'gansu',version:1,lastSyncedAt:'2026-11-01T02:00:00Z'};
  let currentUser=user,sessionError='',path='cart',held=false,mutationFailure='',consumeFailure='',consumeHook=null,orderFailure='',refreshCount=0,renders=0,updates=0;
  const local=new Map([[model.CART_KEY,JSON.stringify(localRows)],['longshang-demo-library-v1',JSON.stringify({favorites:['goji'],recent:['goji']})]]);
  const localOps=[],mutations=[],consumptions=[],cleanupConfirmed=[],notices=[],orders=[],gates=[],deferred=[];
  const consumed=new Set();
  const storage={getItem:key=>{localOps.push(['get',key]);return local.get(key)||null;},setItem:(key,value)=>{localOps.push(['set',key]);local.set(key,value);}};
  const sessionStorage={getItem:key=>sessionValues.get(key)||null,setItem:(key,value)=>{if(sessionFails)throw Error('session storage blocked');sessionValues.set(key,value);},removeItem:key=>sessionValues.delete(key)};
  const mutate=async transform=>{
    const requested=currentUser?.id;mutations.push(transform);state.saving=true;
    if(held)await new Promise(resolve=>deferred.push(resolve));
    try{
      if(requested!==currentUser?.id)throw Error('账号已变化');
      if(mutationFailure)throw Error(mutationFailure);
      const draft=copy({cart:state.cart,favorites:state.favorites,recent:state.recent,preferredAddress:state.preferredAddress});
      const changed=transform(draft)||draft;
      state={...state,...changed,version:state.version+1,error:''};return copy(state);
    }finally{state.saving=false;}
  };
  const consume=async orderId=>{
    consumptions.push(orderId);if(consumeFailure)throw Error(consumeFailure);
    if(consumeHook)return await consumeHook(orderId);
    if(!consumed.has(orderId)){state.cart=state.cart.flatMap(row=>row.productId===apple.productId&&row.variant===apple.variant&&row.selected?(row.quantity>2?[{...row,quantity:row.quantity-2}]:[]):[row]);consumed.add(orderId);state.version++;}
    return copy(state);
  };
  const deps={...model,esc,icon,localStorage:storage,sessionStorage,isCloudMode:()=>cloud,getCloudState:()=>({session:{user:currentUser},error:sessionError}),imageFor:product=>product?.image,SPECIALTY_GUIDES:[],COLLECTIONS:[],getBuyerState:()=>copy(state),refreshBuyerState:async()=>{refreshCount++;return copy(state);},mutateBuyerState:mutate,consumeBuyerOrder:consume};
  const api={selection:{productId:'jingtai-apple',variant:'small',quantity:1,address:'gansu'},route:()=>path.split('/'),nav:value=>{path=value;},render:()=>{renders++;},updateTabs:()=>{updates++;},toast:value=>notices.push(value),getOrders:()=>orders,addressLabel:()=>api.selection.address==='shaanxi'?'陕西示例地区':'甘肃示例地区',accountPanel:()=>'',title:heading=>`<h1>${heading}</h1>`,productCard:product=>`<button data-action="view-product" data-product="${esc(product.id)}">${esc(product.name)}</button>`,availability:()=>({available:true,message:'有货'}),inventoryFor:()=>null,shopForProduct:()=>({id:'shop-demo',name:'景泰模拟店',preview:false}),getStorefrontState:()=>({ready:true,error:''}),miniProduct:()=>'',openOrders:filter=>gates.push(filter),showModal:(heading,body)=>gates.push({heading,body}),closeModal:()=>gates.push('closed'),addOrder:order=>orders.push(order),newId:()=> 'DEMO-LOCAL',createCloudOrder:async()=>{if(orderFailure)throw Error(orderFailure);return {id:'DEMO-CONFIRMED'};},cartCleanupConfirmed:(orderId,account)=>cleanupConfirmed.push([orderId,account])};
  const factory=load(deps);let experience=factory(api);
  return {api,state:()=>copy(state),setState:value=>{state={...state,...copy(value)};},setUser:value=>{currentUser=value;},setSessionError:value=>{sessionError=value;},setHeld:value=>{held=value;},release:()=>deferred.splice(0).forEach(resolve=>resolve()),setMutationFailure:value=>{mutationFailure=value;},setConsumeFailure:value=>{consumeFailure=value;},setConsumeHook:value=>{consumeHook=value;},setOrderFailure:value=>{orderFailure=value;},setPath:value=>{path=value;},path:()=>path,experience,local,localOps,mutations,consumptions,cleanupConfirmed,notices,orders,gates,sessionValues,refreshCount:()=>refreshCount,renders:()=>renders,updates:()=>updates,
    reload:()=>{experience=factory(api);return experience;},click:(data)=>experience.handleClick(data,{disabled:false})};
}

test('anonymous cloud entry shows sign in without reading or uploading old browser cart, favorites or history',async()=>{
  const h=harness({user:null});
  for(const route of ['cart','favorites','history']){
    h.setPath(route);const html=h.experience.routes[route]();
    assert.match(html,/登录账号/);assert.match(html,/signin-with-chatgpt/);assert.doesNotMatch(html,/景泰干枸杞|景泰红富士苹果/);
  }
  assert.equal(h.experience.count(),0);assert.equal(h.experience.favorites(),0);
  await h.click({action:'x-favorite',product:'jingtai-apple'});
  assert.equal(h.path(),'favorites');assert.equal(h.mutations.length,0);assert.deepEqual(h.localOps,[]);
});

test('cloud loading, session and shopping-read failures are distinct and keep a refresh path',async()=>{
  const h=harness({ready:false});
  assert.match(h.experience.routes.cart(),/正在读取账号购物资料/);
  h.setState({error:'<网络中断>'});
  assert.match(h.experience.routes.cart(),/账号购物资料暂时无法读取/);
  assert.match(h.experience.routes.cart(),/&lt;网络中断&gt;/);
  h.setSessionError('登录接口不可用');
  assert.match(h.experience.routes.favorites(),/登录状态暂时无法确认/);
  assert.match(h.experience.routes.favorites(),/data-action="x-refresh-buyer"/);
  h.setSessionError('');h.setState({ready:true,error:''});
  await h.click({action:'x-refresh-buyer'});
  assert.equal(h.refreshCount(),1);assert.deepEqual(h.localOps,[]);
});

test('favorite writes show success only after cloud confirmation and preserve the previous state on failure',async()=>{
  const h=harness({favorites:[]});h.setHeld(true);
  const pending=h.click({action:'x-favorite',product:'jingtai-apple'});
  assert.equal(h.experience.favorites(),0);assert.equal(h.notices.length,0);
  h.release();await pending;
  assert.equal(h.experience.favorites(),1);assert.match(h.notices.at(-1),/已同步到我的收藏/);
  h.setHeld(false);h.setMutationFailure('版本冲突，请刷新');
  await h.click({action:'x-favorite',product:'jingtai-apple'});
  assert.equal(h.experience.favorites(),1);assert.match(h.notices.at(-1),/版本冲突/);assert.deepEqual(h.localOps,[]);
});

test('a conflicting write displays the refreshed cloud truth and prompts review without retrying the mutation',async()=>{
  const h=harness({favorites:['jingtai-apple']});h.setHeld(true);
  const pending=h.click({action:'x-favorite',product:'goji'});
  h.setState({favorites:['goji'],error:'购物资料已变化；已重新读取，请核对后重做。'});h.setMutationFailure('购物资料已变化；已重新读取，请核对后重做。');
  h.release();await pending;
  assert.equal(h.mutations.length,1);assert.deepEqual(h.state().favorites,['goji']);
  assert.match(h.experience.routes.favorites(),/购物资料已变化/);
  assert.match(h.experience.routes.favorites(),/刷新购物资料/);
  assert.doesNotMatch(h.notices.join(' '),/已同步到我的收藏/);
});

test('cloud cart edits preserve unrelated, unselected and unavailable rows, and checkbox changes await confirmation',async()=>{
  const missing={productId:'removed-product',variant:'small',quantity:4,selected:false};
  const h=harness({rows:[apple,goji,missing]});
  assert.match(h.experience.routes.cart(),/商品暂不可用/);
  h.setHeld(true);
  const pending=h.experience.handleChange({id:'',dataset:{cartSelect:'goji::small'},checked:true,matches:selector=>selector==='[data-cart-select]'});
  assert.equal(h.state().cart[1].selected,false);
  h.release();await pending;
  assert.deepEqual(h.state().cart,[apple,{...goji,selected:true},missing]);
  h.setHeld(false);
  await h.click({action:'x-cart-quantity',key:'jingtai-apple::small',delta:'1'});
  assert.deepEqual(h.state().cart,[{...apple,quantity:3},{...goji,selected:true},missing]);
  await h.click({action:'x-cart-remove',key:'removed-product::small'});
  assert.deepEqual(h.state().cart,[{...apple,quantity:3},{...goji,selected:true}]);
  assert.deepEqual(h.localOps,[]);
});

test('add to cloud cart freezes the clicked selection while a queued write waits',async()=>{
  const h=harness({rows:[goji]});h.setHeld(true);
  const pending=h.click({action:'x-add-cart'});
  h.api.selection.productId='goji';h.api.selection.variant='family';h.api.selection.quantity=9;
  h.release();await pending;
  assert.deepEqual(h.state().cart,[goji,{productId:'jingtai-apple',variant:'small',quantity:1,selected:true}]);
  assert.deepEqual(h.localOps,[]);
});

test('account changes immediately hide prior cart, favorites and delayed mutation results',async()=>{
  const h=harness({favorites:['jingtai-apple']});h.setHeld(true);
  const pending=h.click({action:'x-favorite',product:'goji'});
  h.setUser({id:'buyer-b'});h.experience.applyBuyerState();
  assert.equal(h.experience.count(),0);assert.equal(h.experience.favorites(),0);
  assert.match(h.experience.routes.cart(),/正在读取账号购物资料/);
  h.release();await pending;
  assert.equal(h.experience.count(),0);assert.equal(h.experience.favorites(),0);
  assert.doesNotMatch(h.notices.join(' '),/已同步到我的收藏/);
  h.setState({accountId:'buyer-b',cart:[goji],favorites:['goji'],recent:[],preferredAddress:'shaanxi'});
  h.experience.applyBuyerState();assert.equal(h.experience.count(),3);assert.equal(h.api.selection.address,'shaanxi');
});

test('recent browsing writes once per visit, never loops on renders, and resumes on a later visit',async()=>{
  const h=harness({recent:[]});h.setPath('product/jingtai-apple');h.setHeld(true);
  h.experience.beforeRender('product','jingtai-apple');h.experience.beforeRender('product','jingtai-apple');h.experience.beforeRender('product','jingtai-apple');
  assert.equal(h.mutations.length,1);assert.deepEqual(h.state().recent,[]);
  h.release();await flush();assert.deepEqual(h.state().recent,['jingtai-apple']);
  h.experience.beforeRender('product','jingtai-apple');assert.equal(h.mutations.length,1);
  h.setHeld(false);h.experience.beforeRender('home');h.experience.beforeRender('product','goji');await flush();
  assert.deepEqual(h.state().recent,['goji','jingtai-apple']);assert.equal(h.mutations.length,2);assert.deepEqual(h.localOps,[]);
});

test('clearing cloud history retains favorites and waits for confirmed save before closing its dialog',async()=>{
  const h=harness({favorites:['jingtai-apple'],recent:['goji']});h.setHeld(true);
  await h.click({action:'x-clear-history'});assert.match(h.gates[0].heading,/当前账号/);
  const pending=h.click({action:'x-confirm-clear-history'});assert.deepEqual(h.state().recent,['goji']);assert.ok(!h.gates.includes('closed'));
  h.release();await pending;
  assert.deepEqual(h.state().recent,[]);assert.deepEqual(h.state().favorites,['jingtai-apple']);assert.ok(h.gates.includes('closed'));
});

test('confirmed checkout stays successful when cart consumption fails, and cleanup survives reload only for its account',async()=>{
  const h=harness();h.setPath('cart-checkout');h.experience.routes['cart-checkout']();h.setConsumeFailure('timeout');
  await h.click({action:'x-cart-submit'});
  assert.equal(h.path(),'order/DEMO-CONFIRMED');assert.deepEqual(h.state().cart,[apple,goji]);
  assert.deepEqual(h.consumptions,['DEMO-CONFIRMED']);assert.match(h.notices.at(-1),/订单已经生成/);
  assert.match(h.experience.orderShoppingNotice('DEMO-CONFIRMED'),/重试同步购物车/);
  assert.equal(h.experience.orderShoppingNotice('DIRECT-ORDER'),'');
  assert.ok([...h.sessionValues.keys()].some(key=>key.endsWith('buyer-a')));
  const reloaded=h.reload();assert.match(reloaded.orderShoppingNotice('DEMO-CONFIRMED'),/请勿为此重复下单/);
  h.setUser({id:'buyer-b'});reloaded.applyBuyerState();assert.equal(reloaded.orderShoppingNotice('DEMO-CONFIRMED'),'');
  h.setUser({id:'buyer-a'});reloaded.applyBuyerState();h.setConsumeFailure('');
  await reloaded.handleClick({action:'x-retry-cart-cleanup',order:'DEMO-CONFIRMED'},{disabled:false});
  assert.equal(reloaded.orderShoppingNotice('DEMO-CONFIRMED'),'');assert.deepEqual(h.state().cart,[goji]);
  await reloaded.removeOrderedItems([], 'DEMO-CONFIRMED');assert.deepEqual(h.state().cart,[goji]);
  assert.deepEqual(h.localOps,[]);
});

test('failed order submission retains all cart rows without starting a cleanup operation',async()=>{
  const h=harness();h.setPath('cart-checkout');h.experience.routes['cart-checkout']();h.setOrderFailure('订单结果未确认，请重试');
  await h.click({action:'x-cart-submit'});
  assert.equal(h.path(),'cart-checkout');assert.deepEqual(h.state().cart,[apple,goji]);assert.deepEqual(h.consumptions,[]);assert.equal(h.sessionValues.size,0);
});

test('an account switch after order creation cannot consume or mark the new account cart or open the old order',async()=>{
  const h=harness();let confirmOrder;
  h.api.createCloudOrder=()=>new Promise(resolve=>{confirmOrder=resolve;});
  h.setPath('cart-checkout');h.experience.routes['cart-checkout']();
  const pending=h.click({action:'x-cart-submit'});
  assert.equal(typeof confirmOrder,'function');
  h.setUser({id:'buyer-b'});h.setState({accountId:'buyer-b',cart:[goji],favorites:[],recent:[]});h.experience.applyBuyerState();
  confirmOrder({id:'DEMO-ACCOUNT-A-ORDER'});await pending;
  assert.deepEqual(h.consumptions,[]);assert.deepEqual(h.state().cart,[goji]);assert.equal(h.sessionValues.size,0);
  assert.equal(h.path(),'cart-checkout');assert.match(h.notices.at(-1),/登录账号已变化/);
  assert.equal(await h.experience.removeOrderedItems([], 'DEMO-ACCOUNT-A-ORDER','buyer-a'),false);
  assert.deepEqual(h.consumptions,[]);assert.equal(h.sessionValues.size,0);
});

test('a stale retry control cannot copy a previous account cleanup marker into the newly logged in account',async()=>{
  const h=harness();h.setConsumeFailure('timeout');
  await h.experience.removeOrderedItems([], 'DEMO-ACCOUNT-A-ORDER','buyer-a');
  assert.equal(h.consumptions.length,1);
  h.setUser({id:'buyer-b'});h.setState({accountId:'buyer-b',cart:[goji]});
  await h.click({action:'x-retry-cart-cleanup',order:'DEMO-ACCOUNT-A-ORDER'});
  assert.equal(h.consumptions.length,1);assert.ok(![...h.sessionValues.keys()].some(key=>key.endsWith('buyer-b')));
  assert.deepEqual(h.state().cart,[goji]);
});

test('an account switch while cleanup is pending retains its original marker and does not navigate to the prior order',async()=>{
  const h=harness();let confirmConsumption;
  h.setConsumeHook(()=>new Promise(resolve=>{confirmConsumption=resolve;}));
  h.setPath('cart-checkout');h.experience.routes['cart-checkout']();
  const pending=h.click({action:'x-cart-submit'});await flush();
  assert.equal(typeof confirmConsumption,'function');
  h.setUser({id:'buyer-b'});h.setState({accountId:'buyer-b',cart:[goji]});h.experience.applyBuyerState();
  confirmConsumption(h.state());await pending;
  assert.equal(h.path(),'cart-checkout');assert.deepEqual(h.state().cart,[goji]);
  assert.ok([...h.sessionValues.keys()].some(key=>key.endsWith('buyer-a')));
  assert.ok(![...h.sessionValues.keys()].some(key=>key.endsWith('buyer-b')));
  assert.deepEqual(h.cleanupConfirmed,[]);
});

test('cleanup can be prepared synchronously before any awaited work, reports persistence and restores only its account after reload',()=>{
  const h=harness();
  assert.equal(h.experience.prepareOrderCleanup('DEMO-PREPARED','buyer-a'),true);
  assert.deepEqual(h.consumptions,[]);
  const reloaded=h.reload();assert.match(reloaded.orderShoppingNotice('DEMO-PREPARED'),/重试同步购物车/);
  const before=copy([...h.sessionValues]);
  assert.equal(reloaded.prepareOrderCleanup('DEMO-WRONG-ACCOUNT','buyer-b'),false);
  assert.deepEqual([...h.sessionValues],before);
  const blocked=harness({sessionFails:true});
  assert.equal(blocked.experience.prepareOrderCleanup('DEMO-IN-MEMORY','buyer-a'),false);
  assert.equal(blocked.sessionValues.size,0);assert.match(blocked.experience.orderShoppingNotice('DEMO-IN-MEMORY'),/重试同步购物车/);
});

test('cleanup confirmation calls the controller only after same-account consumption succeeds',async()=>{
  const h=harness();h.setConsumeFailure('timeout');
  assert.equal(await h.experience.removeOrderedItems([], 'DEMO-CONFIRMED','buyer-a'),false);assert.deepEqual(h.cleanupConfirmed,[]);
  h.setConsumeFailure('');
  assert.equal(await h.experience.removeOrderedItems([], 'DEMO-CONFIRMED','buyer-a'),true);
  assert.deepEqual(h.cleanupConfirmed,[['DEMO-CONFIRMED','buyer-a']]);
  h.setUser({id:'buyer-b'});
  assert.equal(await h.experience.removeOrderedItems([], 'DEMO-CONFIRMED','buyer-a'),false);
  assert.deepEqual(h.cleanupConfirmed,[['DEMO-CONFIRMED','buyer-a']]);
});

test('cleanup markers are bounded and a blocked session store cannot turn a confirmed order into a checkout failure',async()=>{
  const key='longshang-buyer-cart-cleanup-v1:buyer-a';
  const sessionValues=new Map([[key,JSON.stringify(Array.from({length:50},(_,index)=>'DEMO-SAVED-'+index))]]);
  const bounded=harness({sessionValues});bounded.setConsumeFailure('timeout');
  await bounded.experience.removeOrderedItems([], 'DEMO-NEW-CONFIRMED');
  const ids=JSON.parse(sessionValues.get(key));assert.equal(ids.length,50);assert.equal(ids[0],'DEMO-NEW-CONFIRMED');
  const blocked=harness({sessionFails:true});blocked.setPath('cart-checkout');blocked.experience.routes['cart-checkout']();blocked.setConsumeFailure('timeout');
  await blocked.click({action:'x-cart-submit'});
  assert.equal(blocked.path(),'order/DEMO-CONFIRMED');assert.match(blocked.notices.join(' '),/无法保存购物车同步提醒/);
  assert.match(blocked.experience.orderShoppingNotice('DEMO-CONFIRMED'),/重试同步购物车/);
});

test('mine exposes waiting, shipped and received filters and preferences applies only confirmed cloud state',()=>{
  const h=harness();h.orders.push({status:'created'},{status:'created',fulfillment:{status:'shipped'}},{status:'created',fulfillment:{status:'shipped'},receipt:{status:'received'}},{status:'cancelled',fulfillment:{status:'shipped'}},{status:'created',afterSale:{status:'resolved',type:'refund'}});
  const html=h.experience.routes.mine();
  for(const filter of ['waiting','shipped','received','aftersale'])assert.match(html,new RegExp(`data-filter="${filter}"`));
  assert.match(html,/data-route="preferences"/);assert.match(html,/data-route="walkthrough"/);assert.match(html,/待收货/);assert.match(html,/已完成/);
  h.setState({preferredAddress:'shaanxi'});h.experience.applyBuyerState();
  const preferences=h.experience.routes.preferences();assert.match(preferences,/陕西示例地区/);assert.match(preferences,/data-action="address"/);assert.match(preferences,/不需要填写真实姓名/);
});

test('static mode keeps browser storage and local checkout without invoking cloud writes',async()=>{
  const h=harness({cloud:false,localRows:[apple,goji]});
  assert.equal(h.experience.count(),5);assert.match(h.experience.routes.favorites(),/仅在本浏览器/);
  await h.click({action:'x-favorite',product:'jingtai-apple'});assert.equal(h.experience.favorites(),2);
  h.setPath('cart-checkout');h.experience.routes['cart-checkout']();await h.click({action:'x-cart-submit'});
  assert.equal(h.path(),'order/DEMO-LOCAL');assert.equal(h.orders.length,1);assert.deepEqual(JSON.parse(h.local.get(model.CART_KEY)),[goji]);assert.equal(h.mutations.length,0);assert.deepEqual(h.consumptions,[]);
});
