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

## 媒体存储只读核验

已配置的同一操作者可调用精确的 `{operation:'storage-inspect'}`。不接受apply、文件路径、ACL或规则等客户端参数。函数先核对 `lsf_meta` 当前微信安全规则为ADMINONLY及本项目的 `provision-ready`，再通过官方 `manager.storage.getStorageAcl({withRule:true})` 读取共享存储权限。此操作不调用setStorageAcl，不更改存储规则、其他项目的文件、域名或运行角色。

返回仅含ACL、是否存在自定义规则、自定义规则的SHA-256摘要、核验时间及 `storageReady`；不返回完整规则或服务端SDK响应。固定的 `lsf_meta` 记录 `markerKey('media-storage-ready')` 使用 `mediaPolicy:'server-owned-display-v1'`，只允许本轮非敏感、可公开展示的模拟商品图片和采摘视频。ACL为ADMINONLY时可写ready:true；PRIVATE还必须有同应用、环境、操作者已完成的代表性探针，结果同时为 `representative:true,fileIntact:true,cleanedUp:true`，记录其核验时间。没有合格探针或其他ACL均写ready:false。旧ready在重新读取存储权限前先失效，所以API失败或未知ACL不会留下本次仍可用的旧记录。归属不匹配的记录拒绝覆盖。

这是存储规则及商品展示用途的时间快照，不能把它当作长期不变的权限保证或文件保密证明。商城媒体接口须核对应用、环境、固定标记、对应mediaPolicy、允许的ACL、ready及有效时间，过期或缺失则关闭上传读取。若共享存储当前是其他规则，本操作只报告且保持媒体关闭，不能为本项目擅自改动整桶规则。

2026-11-07的真实微信探针发现：Manager返回PRIVATE，但同一微信调用者持完整fileID可以通过原生 `wx.cloud.getTempFileURL` 换链并下载；原生覆盖返回-503002、删除逐项status为1，服务端带签名URL可读，不带签名URL为403。因此不能宣称“草稿只有所属商家可读”或将fileID视为绝对保密标识。此次未取得官方CloudBase文件创建者元数据，也未证实差异来自所有者归属还是微信与CloudBase鉴权链路；这里只记录实际结果，不猜测底层机制。

本轮素材从上传起就是可公开展示的商品内容，上传入口需明确该用途。服务端仍校验采购者身份、商品归属、权限和版本，只有当前已发布绑定会由买家业务API返回；未发布素材不进入商城展示列表，发布规则控制业务API发现，不保证持完整文件标识或已获链接者无法继续阅读。不可枚举随机路径用于减少发现和猜测，不能替代读取权限；素材不得承载身份证、合同、私聊或售后证据等私密资料。商品、订单和售后的数据库权限隔离继续独立生效，客户记录不会改用此素材机制。

PRIVATE规则是否适用于服务端上传须另外验证，不能仅凭“云函数是管理员”推断文件归属。受控操作者可显式调用 `{operation:'storage-probe-start',apply:true}`：只在现有PRIVATE或ADMINONLY规则下，为固定1像素PNG生成随机 `lsf-media/probes/` 路径，先在固定META记录持久保存nonce和路径，再由与商城相同的wx-server-sdk上传，成功后保存SDK返回的fileID。该路径的首次对象操作必须是wx-server-sdk.uploadFile，不能先通过Manager注册上传元数据，以免改变待测文件的归属。成功响应包含本次探针的nonce、fileID、path及服务端300秒链接，供核对带签名与不带签名访问差异。重复start沿用同一探针，不覆盖文件或留下多个随机文件；客户端不能提供内容、路径、编号或“已拒绝”验证结果。上传响应丢失的探针标为非代表性，finish只清理已持久记录的精确路径，不能拿它作为权限证据。

用同一个真实调用者从小程序直接尝试读取、换取URL、覆盖及删除此探针，观察实际权限结果后，调用 `{operation:'storage-probe-finish',apply:true}`。finish通过服务端限量读取并核对PNG摘要，只删除固定记录中的该探针，报告文件是否完整和清理是否成功；删除异常保留记录供重试。Manager SDK传统文件信息API没有提供CloudBase文件创建者字段，所以返回 `ownerMetadataAvailable:false`，不以COS账号Owner冒充微信openid。finish不写媒体就绪标记，也不接受客户端报告的“已拒绝”；后续另行运行storage-inspect，合格探针只满足非敏感商品展示策略的前置条件，始终不作为读取保密证明。整个过程不更改共享存储权限。

## 凭据和失败

官方 Manager SDK 在事件云函数内自动使用临时运行身份。项目代码不读取、存储或打印密钥，不申请新 CAM 权限，不扩大执行角色。HTTP/Web 函数不自动拥有相同身份，不能套用此配置。配置只接受上述三个编号。

控制面失败只返回固定说明、失败操作、清单集合和筛选后的官方错误码，不返回 SDK message、headers、原始请求、上下文或业务记录。权限拒绝不会被当作“集合不存在”。若当前角色不支持这些 API，最少人工步骤是在指定环境控制台创建清单集合并选择“仅管理端读写”，核对权限及建立清单索引，再由具有现有权限的管理入口完成核验；不上传密钥、不放开客户端规则绕过。部署成功不等于权限或业务验证成功。

## 本机验证

```sh
npm ci --prefix cloudfunctions/provision --ignore-scripts
node --test tests/cloudbase-provision.test.mjs
node --test tests/cloudbase-storage-provision.test.mjs
node --test tests/cloudbase-storage-probe.test.mjs
```

测试强制每调用最多两个控制面请求，覆盖时间预算、可信身份、只读默认、原子权限参数、未知数据保护、写响应丢失、租约恢复、异步定义等待、过期回执重验及错误脱敏；运行配置测试另核对精确的固定参数、零数据库访问、未改变其他配置与后续Active读回。实际SDK运行时smoke核验两种配置API的请求与响应解包。没有真实云写入。

官方依据：[Manager SDK](https://docs.cloudbase.net/api-reference/manager/node/introduction)、[函数配置API](https://docs.cloudbase.net/api-reference/manager/node/function)、[CreateTable](https://cloud.tencent.cn/document/api/876/127968)、[权限接口](https://docs.cloudbase.net/api-reference/manager/node/rule)、[微信 DescribeSafeRule](https://cloud.tencent.com/document/api/876/128118)、[索引定义 API](https://docs.cloudbase.net/api-reference/manager/node/database)。
