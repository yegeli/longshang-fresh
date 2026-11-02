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
  getDatabase: () => cloud.database({ throwOnNotFound: false })
});
exports.main = async event => provision(event);
