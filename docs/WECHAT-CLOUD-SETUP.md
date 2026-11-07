# 微信云端接入与部署

微信原生端支持两条云接入路径：`wx.cloud.callFunction` 调用本项目 CloudBase 云函数，或 `wx.request` 调用已部署的独立HTTPS API。默认源码继续使用本机模拟，不因为云失败自动改回本机，不导入旧模拟订单。旧Sites网页仍是独立部署，不能把它的云同步结果当作小程序已联调成功。

## 低成本开发路径

没有自有服务器和域名时，优先准备微信云开发体验环境。开通账号、接受协议、付费及云角色授权由项目所有者本人完成。体验版和上线后的有效期以当前官方页面为准，不能承诺永久免费，也不自动购买套餐。现有云环境可先通过已登录的官方微信开发者工具CLI读取核实，不能仅因控制台加载失败就重复创建资源。

普通HTTP API还需要微信后台允许的HTTPS服务器域名；不要把 `workers.dev`、IP地址、关闭域名检查或Sites私有服务令牌作为正式接入方案。CloudBase直接云函数调用不使用这条HTTP入口。

官方参考：[微信网络说明](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[CloudBase资源点价格](https://cloud.tencent.com/document/product/876/127357)、[微信CLI](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)。

## 本机生成部署包

```sh
npm run build:miniprogram
npm run build:cloudbase
npm run check
npm ci --prefix cloudfunctions/market --omit=dev --ignore-scripts
npm ci --prefix cloudfunctions/provision --omit=dev --ignore-scripts
npm run test:cloudbase:runtime
npm run prepare:cloudbase -- --env 实际环境ID
```

命令会在被Git忽略的 `.wechat-local/` 下生成独立项目。原有 `miniprogram/config.js` 保持mock；生成项目写入精确环境、函数名 `longshang-market` 及本机AppID。不会复制node_modules、密钥、本机登录状态或历史运行配置，也不会自动部署或开通云资源。输出的 `preparation.json` 记录文件摘要和“未部署／未核验规则”状态。

生成项目包括 `cloudfunctions/longshang-market/` 和可用时的 `longshang-provision/`。函数运行配置仅包含应用编号、环境编号和明确指定的账户编号；真实值不进公开仓库。现有AppID继续由 `wechat:configure` 校验和保留。

当前官方微信CLI新建的函数实际为Nodejs16.13、默认3秒。两套函数已在官方Node16.13下复制到仓库外、加载真实入口验证，禁止借用父目录依赖。`wx-server-sdk@4.0.2` 的打包代码会加载未声明的 `mime-db`，因此两个函数都显式锁定该依赖；provision还定向锁定manager的MIME依赖为兼容版本。远端npm版本不确定，部署时把本机按lock安装并验证的各自 `node_modules` 复制到生成项目对应函数目录，不使用 `--remote-npm-install`。当前依赖没有平台原生二进制；不能把后续加入的Mac原生模块未经核验直接上传Linux运行。

真实调用需要把 `longshang-provision` 的执行超时设置为15秒、`longshang-market` 设置为30秒。操作者配置完成后，可通过受控 `provision-runtime-inspect`／`provision-runtime-configure` 和 `runtime-inspect`／`runtime-configure` 操作核对与设置；配置操作必须显式 `apply:true`，目标和值固定，写后另行只读核实Active状态和时限。若初始化函数自身仍受3秒限制，连配置调用也超时，则在微信开发者工具“云开发 → 云函数 → 对应函数的版本与配置 → 配置 → 高级配置”只调整执行超时并读回确认。当前CLI没有这项直接修改命令，不编造参数，也不因超时购买套餐或增加内存。

微信实际调用会附加 `userInfo`、`tcbContext`，两个入口只忽略这些传输字段，其内容不参与身份或权限判断，仍使用 `getWXContext()`。数据库读取带有的 `_id` 也必须在checkpoint写入前剥离；遇到中断按已有进度续做，不重建或清空集合。

## 先准备权限和集合，再启用业务

所有集合见 `cloudfunctions/market/collections.json`。只允许本项目的 `lsf_` 集合；每个集合必须禁止客户端直接读写，由云函数管理员身份执行受控操作。已有其他函数、集合和数据保持原样。不能仅看到“创建成功”就认为访问规则已正确。

`longshang-provision` 使用官方管理SDK的云函数临时身份，应用代码不读取或输出密钥。默认不修改资源；实际初始化需要由部署者核对的 `PROVISION_OPERATOR_ACCOUNT_ID`，并由同一可信微信账号明确调用。其身份查询只返回本项目派生账户编号，不返回原始OpenID。初始化只创建固定清单，创建时设置ADMINONLY，核对权限和索引定义后写就绪标记。缺少执行角色权限时停止并报对应操作，不自动授予更宽角色。

业务函数严格核对就绪标记的清单版本、AppID和环境；未完成时返回 `cloudbase_not_ready`，不能登录、种数据或下单。初始化中断应按函数返回状态续做，不删除集合或清空已有数据。

官方CLI可用当前微信开发者工具登录部署指定新函数，例如：

```sh
/Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy \
  --env 实际环境ID --paths /部署包/cloudfunctions/longshang-provision \
  --appid 实际AppID
```

以上是参数示意，不能原样执行。部署前核对现有函数列表及生成包；不要使用 `upload` 代替开发预览或把部署函数说成小程序已发布。

## 管理员与采购者

CloudBase新登录账号默认仅为买家。首个管理员必须由部署者把已验证的账户编号精确写入 `BOOTSTRAP_ADMIN_ACCOUNT_ID`，经数据库事务的单例记录绑定；没有“第一个访问者自动成为管理员”的入口。后续修改配置不会把另一访客自动升级。独立D1路径提供 `wechat:bootstrap-admin` 命令，默认只生成SQL，实际执行需明确目标配置、模式和AppID确认。

管理员在原生“我的→商家工作台→采购者管理”填入采购者本人登录后复制的账户编号，分配商品、订单、售后三项权限。账号绑定后不能换成别人；停用或撤销权限由服务端即时校验。微信账号不依赖邮箱认领旧Sites商家。

采购者可从模拟模板新建自己的商品草稿，设置价格、批次与库存后上架；不能修改其他采购者商品。全新演示资料的显式初始化只补不存在的六款商品和初始库存，已配置或消耗过的库存不会刷新补满。

## 跨端验收

1. 同一微信账号在手机和开发者工具的同一云项目登录，核对购物车、收藏及示例地区同步；另一个账号看不到这些个人资料。
2. 使用示例商品生成模拟订单；网络重试仍是同一订单，库存只扣一次。修改价格、库存或权限时，旧页面须重新核对。
3. 授权采购者发货，买家刷新后确认收货，再申请售后；采购者处理后买家看到结果。
4. 退出一个设备不会注销另一个设备；换账号或切换云环境不会恢复前一个账号／环境的待提交订单。

现有自动化覆盖以上逻辑和真实SDK适配层，使用隔离数据库夹具；它不等于真实云部署或手机验收。CloudBase事务按实际快照隔离测试，权限撤销、停卖、改价与订单写入通过冲突保护共同约束。

当前仍不接支付、真实物流、退款或真实个人地址。商品图片为打包示意素材；本CloudBase适配尚未提供图片／视频云上传，也尚未把历史Sites管理后台迁到同一CloudBase身份体系。原生工作台可在手机和微信开发者工具使用；不能据此声称历史网页管理端已与新云同步。
