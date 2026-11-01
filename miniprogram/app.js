const { getMarket } = require('./services/market');

App({
  globalData: { name: '陇上鲜集', simulation: true },
  onLaunch() {
    // Login remains an explicit action on the account page. Mock data stays
    // local and is never promoted into a real account when configuration changes.
    this.market = getMarket();
    this.globalData.mode = this.market.mode;
  },
  onError() {
    // Do not persist raw error stacks: they could contain session or order data.
    this.globalData.lastError = '页面操作未完成，请返回重试。';
  }
});
