const model=require('../../services/generated/model');
const categories=[{id:'fruit',name:'水果'},{id:'dried',name:'干货特产'},{id:'vegetable',name:'蔬菜粮食'}];
const fields=['name','origin','subtitle','summary','storage','sizeNote','tagsText','smallPrice','familyPrice','smallLabel','familyLabel','smallWeight','familyWeight','smallHint','familyHint','videoTitle','videoNote'];
const stockFields=['smallStock','familyStock','batchCode','harvestDate','note','reason'];
const text=value=>typeof value==='string'?value.trim():'';
function toForm(product){
 const variants=Object.fromEntries(product.variants.map(row=>[row.id,row]));
 return {categories,category:product.category,categoryIndex:categories.findIndex(row=>row.id===product.category),
  ...Object.fromEntries(['name','origin','subtitle','summary','storage','sizeNote','videoTitle','videoNote'].map(key=>[key,product[key]||''])),
  tagsText:(product.tags||[]).join('，'),facts:(product.facts||[]).map(([label,value],index)=>({rowKey:'fact-'+index,label,value})),
  harvestSteps:(product.harvestSteps||[]).map((row,index)=>({...row,rowKey:'step-'+index})),
  ...Object.fromEntries(['small','family'].flatMap(id=>[['Label','label'],['Weight','weight'],['Hint','hint']].map(([field,key])=>[id+field,variants[id][key]||'']))) };
}
function price(value){
 if(typeof value!=='string'||!/^\d{1,7}(?:\.\d{1,2})?$/.test(value.trim()))throw Error('价格请填写正数，最多两位小数。');
 const cents=Math.round(Number(value)*100);if(!Number.isSafeInteger(cents)||cents<1||cents>999999)throw Error('模拟价格须为0.01至9999.99元。');return cents;
}
function rows(values,left,right,label){
 return values.filter(row=>text(row[left])||text(row[right])).map(row=>{
  if(!text(row[left])||!text(row[right]))throw Error(label+'的名称和内容请填写完整，或删除空行。');
  return {[left]:text(row[left]),[right]:text(row[right])};
 });
}
function toProduct(source,form){
 if(!source)throw Error('请先重新读取商品。');
 const facts=rows(form.facts,'label','value','商品资料'),harvestSteps=rows(form.harvestSteps,'title','text','采收步骤');
 const input={...source,category:form.category,status:source.version===0?'draft':form.published?'published':source.status==='draft'?'draft':'offline',
  ...Object.fromEntries(['name','origin','subtitle','summary','storage','sizeNote','videoTitle','videoNote'].map(key=>[key,text(form[key])])),
  tags:text(form.tagsText).split(/[,，\n]+/).map(text).filter(Boolean),facts:facts.map(row=>[row.label,row.value]),harvestSteps,
  variants:['small','family'].map(id=>({id,label:text(form[id+'Label']),weight:text(form[id+'Weight']),hint:text(form[id+'Hint']),price:price(form[id+'Price'])}))};
 if(!input.name||!input.origin||!input.summary)throw Error('请填写商品名称、产地与介绍。');
 const normalized=model.normalizeCatalogProduct(input);
 return {...normalized,...Object.fromEntries(['imageMediaId','videoMediaId'].filter(key=>source[key]==='').map(key=>[key,''])),version:source.version};
}
module.exports={categories,fields,stockFields,toForm,toProduct};
