import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),model=require('../miniprogram/services/generated/model.js');
const editor=require('../miniprogram/pages/manage-product/product-form.js');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const event=dataset=>({currentTarget:{dataset}}),input=(field,value)=>({...event({field}),detail:{value}});
function fixture(){
 const state={role:'merchant',permissions:['products'],userId:'merchant-a',products:[{...clone(model.BASE_CATALOG[0]),version:4,status:'draft'}],writes:[],routes:[],modals:[],sessionReads:0,privateReads:0,conflict:false,confirm:true};
 const session=()=>({user:{id:state.userId},role:state.role,permissions:state.permissions,canManage:state.role==='admin'||state.permissions.length>0});
 const stock={productId:'jingtai-apple',version:2,stocks:{small:7,family:3},batchCode:'DEMO-EDITOR',harvestDate:'',note:''};
 const market={mode:'cloud',newRequestKey:()=> 'REQUEST-0123456789abcdef',assetUrl:path=>'/'+path,imageFor:product=>product.imageMediaId?'https://media.example.test/image':'/'+product.image,videoFor:product=>product.videoMediaId?'https://media.example.test/video':'',
  getSession:async()=>{state.sessionReads++;return session();},getManagementProducts:async()=>({products:clone(state.products)}),getManagementInventory:async()=>({inventories:[clone(stock)]}),
  getManagementProduct:async id=>{state.privateReads++;return {product:clone(state.products.find(row=>row.id===id))};},
  saveManagementProduct:async(product,version,actorId)=>{if(state.conflict)throw Error('商品已更新，请重新读取后核对。');assert.equal(actorId,state.userId);state.writes.push(clone(product));state.products=[{...clone(product),version:version+1}];return {product:state.products[0]};},
  saveManagementInventory:async(id,body)=>{state.stockWrite=clone(body);return {inventory:{...stock,...clone(body),version:body.expectedVersion+1}};}};
 const wx={showModal:options=>{state.modals.push(options);options.success({confirm:state.confirm});},showToast(){},stopPullDownRefresh(){},navigateTo:options=>state.routes.push(options.url),switchTab:options=>state.routes.push(options.url),redirectTo:options=>state.routes.push(options.url),hideShareMenu:options=>{state.hiddenMenus=options.menus;},previewImage:options=>{state.imagePreview=options;}};
 const modules=new Map();let definition;
 function load(path){path=resolve(path);if(!path.endsWith('.js'))path+='.js';if(path===resolve('miniprogram/services/market.js'))return {getMarket:()=>market};if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);vm.runInContext(readFileSync(path,'utf8'),vm.createContext({wx,module,exports:module.exports,Page:spec=>{definition=spec;},require:name=>load(resolve(dirname(path),name))}),{filename:path});return module.exports;}
 async function open(name='manage-product',query={id:'jingtai-apple'}){const file=resolve('miniprogram/pages',name,'index.js');modules.delete(file);load(file);const page={...definition,data:clone(definition.data),setData(patch){Object.assign(this.data,clone(patch));}};page.onLoad(query);await page.onShow();return page;}
 return {state,market,wx,open};
}
const row=(page,kind,index,key,value)=>page.rowField({...event({kind,index,key}),detail:{value}});

