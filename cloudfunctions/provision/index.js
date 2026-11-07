'use strict';
const cloud = require('wx-server-sdk');
const { runtimeConfig } = require('./lib/config');
const { createProvision } = require('./lib/provision');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false });
// SDK authentication stays inside the official manager. No application code
// reads, stores or logs its temporary runtime credentials.
const provision = createProvision({
  getContext: () => cloud.getWXContext(),
  getConfig: () => runtimeConfig(),
  createManager: envId => {
    const CloudBase = require('@cloudbase/manager-node');
    return new CloudBase({ envId });
  },
  getDatabase: () => cloud.database({ throwOnNotFound: false }),
  getStorage: () => cloud
});
exports.main = async event => {
  // wx.cloud.callFunction adds userInfo/tcbContext to the event. Ignore these
  // transport fields; only getWXContext() above supplies trusted identity.
  // Keep every other field for the strict application request validator.
  if (event && typeof event === 'object' && !Array.isArray(event) && Object.getPrototypeOf(event) === Object.prototype && (Object.prototype.hasOwnProperty.call(event, 'userInfo') || Object.prototype.hasOwnProperty.call(event, 'tcbContext'))) {
    const request = {...event};
    delete request.userInfo;
    delete request.tcbContext;
    return provision(request);
  }
  return provision(event);
};
