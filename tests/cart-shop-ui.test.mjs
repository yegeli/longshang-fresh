import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as model from '../public/model.js';
import { esc, icon } from '../public/ui.js';

const source=(await readFile(new URL('../public/experience.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createExperience','function createExperience');
const load=new Function('deps',`with(deps){${source}\nreturn createExperience;}`);
const copy=value=>JSON.parse(JSON.stringify(value));
const APPLE={productId:'jingtai-apple',variant:'small',quantity:1,selected:true};
const GOJI={productId:'goji',variant:'small',quantity:2,selected:true};
const SHOP_A='shop-aaaaaaaaaaaaaaaaaaaaaaaa',SHOP_B='shop-bbbbbbbbbbbbbbbbbbbbbbbb';
function harness({cloud=true,rows=[APPLE,GOJI],sameShop=false}={}){
  model.setCatalog(model.BASE_CATALOG);
  const values=new Map([[model.CART_KEY,JSON.stringify(rows)]]),calls=[],notices=[],localOrders=[];
  const ownership=new Map([['jingtai-apple',{id:SHOP_A,name:'景泰好物 <模拟> 店',preview:false}],['goji',{id:sameShop?SHOP_A:SHOP_B,name:sameShop?'景泰好物 <模拟> 店':'另一位采购者的模拟店',preview:false}]]);
  const directory={ready:true,error:''},inventory={batchId:'BATCH-SHOWN',batchCode:'已展示模拟批次',harvestDate:'2026-11-01'};
  let path='cart',failure='';
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const api={selection:{address:'gansu'},availability:()=>({available:true,message:'当前可售20份'}),inventoryFor:()=>inventory,
    shopForProduct:id=>copy(ownership.get(id)||null),getStorefrontState:()=>({...directory}),route:()=>[path],nav:value=>{path=value;},
    toast:value=>notices.push(value),render(){},updateTabs(){},title:()=>'',miniProduct:()=>'',productCard:()=>'',newId:()=> 'DEMO-LOCAL-SHOP',
    addOrder:order=>localOrders.push(order),createCloudOrder:async(...args)=>{calls.push(copy(args));if(failure)throw new Error(failure);return {id:'DEMO-CLOUD-SHOP'};}};
  const factory=load({...model,esc,icon,localStorage:storage,isCloudMode:()=>cloud,getCloudState:()=>({session:{user:{id:'buyer-test'}}}),imageFor:product=>product?.image,SPECIALTY_GUIDES:[],COLLECTIONS:[]});
  const experience=factory(api);
  return {experience,values,calls,notices,localOrders,ownership,directory,inventory,api,
    rows:()=>JSON.parse(values.get(model.CART_KEY)),setRows:next=>values.set(model.CART_KEY,JSON.stringify(next)),setFailure:value=>{failure=value;},
    path:()=>path,setPath:value=>{path=value;},click:action=>experience.handleClick(action,{disabled:false}),
    showCheckout:()=>{path='cart-checkout';return experience.routes['cart-checkout']();}};
}

test('cart renders real shop groups and links, escapes names, and blocks mixed checkout in controls and click handlers',async()=>{
  const h=harness(),html=h.experience.routes.cart();
  assert.equal((html.match(/class="cart-shop-group"/g)||[]).length,2);
  assert.match(html,new RegExp(`data-route="shop/${SHOP_A}"`));assert.match(html,new RegExp(`data-route="shop/${SHOP_B}"`));
  assert.match(html,/景泰好物 &lt;模拟&gt; 店/);assert.doesNotMatch(html,/景泰好物 <模拟> 店/);
  assert.equal((html.match(/data-action="x-select-shop"/g)||[]).length,2);
  assert.match(html,/不同采购者的好物需要分开结算/);assert.match(html,/data-action="x-cart-checkout" disabled/);
  await h.click({action:'x-cart-checkout'});assert.equal(h.path(),'cart');assert.match(h.notices.at(-1),/只选这家/);
  const checkout=h.showCheckout();assert.doesNotMatch(checkout,/data-action="x-cart-submit"/);assert.match(checkout,/返回购物车调整/);
  await h.click({action:'x-cart-submit'});assert.equal(h.calls.length,0);assert.deepEqual(h.rows(),[APPLE,GOJI]);
});

test('only select this shop keeps all cart rows and quantities while deselecting every other shop',async()=>{
  const family={...APPLE,variant:'family',quantity:3,selected:false},h=harness({rows:[APPLE,family,GOJI]});
  await h.click({action:'x-select-shop',shop:SHOP_A});
  assert.deepEqual(h.rows(),[APPLE,{...family,selected:true},{...GOJI,selected:false}]);
  assert.doesNotMatch(h.experience.routes.cart(),/data-action="x-cart-checkout" disabled/);
  await h.click({action:'x-cart-checkout'});assert.equal(h.path(),'cart-checkout');
  assert.match(h.showCheckout(),/景泰好物 &lt;模拟&gt; 店/);
  await h.click({action:'x-select-shop',shop:'shop-preview-dingbian'});assert.deepEqual(h.rows(),[APPLE,{...family,selected:true},{...GOJI,selected:false}]);
});

test('checkout submits the frozen shown items, prices and batch rather than a later cart selection or catalog change',async()=>{
  const h=harness({rows:[APPLE,{...GOJI,selected:false}]});h.showCheckout();
  h.setRows([{...APPLE,selected:false},{...GOJI,selected:true}]);
  h.inventory.batchId='BATCH-LATER';
  model.setCatalog(model.BASE_CATALOG.map(product=>product.id===APPLE.productId?{...product,variants:product.variants.map(variant=>({...variant,price:variant.price+700}))}:product));
  await h.click({action:'x-cart-submit'});
  assert.equal(h.calls.length,1);
  assert.deepEqual(h.calls[0][0],[{productId:APPLE.productId,variant:'small',quantity:1}]);
  assert.equal(h.calls[0][2],5590);assert.equal(h.calls[0][3]['jingtai-apple::small'],4990);assert.equal(h.calls[0][4]['jingtai-apple'],'BATCH-SHOWN');
  assert.deepEqual(h.rows(),[{...GOJI,selected:true}]);assert.equal(h.path(),'order/DEMO-CLOUD-SHOP');assert.equal(h.localOrders.length,0);
});

test('cloud directory loading, failure, missing and preview ownership all fail closed without a fake local shop',async()=>{
  for(const mode of ['loading','failure','missing','preview']){
    const h=harness({rows:[APPLE]});h.showCheckout();
    if(mode==='loading')h.directory.ready=false;
    if(mode==='failure')h.directory.error='网络故障';
    if(mode==='missing')h.ownership.delete(APPLE.productId);
    if(mode==='preview')h.ownership.set(APPLE.productId,{id:'shop-preview-dingbian',name:'筹备示意',preview:true});
    const html=h.experience.routes.cart();assert.match(html,/data-action="x-cart-checkout" disabled/);
    if(mode==='missing'||mode==='preview')assert.match(html,/店铺资料暂缺/);
    assert.doesNotMatch(html,/陇上鲜集 · 演示店铺/);
    await h.click({action:'x-cart-submit'});assert.equal(h.calls.length,0);assert.deepEqual(h.rows(),[APPLE]);
    h.setPath('cart');await h.click({action:'x-cart-checkout'});assert.equal(h.path(),'cart');
    assert.doesNotMatch(h.showCheckout(),/data-action="x-cart-submit"/);
  }
});

test('frozen multi-product quotes are rechecked after ownership changes, including whole-quote reassignment',async()=>{
  for(const changeAll of [false,true]){
    const h=harness({sameShop:true});h.showCheckout();
    h.ownership.set('goji',{id:SHOP_B,name:'改变后的店铺',preview:false});
    if(changeAll)h.ownership.set('jingtai-apple',{id:SHOP_B,name:'改变后的店铺',preview:false});
    await h.click({action:'x-cart-submit'});
    assert.equal(h.calls.length,0);assert.deepEqual(h.rows(),[APPLE,GOJI]);
    assert.match(h.notices.at(-1),changeAll?/店铺已变化/:/分开结算/);
  }
});

test('uncertain cloud submissions retain cart rows and retry the same frozen arguments before removing only purchased quantities',async()=>{
  const h=harness({rows:[APPLE,{...GOJI,selected:false}]});h.showCheckout();h.setFailure('上次下单结果尚未确认');
  await h.click({action:'x-cart-submit'});assert.deepEqual(h.rows(),[APPLE,{...GOJI,selected:false}]);assert.equal(h.localOrders.length,0);
  h.setRows([{...APPLE,quantity:3},{...GOJI,selected:false}]);h.setFailure('');
  await h.click({action:'x-cart-submit'});
  assert.deepEqual(h.calls[1],h.calls[0]);assert.deepEqual(h.rows(),[{...APPLE,quantity:2},{...GOJI,selected:false}]);
});

test('local simulated directory uses the same shop controls and keeps its local order flow',async()=>{
  const h=harness({cloud:false,sameShop:true,rows:[APPLE,{...GOJI,selected:false}]});
  assert.match(h.experience.routes.cart(),new RegExp(`data-route="shop/${SHOP_A}"`));
  await h.click({action:'x-cart-checkout'});assert.equal(h.path(),'cart-checkout');h.showCheckout();await h.click({action:'x-cart-submit'});
  assert.equal(h.localOrders.length,1);assert.equal(h.calls.length,0);assert.deepEqual(h.rows(),[{...GOJI,selected:false}]);assert.equal(h.path(),'order/DEMO-LOCAL-SHOP');
});