test('complete native editor saves detailed presentation and exactly two stable SKU ids',async()=>{
 const r=fixture(),page=await r.open();
 for(const [key,value] of Object.entries({name:'景泰苹果·模拟',origin:'甘肃景泰 · 模拟果园',subtitle:'清脆果香的模拟介绍',tagsText:'景泰好物，模拟特产,田间展示',storage:'阴凉处存放，模拟说明',sizeNote:'大小存在自然差异，模拟资料',smallLabel:'日常尝鲜',smallWeight:'净重2.5kg（模拟）',smallHint:'适合两人体验',smallPrice:'29.90',familyLabel:'分享装',familyWeight:'净重5kg（模拟）',familyHint:'适合全家分享',familyPrice:'49.80'}))page.field(input(key,value));
 page.category({detail:{value:'0'}});row(page,'facts',0,'label','果径（模拟）');row(page,'facts',0,'value','70–80mm');
 page.addRow(event({kind:'harvestSteps'}));const index=page.data.harvestSteps.length-1;row(page,'harvestSteps',index,'title','装箱演示');row(page,'harvestSteps',index,'text','使用模拟包装说明。');
 await page.saveProduct();assert.equal(page.data.error,'');const saved=r.state.writes[0];
 assert.equal(saved.subtitle,'清脆果香的模拟介绍');assert.deepEqual(saved.tags,['景泰好物','模拟特产','田间展示']);assert.equal(saved.storage,'阴凉处存放，模拟说明');assert.equal(saved.sizeNote,'大小存在自然差异，模拟资料');assert.deepEqual(saved.facts[0],['果径（模拟）','70–80mm']);assert.equal(saved.harvestSteps.at(-1).title,'装箱演示');
 assert.deepEqual(saved.variants.map(v=>v.id),['small','family']);assert.deepEqual(saved.variants[0],{id:'small',label:'日常尝鲜',weight:'净重2.5kg（模拟）',hint:'适合两人体验',price:2990});assert.equal(saved.variants[1].price,4980);assert.equal(saved.status,'draft');
});

test('new draft retains every template detail and cannot publish until a subsequent save',async()=>{
 const r=fixture(),page=await r.open('manage-product',{});await page.template(event({id:'pear'}));
 const template=clone(model.BASE_CATALOG.find(row=>row.id==='pear'));assert.equal(page.data.subtitle,template.subtitle);assert.deepEqual(page.data.facts.map(row=>[row.label,row.value]),template.facts);
 await page.saveProduct();const saved=r.state.writes[0];assert.equal(saved.status,'draft');assert.deepEqual(saved.harvestSteps,template.harvestSteps);assert.deepEqual(saved.variants,template.variants);assert.equal(saved.storage,template.storage);assert.equal(saved.sizeNote,template.sizeNote);assert.deepEqual(saved.tags,template.tags);
});

test('rows add and delete without hidden data, while invalid fields prevent any write and preserve the form',async()=>{
 const r=fixture(),page=await r.open(),original=page.data.facts.length;
 page.addRow(event({kind:'facts'}));row(page,'facts',original,'label','模拟新增资料');await page.saveProduct();assert.match(page.data.error,/填写完整/);assert.equal(r.state.writes.length,0);assert.equal(page.data.facts[original].label,'模拟新增资料');
 page.removeRow(event({kind:'facts',index:original}));page.field(input('smallPrice','10000'));await page.saveProduct();assert.match(page.data.error,/9999.99/);assert.equal(page.data.smallPrice,'10000');assert.equal(r.state.writes.length,0);
 page.field(input('smallPrice','25'));page.field(input('familyWeight',''));await page.saveProduct();assert.match(page.data.error,/净重/);assert.equal(r.state.writes.length,0);assert.equal(page.data.familyWeight,'');
 page.field(input('familyWeight','5kg'));page.field(input('tagsText',Array.from({length:13},(_,i)=>'标签'+i).join(',')));await page.saveProduct();assert.match(page.data.error,/标签/);assert.equal(r.state.writes.length,0);
});

test('version conflict keeps all edits and previews only the saved version after explicit notice',async()=>{
 const r=fixture(),page=await r.open();page.field(input('subtitle','未保存的新简述'));page.field(input('smallPrice','18.80'));row(page,'harvestSteps',0,'text','未保存的新采摘说明');r.state.conflict=true;await page.saveProduct();
 assert.match(page.data.error,/已更新/);assert.equal(page.data.subtitle,'未保存的新简述');assert.equal(page.data.smallPrice,'18.80');assert.equal(page.data.harvestSteps[0].text,'未保存的新采摘说明');assert.equal(page.data.product.version,4);
 r.state.confirm=false;await page.previewSaved();assert.equal(r.state.routes.length,0);r.state.confirm=true;await page.previewSaved();assert.match(r.state.modals.at(-1).content,/上一次保存/);assert.equal(r.state.routes.at(-1),'/pages/product-preview/index?id=jingtai-apple');assert.equal(r.state.writes.length,0);assert.equal(page.data.smallPrice,'18.80');
});

