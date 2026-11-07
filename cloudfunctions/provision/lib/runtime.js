'use strict';
// Match the public Manager SDK's GetFunction / UpdateFunctionConfiguration
// requests, without its SCF-specific automatic CLS configuration fields.
const FUNCTION_NAME = 'longshang-market';
const TIMEOUT_SECONDS = 30;
async function marketRuntime({operation, apply, envId, createManager, step, reject}) {
  const service = createManager(envId).commonService('tcb', '2018-06-08');
  const call = (Action, extra = {}) => step(Action, undefined, () => service.call({
    Action, Param: {EnvId: envId, FunctionName: FUNCTION_NAME, ...extra}
  }));
  const info = await call('GetFunction');
  if (!info || info.FunctionName !== FUNCTION_NAME || !Number.isInteger(info.Timeout) || info.Timeout < 1 || info.Timeout > 900)
    reject(409, 'function_configuration_unknown', '商城函数配置无法确认；未修改运行配置。');
  // Never return code, environment variables, roles, URLs or provider details.
  const runtime = {functionName: FUNCTION_NAME, timeoutSeconds: info.Timeout, targetTimeoutSeconds: TIMEOUT_SECONDS, active: info.Status === 'Active'};
  if (operation === 'runtime-inspect' || apply !== true)
    return {status: 200, body: {runtime, dryRun: true, configured: info.Timeout === TIMEOUT_SECONDS && runtime.active, verificationSnapshot: true}};
  if (info.Status !== 'Active')
    reject(409, 'function_not_active', '商城函数仍在创建或更新；请稍后只读核对，不重复提交配置。');
  if (info.Timeout === TIMEOUT_SECONDS)
    return {status: 200, body: {runtime, dryRun: false, configured: true, verificationSnapshot: true}};
  await call('UpdateFunctionConfiguration', {Timeout: TIMEOUT_SECONDS});
  // Configuration updates may be asynchronous; a separate inspect must read
  // back the target value before anyone can report successful verification.
  return {status: 200, body: {runtime, dryRun: false, configured: false, needsVerification: true, verificationSnapshot: false}};
}
module.exports = {marketRuntime};
