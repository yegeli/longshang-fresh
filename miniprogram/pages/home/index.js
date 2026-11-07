const {market,page,productView}=require('../_shared');
const filter=require('../../services/catalog-filter');
page({
  data:{keyword:'',appliedKeyword:'',category:'all',inStock:false,categories:filter.categories,allProducts:[],products:[]},
  async load(){
    const [catalog,stock]=await Promise.all([market.getCatalog(),market.getInventory()]);
    const allProducts=catalog.products.map(p=>productView(p,stock.inventories));
    return {allProducts,...filter.view(allProducts,this.data)};
  },
  applyFilters(){this.setData(filter.view(this.data.allProducts,this.data));},
  input(e){this.setData({keyword:e.detail.value});},
  search(){this.setData({appliedKeyword:this.data.keyword.trim()});this.applyFilters();},
  chooseCategory(e){const category=e.currentTarget.dataset.id;if(filter.categories.some(row=>row.id===category)){this.setData({category});this.applyFilters();}},
  toggleStock(e){this.setData({inStock:!!e.detail.value});this.applyFilters();},
  all(){this.setData({keyword:'',appliedKeyword:'',category:'all',inStock:false});this.applyFilters();},
  onShareAppMessage(){return {title:'从甘肃景泰，发现家乡好物',path:'/pages/home/index'};}
});