test('independent product and stock saves retain the other unfinished form',async()=>{
 const r=fixture(),page=await r.open();page.field(input('smallStock','19'));page.field(input('reason','模拟备货核对'));page.field(input('subtitle','商品资料新简述'));r.market.getManagementInventory=async()=>({inventories:[{...clone(page.data.inventory),productId:'jingtai-apple',version:9}]});await page.saveProduct();assert.equal(page.data.smallStock,'19');assert.equal(page.data.reason,'模拟备货核对');assert.equal(page._stockDirty,true);assert.equal(page.data.inventory.version,2);
 page.field(input('smallPrice','19.90'));await page.saveStock();assert.equal(page.data.smallPrice,'19.90');assert.equal(page.data.hasProductChanges,true);assert.equal(page._stockDirty,false);assert.equal(page._dirty,true);assert.equal(r.state.stockWrite.expectedVersion,2);
 await page.records(event({kind:'product'}));await page.records(event({kind:'inventory'}));assert.deepEqual(r.state.routes,['/pages/records/index?kind=product&id=jingtai-apple','/pages/records/index?kind=inventory&id=jingtai-apple']);
});

test('saved merchant preview reads private draft/media without shopping writes or purchase controls',async()=>{
 const r=fixture();r.state.products[0].videoMediaId='DEMO-VIDEO';const page=await r.open('product-preview');
 assert.equal(page.data.allowed,true);assert.equal(page.data.product.status,'draft');assert.equal(page.data.product.version,4);assert.equal(page.data.video,'https://media.example.test/video');assert.equal(page.data.statusText,'草稿 · 尚未上架');assert.equal(r.state.privateReads,1);assert.ok(r.state.sessionReads>=2);assert.equal(r.state.writes.length,0);
 assert.deepEqual(clone(page.onShareAppMessage()),{title:'家乡好物 · 模拟体验',path:'/pages/mine/index'});assert.deepEqual(clone(r.state.hiddenMenus),['shareAppMessage','shareTimeline']);page.backToEdit();assert.equal(r.state.routes.at(-1),'/pages/manage-product/index?id=jingtai-apple');
 const source=readFileSync(resolve('miniprogram/pages/product-preview/index.js'),'utf8'),markup=readFileSync(resolve('miniprogram/pages/product-preview/index.wxml'),'utf8');assert.doesNotMatch(source,/getCatalog\(|getShopping\(|updateShopping\(/);assert.doesNotMatch(markup,/bindtap="(?:addCart|favorite|buy)"/);assert.match(markup,/已保存版本/);
});

test('preview denies buyers, unrelated permissions, mock mode and malformed ids before private reads',async()=>{
 for(const change of [r=>{r.state.role='buyer';r.state.permissions=[];},r=>{r.state.permissions=['aftersales'];},r=>{r.market.mode='mock';},r=>{r.state.userId='';}]){const r=fixture();change(r);const page=await r.open('product-preview');assert.equal(page.data.allowed,false);assert.equal(r.state.privateReads,0);assert.equal(page.data.product,null);}
 const r=fixture(),page=await r.open('product-preview',{id:'../../other'});assert.match(page.data.error,/编号无效/);assert.equal(r.state.privateReads,0);page.backToEdit();assert.equal(r.state.routes.at(-1),'/pages/workbench/index');
});

test('preview never displays a response after account changes or permission revocation during read',async()=>{
 for(const change of [r=>{r.state.userId='merchant-b';},r=>{r.state.permissions=[];}]){const r=fixture();r.market.getManagementProduct=async()=>{change(r);return {product:clone(r.state.products[0])};};const page=await r.open('product-preview');assert.equal(page.data.allowed,false);assert.equal(page.data.product,null);}
});

test('form normalization rejects excessive facts and leaves two fixed variants',()=>{
 const product={...clone(model.BASE_CATALOG[0]),version:1},form={...editor.toForm(product),smallPrice:'29.90',familyPrice:'49.90',published:true};form.facts=Array.from({length:21},(_,i)=>({label:'资料'+i,value:'模拟'}));assert.throws(()=>editor.toProduct(product,form),/资料格式/);
});
