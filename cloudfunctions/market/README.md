# 微信原生 CloudBase 云函数

`market` 是原生小程序的独立云端适配器，保留 `/api/v1` 商品、采购者、购物资料、模拟订单与售后 DTO。它使用 `wx-server-sdk` 的文档数据库事务，不依赖 Workers、D1、R2、域名、AppSecret 或支付。现有 Cloudflare Worker 适配仍保留，切换必须显式配置；云端错误绝不回退到本机数据。

## 当前边界

实现了微信可信上下文账号、每台客户端独立登录会话、首位管理员的受控绑定、采购者账号与三项权限、商品/库存、购物车/收藏/足迹/示例地区，以及模拟下单—发货—收货—售后。内置六款模拟商品可由管理员显式初始化。当前图片仍使用打包示意图，CloudBase 图片/视频上传与存储绑定尚未接入；不能把此适配器称为已完成云媒体迁移。网页管理端没有调用微信云函数的可信微信上下文，当前 CloudBase 管理操作来自原生小程序。

代码与本机事务夹具验证不代表真实环境已部署、权限已配置或手机验收已通过。实际部署与真机结果由本次交付记录单独说明。全程不接真实支付、真实快递与真实退款。

## 在已有环境中准备

1. 使用小程序现有云开发环境；是否免费及配额、到期、续费以开通界面的当前条款为准，不自动开通付费资源。不要新建/修改其他项目的函数或集合。
2. 仅创建 [collections.json](./collections.json) 中列出的 13 个 `lsf_` 集合。**存数据前，对每个集合显式设置“仅管理端可读写”（ADMINONLY），或自定义 `{ "read": false, "write": false }`，并核验客户端直接读写均被拒绝。** 不假定新集合默认规则安全。本函数没有建集合/改安全规则接口，集合不存在即报错，不能在客户端初始化。
3. 建立 manifest 中列出的组合索引，等索引生效。`_id` 使用稳定哈希键，所有事务都按文档读取，查询分页在事务外进行，且始终保留买家/采购者约束。
4. 在函数环境变量配置 `WECHAT_APP_ID` 与预期 `CLOUDBASE_ENV_ID`。如果部署工具不能设环境变量，可在**被忽略的本机部署包**添加 `runtime.config.json`，格式参考 example，仅允许 `WECHAT_APP_ID`、`CLOUDBASE_ENV_ID` 与可选的 `BOOTSTRAP_ADMIN_ACCOUNT_ID`。环境变量优先；两处非空但不同会拒绝启动。实际环境 ID 和账号编号不进入公开 Git。
5. 使用独立受控 provision 流程，回读确认上述 13 个集合均为 ADMINONLY 且索引全部就绪后，才写入 `lsf_meta` 的 `provision-ready` 标记。标记必须绑定应用编号、环境编号、schemaVersion 与当前 manifest 的 SHA-256；普通 market 不提供写就绪标记接口。market 每次先核验可信微信身份，再将 `getWXContext().ENV` 与服务端预期环境比较并核验标记；未完成时连匿名浏览与登录也统一返回 `503 cloudbase_not_ready`，不保存用户/会话。manifest 改变需要重新运行核验，不能手工填 ready 绕过。独立 provision 的部署与安全核验方法见其目录文档。
6. 初次管理员：正常微信登录后，从本人会话的 `user.id` 取得 `wechat:...` 账号编号，经运营者本人核对，再在上述服务端配置显式设置 `BOOTSTRAP_ADMIN_ACCOUNT_ID`。重新部署并由该微信重新登录；仅当单例 `admin-bootstrap` 尚不存在、精确账号匹配且仍为普通买家时，同一事务提升为管理员。不能用客户端 role/openid、首个访问者、任意邮箱或提供账号参数直接提权。完成后可从配置删除 bootstrap 字段，不要手动清除单例。
7. 管理员在小程序显式初始化模拟资料。只对从未出现的新品创建 20/12 份库存，已有商品、库存或历史标记均跳过；重试不会补满。其他新商品库存默认 0，必须显式配置批次与数量。

