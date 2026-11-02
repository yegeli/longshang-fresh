# 微信小程序开发流程

本项目主线转为真正的微信小程序。原生客户端位于 `miniprogram/`，使用 WXML、WXSS、Page、App 和微信 API，没有嵌入网页的 web-view。历史手机网页和 Sites 管理后台继续保留，不能把网页链接当作微信小程序发布结果。

当前已扩展为16个原生页面，增加商品与库存、模拟履约和微信采购者管理。云端优先适配微信云开发；下表中的独立HTTP接口继续保留，两条部署路径均需实际环境核验。CloudBase的环境准备、集合规则、首管绑定和跨端验收详见 [微信云端接入](WECHAT-CLOUD-SETUP.md)。

## 阶段与交付标准

| 阶段 | 本轮范围 | 完成标准 |
| --- | --- | --- |
| 1. 原生买家端 | 首页、产区、采购者店铺、商品详情、购物车、结算、订单、收货、售后、我的和指南 | 13个页面可连贯操作，明确模拟模式，完整流程与异常恢复测试通过 |
| 2. 微信身份与接口 | `wx.login`、服务端 code 交换、不透明会话、退出与过期、业务 API 复用 | 微信身份不冒充 Sites 身份、不自动取得商家权限；本机 Worker 接口检查通过 |
| 3. 注册项目与手机预览 | 配置实际 AppID，用官方工具编译并生成微信预览 | 实际微信扫码进入，手机页面、素材、操作及账号状态验收通过 |
| 4. 云端联调 | 部署独立 HTTPS API，配置微信服务端密钥、资源和合法域名，明确运营者授权与商品资料 | 两个设备登录同一微信身份读到同一云端订单，采购者只处理授权数据 |
| 5. 审核与发布 | 核对账号后台允许的服务范围、资料、体验及审核要求 | 微信后台审核通过并实际发布；没有结果前不得声称已上线 |

每阶段统一执行：实现完整行为 → 自动化及对应运行检查 → Git 提交 → 命令推送 GitHub → 核验远端SHA和CI → 记录已完成与未验证事项。遇到账号、密钥或平台操作依赖时继续独立开发，不伪造认证，不让用户重新规划整个项目。

继续使用模拟商品、价格、库存、地址地区与物流，不接支付。普通微信买家、采购者、管理员的职责分别验证，不以在一个本机模拟身份里切换操作代替权限验收。

## 打开原生工程

```sh
npm install
npm run build:miniprogram
npm run wechat:configure -- --appid wx填写自己的AppID
npm run check:miniprogram
```

`--appid` 必须是微信后台实际提供的 `wx` 加16位十六进制编号；上面的中文只是说明，不能原样执行。也可先运行 `npm run wechat:configure -- --tourist` 生成不关联真实账号的本机工程。导入微信开发者工具时选择仓库根目录，`miniprogramRoot` 已指向 `miniprogram/`。

AppID保存在被 Git 忽略的 `project.config.json` 中。脚本保留已有配置，拒绝把已配置的真实 AppID 静默换成另一应用或游客。公开仓库只提供 `project.config.example.json`。AppSecret和上传私钥是另外的凭据，不能放入 AppID 字段、聊天、客户端或 Git。

本机模拟模式默认就绪，第一次使用配置六款商品的20／12份库存；刷新、重开和代码更新不重置已消耗库存。购物车结算生成订单后，在订单详情可依次“模拟商家发货”、确认模拟收货、申请售后、模拟售后处理。这些商家操作仅在本机模拟模式显示，云模式没有客户端提权入口。

## 用已登录的开发者工具预览

首次真机预览优先使用官方微信开发者工具，不需要为此创建代码上传私钥。网页微信后台的登录不会自动登录桌面工具；请用该小程序的管理员或开发者微信扫描工具内的登录二维码。

macOS已安装Homebrew时可用 `brew install --cask wechatwebdevtools` 安装官方发行包。安装后先正常打开一次，完成用户本人扫码登录。若要通过CLI生成预览，需用户在工具的“设置 → 安全设置”开启服务端口；这是允许本机命令调用开发者工具的授权步骤，不应由脚本静默修改安全配置。新版工具若要求CLI访问令牌，按其安全设置配置并通过本机环境变量使用，不写进仓库或聊天。

```sh
mkdir -p .wechat-local
/Applications/wechatwebdevtools.app/Contents/MacOS/cli islogin
/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  --project "$PWD" \
  --qr-format image \
  --qr-output "$PWD/.wechat-local/preview.png" \
  --info-output "$PWD/.wechat-local/preview-info.json"
```

