# 受控 CloudBase 分步初始化

`provision` 是独立事件云函数，准备清单中的13个 `lsf_` 集合、客户端隔离、查询索引及就绪标记，另提供固定商城函数30秒和本初始化函数15秒的限时配置。不创建账号、不分配角色、不初始化商品、不接支付；不修改其他项目的函数。代码和本机测试不代表云端执行角色已有管理权限。

## 配置和调用

1. 本机私有部署包的 `runtime.config.json` 先只配置 `WECHAT_APP_ID`、`CLOUDBASE_ENV_ID`，参考 example。环境编号必须与官方 SDK 可信 `WXContext.ENV` 一致。
2. 本人微信调用 `{operation:'identity'}`。它仅返回可信 `accountId`，不创建 Manager SDK、不查询或修改数据库。客户端不能提供 openid、账号、角色或环境。
3. 部署者核对本人编号后，服务端显式配置 `PROVISION_OPERATOR_ACCOUNT_ID` 并重新部署。没有此配置时仅 identity 可用，不自动认领首位访问者。真实编号与配置不进公开 Git。
4. 空对象、`{operation:'inspect'}`、未带 apply 的 provision 都只读；inspect 返回服务端进度与上次验证快照，不遍历全部云资源、不写 checkpoint。
5. 连续调用精确的 `{operation:'provision',apply:true}`。每次由服务端选择一个固定动作，最多两个控制面请求；客户端不能传集合或阶段。未完成返回 `{status:200,body:{ready:false,needsRetry:true,progress:{phase,collection,action,version}}}`。收到 ready:true 才停止成功续做。非200按 error 检查；租约占用或调用被平台超时截断时，等待至少六秒后重试相同事件。

## 固定函数执行限时

旧微信CLI创建函数的实际默认限时为3秒，首次商品初始化等事务仍需真实云验证。相同的可信应用、环境和已配置操作者可以调用 `{operation:'runtime-inspect'}` 只读核对固定的 `longshang-market`，然后显式调用 `{operation:'runtime-configure',apply:true}` 把执行限时设为固定30秒。省略apply或传false只读；客户端不能指定函数名、数值、环境、内存、角色或环境变量。此路径不访问商城集合，可以在集合初始化之前使用。

若初始化本身被平台3秒截断，可先调用 `{operation:'provision-runtime-inspect'}`，再显式调用 `{operation:'provision-runtime-configure',apply:true}` 将固定的 `longshang-provision` 改为15秒，并再次只读核对Active和目标值。两个独立操作对应两个固定目标；不能通过事件指定其他函数或把15秒操作用于商城。自配置不修改集合、checkpoint、ready、租约或初始化预算；若调用结果丢失，先inspect核对，不重复创建集合。

配置操作先读 `GetFunction`，只有函数为Active且当前限时不同才发送 `UpdateFunctionConfiguration`；每调用最多两个控制面请求。写入只包含EnvId、固定FunctionName和对应Timeout（商城30或初始化15），不修改内存、角色、环境变量、日志配置、代码或套餐。底层使用官方Manager SDK的公共服务调用，与其函数API使用同一tcb服务／版本；避开高阶SDK在旧SCF上的自动CLS字段注入。

写入响应仅表示已提交，返回 `configured:false,needsVerification:true`。之后再次调用对应inspect操作，只有回读目标限时且状态Active才返回configured:true；不能把提交成功当成生效。函数仍在更新时不重复提交。读取和错误返回只含白名单摘要，不返回原始函数详情、代码、角色、环境变量或SDK错误文本。权限不足时停止，不授予额外IAM权限。运行限时配置也不等于业务流程已经验证。

首次只原子创建 META，并在后续调用核验 ADMINONLY 后才存 checkpoint。每次调用先重新查询 META 的微信安全规则；初始化和最终复核还分别记录 `DescribeDatabaseACL`、带 `WxAppId` 的 `DescribeSafeRule`。集合通过官方 `CreateTable` 的 `PermissionInfo:{EnvId,AclTag:'ADMINONLY'}` 原子锁定，不依赖未声明的默认权限。Tag 是官方可选字段；实现仅使用可信绑定的 EnvId，若实际服务不支持省略会安全报错，不猜数据库编号。

已有非空集合须有本项目已确认的逐集合归属；陌生数据、未知索引、唯一性不符或非 ADMINONLY 立即停止，不接管、不删除、不改旧规则。租约记录在 META；写入意图先持久保存为 recovery 阶段，再发创建/索引请求。丢失响应后的下一调用先回读定义；已存在的索引不会重复创建。已收到成功响应但尚不可见的索引持续返回 `index_definition_pending`，不再次发送 UpdateTable。若请求结果未知，至少等待65秒、超过 SDK 请求超时后才允许重新从定义读取阶段确认。集合创建的 alreadyExists 视为待核验，不覆盖数据。

