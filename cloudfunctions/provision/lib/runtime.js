'use strict';
// Match the public Manager SDK's GetFunction / UpdateFunctionConfiguration
// requests, without its SCF-specific automatic CLS configuration fields.
const TARGETS = Object.freeze({
  'runtime-inspect': {name: 'longshang-market', timeout: 30, inspect: true},
  'runtime-configure': {name: 'longshang-market', timeout: 30, inspect: false},
  'provision-runtime-inspect': {name: 'longshang-provision', timeout: 15, inspect: true},
  'provision-runtime-configure': {name: 'longshang-provision', timeout: 15, inspect: false}
});
async function functionRuntime({operation, apply, envId, createManager, step, reject}) {
  const target = TARGETS[operation];
  if (!target) reject(400, 'invalid_request', '不支持该运行配置操作。');
  const service = createManager(envId).commonService('tcb', '2018-06-08');
  const call = (Action, extra = {}) => step(Action, undefined, () => service.call({
    Action, Param: {EnvId: envId, FunctionName: target.name, ...extra}
  }));
  const info = await call('GetFunction');
  if (!info || info.FunctionName !== target.name || !Number.isInteger(info.Timeout) || info.Timeout < 1 || info.Timeout > 900)
    reject(409, 'function_configuration_unknown', '目标函数配置无法确认；未修改运行配置。');
  // Never return code, environment variables, roles, URLs or provider details.
  const runtime = {functionName: target.name, timeoutSeconds: info.Timeout, targetTimeoutSeconds: target.timeout, active: info.Status === 'Active'};
  if (target.inspect || apply !== true)
    return {status: 200, body: {runtime, dryRun: true, configured: info.Timeout === target.timeout && runtime.active, verificationSnapshot: true}};
  if (info.Status !== 'Active')
    reject(409, 'function_not_active', '目标函数仍在创建或更新；请稍后只读核对，不重复提交配置。');
  if (info.Timeout === target.timeout)
    return {status: 200, body: {runtime, dryRun: false, configured: true, verificationSnapshot: true}};
  await call('UpdateFunctionConfiguration', {Timeout: target.timeout});
  // Configuration updates may be asynchronous; a separate inspect must read
  // back the target value before anyone can report successful verification.
  return {status: 200, body: {runtime, dryRun: false, configured: false, needsVerification: true, verificationSnapshot: false}};
}
module.exports = {functionRuntime};