仅管理端规则的作用范围与服务器 SDK 权限见 [数据库概述](https://cloud.tencent.com/document/product/876/19369) 与 [安全规则](https://cloud.tencent.cn/document/product/876/41802)。云 API 设置 `ADMINONLY` 的官方接口见 [ModifySafeRule](https://cloud.tencent.cn/document/product/876/128959)。需要管理员已有云 API 授权或控制台操作；微信 IDE 代码部署成功不能代替权限核验。

## 本机准备与部署

从仓库根目录执行：

```sh
node cloudfunctions/market/build.mjs
npm ci --prefix cloudfunctions/market
node --test tests/cloudbase-api.test.mjs tests/cloudbase-transport.test.mjs
```

`lib/model.cjs`、`lib/storefront.cjs` 是共享纯业务逻辑的构建副本，源文件在 `public/`，修改源文件后重新生成。`package-lock.json` 固定 SDK 版本。部署目录是 `cloudfunctions/market/`，使用微信开发者工具或其官方 CLI 上传新建 `market` 函数并安装依赖。部署时不得覆盖环境中其他函数，`runtime.config.json` 只在本机生成。真实调用不需要 AppSecret；不要把 AppSecret、上传私钥、会话令牌、数据库导出放入 Git。

## 实际云运行时与兼容性验证

微信旧版官方 CLI 创建的事件函数可能使用 `Nodejs16.13`。两个函数包最低版本为 Node 16.13.0，共享 bundle 按 `node16.13` 构建；项目本机开发/完整测试仍使用根工程要求的现代 Node。运行代码不依赖全局 `fetch`、`structuredClone` 或 `AbortSignal.timeout`。

`wx-server-sdk` 固定 4.0.2。provision 保留 `@cloudbase/manager-node` 5.9.4，但定向覆盖它的 `mime-types` 为 2.1.35：默认 3.0.2 要求 Node >=18，而 manager 源码只有未使用的 storage helper 调用 `lookup`；provision 只调用 JSON 云 API。该覆盖保留 `lookup` 的接口，绝不修改权限/索引 API、安全流程或 SDK 身份来源。锁定后的所有依赖 engine 范围包含 16.13.0；今后升级 SDK 必须重新核验并可在更高云运行时移除此兼容覆盖。

安装两个函数包依赖后，用实际 Node 16.13.0 二进制执行：

```sh
/path/to/node-v16.13.0/bin/node tests/cloudbase-runtime-smoke.cjs
```

这项检查加载真实 wx SDK 与 manager SDK，替换唯一 SDK 出站 transport、验证 constructor / `commonService` / 顶层响应解包、核验依赖 engine 与 MIME lookup，并通过同一生产 API/事务适配器跑两个客户端购物、模拟下单、幂等库存、发货、收货、售后与单端退出。无真实云 API 或网络调用，不替代已部署环境的权限、索引和真实事务验收。Node 16.13.0 官方二进制与校验文件见 [官方归档](https://nodejs.org/download/release/v16.13.0/)。

如果改用 CloudBase 官方 `tcb` CLI，可以在 `cloudbaserc.json` 的 `functions[].runtime` 显式选 `Nodejs18.15` 或其他受支持版本，见 [官方函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)。这与微信 IDE CLI 的登录/配置流程不同；不能把未验证的配置字段传给旧 CLI，也不能假定已创建函数能直接修改运行时。

## 调用与会话

客户端只调用 `wx.cloud.callFunction({name:'market',data:event})`，不直接使用云数据库。事件为：

```js
{path:'/api/v1/orders',method:'POST',body:{/* DTO */},sessionToken:'wxs_...',expectedUserId:'wechat:...'}
```

函数返回 `{status,body}`；错误体 `{error:{code,message}}`。身份只来自 `getWXContext()` 的 `APPID`、`OPENID`，账号为 `wechat:` + SHA-256(`APPID + '\0' + OPENID`)。客户端 `expectedUserId` 仅用于不相等时拒绝请求，绝不赋予身份或角色。

`POST /auth/wechat/login {}` 返回 `{token,expiresAt,session}`。数据库只保存随机 token 的哈希及账号/应用/到期，7 天过期；每账号每分钟最多 10 次登录。`GET /session` 没 token 返回匿名，有 token 必须与当前可信微信账号匹配。`POST /auth/wechat/logout {}` 仅撤销该客户端 token，不使其他手机/电脑退出。每次权限都读取最新账号与采购者档案；写入时在业务事务内再次校验，写事务对当前 session、用户、采购者档案写入随机授权栅栏，下单同时对卖家用户/档案与各商品写入栅栏。这样即使数据库使用快照隔离，停用、撤权、退出、改价或下架与订单提交并发时也有真实写集相交，发生冲突并重试校验；普通读取与报价不写栅栏。栅栏不增加面向用户的资料版本。

采购者须先从本小程序登录，再由管理员通过 `/admin/wechat/merchants` 绑定其账号编号，独立赋予 `products`、`orders`、`aftersales`。采购者只能管理自己商品与订单，只有售后权限时仅可读取已有售后订单。旧 Sites 邮箱账号不会自动合并。

## 一致性与规模约束

下单的幂等编号、完整订单、所有规格扣减与库存审计同一个事务提交。先检查成功请求重放，再读取当前商品报价，因此已成功重试不因后来下架/改价失败。12 个规格上限，资料/库存版本必须匹配；当前仅支持同一采购者商品合并下单。取消前检查整单所有原批次，任一不符整单不自动回补。旧无批次订单和售后退款不自动回库。购物车订单扣减另有持久幂等标记，跨设备重试不会再次扣减。

使用真正 SDK `startTransaction` / `commit` / `rollback`，冲突最多重试 3 次；校验错误立即返回。事务仅文档操作，保留低于官方 100 次的 90 次内部预算，禁止外部 I/O；详情见 [CloudBase 事务](https://docs.cloudbase.net/database/transaction)。本机 MVCC 夹具模拟快照隔离，只对写集版本冲突与回滚进行检测，额外竞争测试让撤权/停用/退出/改价在提交前先完成，验证旧业务事务确实回滚，真实云事务/索引/网络还需要环境验收。

当前限制：200 商品/200 采购者、订单每页 100、购物车 12 规格、收藏/足迹各 20、售后历史最多 100。会话过期时拒绝使用，尚未配置后台定时清理；订单等业务数据也未自动删除，长期运营需建立独立受控备份、归档及配额监控。GitHub 仅备份源码，不备份云业务资料。