代码在2.2秒预算耗尽时停止启动下一动作并返回进度；单个腾讯 API 仍可能超过平台3秒，因此不承诺每次调用必成功。可恢复 checkpoint 和写前意图允许调用被截断后续做，无需增购套餐。自动续做应串行调用，避免并发或紧密轮询；没有无限循环或后台自发云调用。

## 就绪标记的准确含义

准备完成后另开一轮逐集合复核。每份 receipt 绑定同一 roundId、manifestHash 与验证时间；复核超过15分钟会丢弃旧 receipts 重新检查。只有13集合的双权限及全部索引定义 receipts 完整后，事务写入 `provision-ready`。稍后重新 apply 如发现已完成快照超过15分钟，也会关闭旧 ready 标记并启动新复核。inspect 展示的是带时间的历史快照。

**索引 receipt 名为 `indexDefinitionVerified`，表示官方 DescribeTable 回读的 Name、Unique、Keys 与清单一致。** 官方公开 IndexInfo 没有运行状态字段，因此此函数不声称索引处于 NORMAL，不猜造状态 API，不调用未核实支持的 Mongo explain。异步索引是否已支持实际查询，须由 market 的代表查询与完整流程联调验证；真实接口报 index-not-ready 时应等待后重试，不能把配置就绪称为业务验收通过。

微信环境实际内建索引另按已核实形状匹配：`_openid_1` 对应 `_openid` 升序，`_id_` 对应 `_id` 升序，二者控制面回读均为 `Unique:false,Sparse:false,PartialFilterExpression:''`。这些字段不代表文档API允许重复文档编号；`_id`唯一性由文档标识与API保障，不能以控制面的Unique布尔值断言。兼容旧的Unique:true `_id_`形式，但同名异键、稀疏／过滤索引和任意清单外额外索引仍拒绝，不删除、不改ACL或数据。

marker 存在 `lsf_meta`，文档键为 SHA-256(`provision-ready`) 前32个十六进制字符。字段包含 id、schemaVersion:1、manifestHash、appId、envId、ready、verifiedAt、operatorAccountId、roundId、verificationStartedAt 与 `verificationMode:'sequential_snapshot'`。分步复核是受控初始化期间的时间快照，要求期间不由其他管理员改权限/索引，不是所有集合同时锁定的原子审计。market 管理员绑定仍走独立、显式的 BOOTSTRAP_ADMIN_ACCOUNT_ID 流程。

完成后可删除服务端 PROVISION_OPERATOR_ACCOUNT_ID 并重新部署此函数关闭检查/修改入口；不要清除 ready、checkpoint 或管理员单例。旧 formatVersion:1 checkpoint 不会自动覆盖，须先人工确认归属和迁移；未知状态保持拒绝。

## 凭据和失败

官方 Manager SDK 在事件云函数内自动使用临时运行身份。项目代码不读取、存储或打印密钥，不申请新 CAM 权限，不扩大执行角色。HTTP/Web 函数不自动拥有相同身份，不能套用此配置。配置只接受上述三个编号。

控制面失败只返回固定说明、失败操作、清单集合和筛选后的官方错误码，不返回 SDK message、headers、原始请求、上下文或业务记录。权限拒绝不会被当作“集合不存在”。若当前角色不支持这些 API，最少人工步骤是在指定环境控制台创建清单集合并选择“仅管理端读写”，核对权限及建立清单索引，再由具有现有权限的管理入口完成核验；不上传密钥、不放开客户端规则绕过。部署成功不等于权限或业务验证成功。

## 本机验证

```sh
npm ci --prefix cloudfunctions/provision --ignore-scripts
node --test tests/cloudbase-provision.test.mjs
```

测试强制每调用最多两个控制面请求，覆盖时间预算、可信身份、只读默认、原子权限参数、未知数据保护、写响应丢失、租约恢复、异步定义等待、过期回执重验及错误脱敏；运行配置测试另核对精确的固定参数、零数据库访问、未改变其他配置与后续Active读回。实际SDK运行时smoke核验两种配置API的请求与响应解包。没有真实云写入。

官方依据：[Manager SDK](https://docs.cloudbase.net/api-reference/manager/node/introduction)、[函数配置API](https://docs.cloudbase.net/api-reference/manager/node/function)、[CreateTable](https://cloud.tencent.cn/document/api/876/127968)、[权限接口](https://docs.cloudbase.net/api-reference/manager/node/rule)、[微信 DescribeSafeRule](https://cloud.tencent.com/document/api/876/128118)、[索引定义 API](https://docs.cloudbase.net/api-reference/manager/node/database)。
