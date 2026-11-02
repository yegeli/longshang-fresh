const { market, page, money, image, confirm, toast } = require('../_shared');
function keys(id) {
  const namespace = market.storageNamespace || market.mode;
  return { pending: 'longshang-mini-pending:' + namespace + ':' + id, cleanup: 'longshang-mini-cleanup:' + namespace + ':' + id };
}
function viewQuote(quote) {
  return { ...quote, subtotalText: money(quote.subtotal), shippingText: money(quote.shipping), totalText: money(quote.total),
    lines: quote.items.map((line, index) => ({ ...line, key: line.productId + '-' + line.variant + '-' + index, image: market.imageFor(line), priceText: money(line.unitPrice) })) };
}
page({
  data: { addressIndex: 0, hasPending: false },
  async load() {
    const session = await market.getSession();
    if (!session.user) throw Error('请先到“我的”使用微信登录，再提交模拟订单。');
    this._account = session.user.id;
    this._keys = keys(this._account);
    const current = await market.getShopping();
    const addresses = market.getAddresses().filter(address => address.shipping !== null);
    const saved = wx.getStorageSync(this._keys.pending);
    if (saved && saved.accountId === this._account && saved.payload && saved.quote) {
      this._pending = saved;
      return { shopping: current, addresses, addressIndex: addresses.findIndex(address => address.id === saved.payload.address), quote: viewQuote(saved.quote), hasPending: true };
    }
    this._pending = null;
    const items = current.state.cart.filter(row => row.selected).map(({ productId, variant, quantity }) => ({ productId, variant, quantity }));
    if (!items.length) throw Error('请先从购物车选择商品。');
    const preferred = addresses.findIndex(address => address.id === current.state.preferredAddress);
    const addressIndex = this._chosenAddress === undefined ? Math.max(0, preferred) : this._chosenAddress;
    const { quote } = await market.quote(items, addresses[addressIndex].id);
    this._selection = items;
    return { shopping: current, addresses, addressIndex, quote: viewQuote(quote), hasPending: false };
  },
  address(event) {
    if (this.data.hasPending || this.data.processing) return;
    this._chosenAddress = Number(event.detail.value);
    return this.refresh();
  },
  submit() {
    return this.act(async () => {
      if (!await confirm('生成模拟订单', '商品和运费均为模拟，不会扣款或真实发货。确认提交？')) return null;
      const accountId = this._account, accountKeys = { ...this._keys };
      const session = await market.getSession();
      if (!session.user || session.user.id !== accountId) throw Error('登录账号已变化，请重新进入结算页。');
      let pending = this._pending;
      if (!pending) {
        const quote = this.data.quote;
        const payload = { items: this._selection, address: this.data.addresses[this.data.addressIndex].id,
          expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: market.newRequestKey() };
        pending = { accountId, payload, quote };
        // Persist before keeping the in-memory marker or sending the write.
        wx.setStorageSync(accountKeys.pending, pending);
        this._pending = pending;
      }
      const { order } = await market.createOrder(pending.payload);
      try { wx.setStorageSync(accountKeys.pending, { ...pending, confirmedOrderId: order.id }); } catch { /* keep the original retry request */ }
      // The order is now confirmed. Every subsequent read/cleanup failure must
      // preserve that success and the original account's recovery information.
      try {
        const currentSession = await market.getSession();
        if (currentSession.user?.id !== accountId) return { accountChanged: true };
        let markers = wx.getStorageSync(accountKeys.cleanup);
        markers = Array.isArray(markers) ? markers : [];
        markers = [...new Set([...markers, order.id])].slice(-50);
        wx.setStorageSync(accountKeys.cleanup, markers);
        let cartPending = false;
        try {
          const shopping = await market.getShopping();
          await market.consumeOrder(order.id, shopping.version);
          wx.setStorageSync(accountKeys.cleanup, markers.filter(id => id !== order.id));
        } catch { cartPending = true; }
        try { wx.removeStorageSync(accountKeys.pending); if (this._account === accountId) this._pending = null; } catch { /* original request remains recoverable */ }
        return { order, cartPending };
      } catch {
        return { order, cartPending: true, keepPending: true };
      }
    }, result => {
      if (!result) return;
      if (result.accountChanged) { toast('订单已生成，请切回原账号查看'); wx.switchTab({ url: '/pages/mine/index' }); return; }
      if (result.cartPending) toast('订单已生成，购物车清理待核对');
      wx.redirectTo({ url: '/pages/order/index?id=' + encodeURIComponent(result.order.id) + (result.cartPending ? '&cartPending=1' : '') });
    });
  }
});