命令从仓库根目录执行；安装位置不同则调整CLI路径。必须检查CLI结果和生成的预览二维码，不能把工具登录二维码当作小程序交付。手机扫码后依次验证首页→产区→采购者店铺→商品详情→加购→模拟下单→模拟发货→确认收货→售后处理；本机模拟不跨设备同步。预览上传不等于提交审核或正式发布。

也可在开发者工具导入仓库根目录后点击“预览”。服务端口只为命令行控制所需，使用工具界面的预览功能无需为CLI开启它。参见[微信官方CLI文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)。

## 微信云端接入

`miniprogram/config.js` 默认 `mode: 'mock'`，所有记录只保存在当前微信开发环境或设备。切换到 `mode: 'cloud'` 必须配置自己的独立 `apiBase` HTTPS根地址；云失败明确报错，不改成本机模拟，旧模拟订单不会上传。

现有 `chatgpt.site` 私有站点依赖 Sites 访客入口，不能直接作为普通微信用户的公开 API，也不能把其服务访问令牌装进小程序。独立服务器代码在 `wechat-worker/worker.js`，示例配置 `wechat-worker/wrangler.example.jsonc`；复用商品、订单、库存和售后逻辑，使用独立的登录信任边界。当前仓库没有可自动部署的真实云资源账号、密钥或资源编号。

正式联调前需要：

- 微信 AppID 与服务端 `WECHAT_APP_SECRET`；服务端通过官方接口交换一次性 code，客户端只取得本项目会话。OpenID、session_key及AppSecret不返回客户端或写入日志。
- 自有公开 HTTPS API 与 D1／R2 资源绑定，应用 schema-only 数据迁移，按微信后台配置对应合法域名。示例配置中的占位编号不能当作已创建资源。
- 明确运营者身份与权限配置：微信新账号默认仅为买家，不把第一个访客自动升为管理员，也不以未经验证的邮箱自动认领旧商家。独立新数据库的首个管理员、采购者邀请和已有数据迁移需要受控配置；本轮尚未实现运营者绑定工具，不可直接开放为正式商城。
- 部署时配置登录接口的边缘限流、备份和故障监测；当前代码包含单请求大小、超时和提供方限流处理，但没有分布式IP限流。

所有外部资源与账号状态以实际核验为准。网站部署、测试通过和微信审核发布是三件不同的事。

## 验证与命令备份

```sh
npm run check
npm run build:miniprogram
npm run check:miniprogram
npm run test:wechat:worker
npx tsc --noEmit
```

原生服务与页面测试覆盖商品到售后的完整模拟流程、重复点击、响应丢失、持久化失败、购物车清理、账号切换和库存不重复扣减。Worker测试在隔离本机数据库中运行，微信接口由测试夹具拦截，禁止向真实微信发送测试凭据。

微信官方编译SDK隔离安装在 `tools/wechat/`，通过 `npm ci --prefix tools/wechat` 安装锁定版本。使用该SDK预览和上传另需微信后台授权的代码上传私钥，并配置当前上传出口IP白名单；不通过关闭IP限制解决上传失败。已登录桌面开发者工具的CLI预览是另一条路径，见上文。普通官方编译检查不等于已上传、手机可扫码或正式发布。私钥由用户保存在仓库外并受控使用，不能代替微信AppSecret。

本机macOS／Windows可运行 `npm run compile:miniprogram`，调用锁定版本官方 WCC／WCSC／增强JS编译器，不需要AppID或上传私钥；该原生编译器包没有Linux版本，因此Ubuntu CI运行源码、包体及业务检查，不冒充官方编译。配置真实AppID并由用户准备上传私钥后，运行 `npm run wechat:preview -- --key-file /绝对路径/上传私钥.key` 才会把单独暂存的原生代码提交到微信生成开发预览二维码；不会提交审核或正式发布。预览二维码输出在忽略目录 `.wechat-local/`，生成二维码后仍需真实手机扫码验收。

GitHub保存代码、示例配置、测试和公开素材。数据库、媒体运行数据、微信凭据及本机项目身份不随源码备份。每次阶段性交付在验收记录中写明实际提交、CI结果以及剩余平台步骤。

参考：[微信官方示例工程配置](https://github.com/wechat-miniprogram/miniprogram-demo/blob/master/project.config.json)、[微信官方 miniprogram-ci 工具](https://www.npmjs.com/package/miniprogram-ci)。
