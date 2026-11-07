const categories = [
  {id:'all',label:'全部'}, {id:'fruit',label:'鲜果'},
  {id:'dried',label:'干货'}, {id:'vegetable',label:'蔬菜'}
];
function select(products, state) {
  const terms = String(state.appliedKeyword || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (products || []).filter(product => {
    if (state.category !== 'all' && product.category !== state.category) return false;
    if (state.inStock && !(product.stock?.stocks?.small > 0 || product.stock?.stocks?.family > 0)) return false;
    const words = [product.name, product.origin, product.summary, product.subtitle, ...(product.tags || [])].join(' ').toLowerCase();
    return terms.every(term => words.includes(term));
  });
}
function view(allProducts, state) {
  const products = select(allProducts, state);
  return {products, count:allProducts.length, matchedCount:products.length,
    filtered:!!state.appliedKeyword || state.category !== 'all' || !!state.inStock};
}
module.exports = {categories, select, view};
