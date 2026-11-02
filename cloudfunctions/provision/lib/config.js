'use strict';
const fs = require('node:fs');
const path = require('node:path');
const KEYS = ['WECHAT_APP_ID', 'CLOUDBASE_ENV_ID', 'PROVISION_OPERATOR_ACCOUNT_ID'];
function runtimeConfig(environment = process.env, filename = path.join(__dirname, '..', 'runtime.config.json')) {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_config'); }
  if (!local || typeof local !== 'object' || Array.isArray(local) || Object.keys(local).some(k => !KEYS.includes(k))) throw new Error('invalid_config');
  const result = {};
  for (const name of KEYS) {
    const configured = local[name], override = environment[name];
    if (configured !== undefined && typeof configured !== 'string' || override !== undefined && typeof override !== 'string') throw new Error('invalid_config');
    if (configured && override && configured !== override) throw new Error('invalid_config');
    if (override || configured) result[name] = override || configured;
  }
  if (!/^wx[a-f0-9]{16}$/.test(result.WECHAT_APP_ID || '') || !/^[A-Za-z0-9][A-Za-z0-9-]{1,100}$/.test(result.CLOUDBASE_ENV_ID || '') || result.PROVISION_OPERATOR_ACCOUNT_ID && !/^wechat:[a-f0-9]{64}$/.test(result.PROVISION_OPERATOR_ACCOUNT_ID)) throw new Error('invalid_config');
  return result;
}
module.exports = { runtimeConfig };
