const {market,page,productView}=require('../_shared');
const filter=require('../../services/catalog-filter');
page({
  data:{inStock:false,keyword:'',appliedKeyword:'',category:'all',categories:filter.categories,allProducts:[],products:[]},
  async load(){
    const [directory,catalog,stock]=await Promise.all([market.getStorefront(),market.getCatalog(),market.getInventory()]);
    const shop=directory.shops.find(s=>s.id===this._query.id);if(!shop)throw Error('这个店铺暂时不存在。');
    const allProducts=catalog.products.filter(p=>shop.productIds.includes(p.id)).map(p=>productView(p,stock.inventories));
    return {shop,allProducts,...filter.view(allProducts,this.data)};
  },
  applyFilters(){this.setData(filter.view(this.data.allProducts,this.data));},
  input(e){this.setData({keyword:e.detail.value});},
  search(){this.setData({appliedKeyword:this.data.keyword.trim()});this.applyFilters();},
  chooseCategory(e){const category=e.currentTarget.dataset.id;if(filter.categories.some(row=>row.id===category)){this.setData({category});this.applyFilters();}},
  toggleStock(e){this.setData({inStock:!!e.detail.value});this.applyFilters();},
  all(){this.setData({keyword:'',appliedKeyword:'',category:'all',inStock:false});this.applyFilters();}
});
