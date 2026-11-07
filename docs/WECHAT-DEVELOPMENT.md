# 微信小程序开发流程

本项目主线转为真正的微信小程序。原生客户端位于 `miniprogram/`，使用 WXML、WXSS、Page、App 和微信 API，没有嵌入网页的 web-view。历史手机网页和 Sites 管理后台继续保留，不能把网页链接当作微信小程序发布结果。

当前共有21个原生页面，覆盖买家购物、商品与库存、已保存商品预览、变更记录、模拟履约、微信采购者管理，以及云客服咨询／回复与本店资料。当前云端主线为微信云开发（CloudBase），已部署并完成真实云函数的模拟业务联调；公开源码仍默认本机模拟。环境准备、集合规则和首管绑定详见 [微信云端接入](WECHAT-CLOUD-SETUP.md)。历史独立HTTP接口继续保留，不是本次预览使用的入口。

## 阶段与交付标准

| 阶段 | 当前交付 | 验收与边界 |
| --- | --- | --- |
| 1. 原生买家端 | 首页、产区、店铺、详情、购物车、结算、订单、收货、售后、我的和指南；首页／店内组合筛选 | 自动化覆盖完整模拟流程和异常恢复；原生不是网页套壳 |
| 2. 微信身份与云业务 | CloudBase可信微信身份、每客户端会话、授权隔离、云商品／库存／订单／售后／购物资料 | 已完成实际云环境联调；普通买家不自动提权；云失败不回退本机 |
| 3. 原生经营工具 | 商品完整编辑、图片视频替换、库存、模拟发货、售后、内部备注、商品／库存／授权记录与草稿预览 | 权限和版本在服务端校验；本阶段具体结果见 [经营工具验收](QA-WECHAT-OPERATIONS.md) |
| 4. 云客服与店铺资料 | 文字咨询、未读、关闭／重开、本店介绍和图片上传／更换 | [客服与店铺验收](QA-WECHAT-SUPPORT-SHOP.md)；消息在打开或手动刷新时更新，只有参与买家及授权客服可读 |
| 5. 实机体验完善 | 已生成开发预览；用户已确认手机能看到商品及商家工作台 | 真实手机上传播放、完整下单至售后、第二采购者和两设备交叉验证仍需逐项补验 |
| 6. 试运营与发布准备 | 真实经营资料、云数据备份恢复、监测、体验与发布资料 | 尚未提交审核或正式发布；审核通过与实际发布分别记录 |

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

`miniprogram/config.js` 默认 `mode: 'mock'`，数据只保存在当前设备。现有实际预览使用独立暂存工程中的 `mode: 'cloud'`、`transport: 'cloudbase'` 与指定环境／云函数配置；这份配置及部署操作者身份仅保存在 Git 忽略的 `.wechat-local/`。不能直接把公开仓库的默认模拟工程当作已接通的云版本。

CloudBase路径通过微信云函数服务端 `getWXContext()` 获取可信身份，同时核验应用、环境和每客户端会话，不需要客户端持有 AppSecret，也不要求先建立独立HTTP域名。新微信账号默认仅为买家；已有受控初始化工具可将已验证账号配置为首位管理员，管理员再按可信微信账户编号分配采购者商品／订单／售后三类权限。不能把第一个访客自动升为管理员，也不能用客户端字段冒领其他商家。

已部署的集合保持服务器专用访问规则；商品、库存、订单、售后、授权与素材由服务端接口处理。图片视频采用受控分片上传和商品绑定。当前环境中，原始存储文件ID若已知仍可能读取，不能用作机密文件库；客户端不能替换／删除由服务端写入的正式素材。详见 [云媒体验收与边界](QA-WECHAT-MEDIA.md)。

准备新环境必须按 [微信云端接入](WECHAT-CLOUD-SETUP.md) 完成环境清单、规则、操作者和管理员核验，再部署和联调。未验证前接口保持关闭，不扩大共享环境权限，也不自动开通收费方案。已有本机模拟记录不会自动上传；云接口失败会明确提示，不能切回本机并显示成功。

独立HTTP替代路径保存在 `wechat-worker/`，另需自己的 HTTPS API、D1／R2、服务端 `WECHAT_APP_SECRET` 与微信合法域名配置。它不与当前CloudBase预览自动共享数据。历史 `chatgpt.site` 私有站点依赖 Sites 访客入口，其服务令牌不能放入微信小程序。生产级限流、监测和备份恢复仍需单独验证。

真实云函数联调、官方编译、用户手机体验以及微信审核发布分别记录，不能互相替代。

## 验证与命令备份

```sh
npm run check
npm run build:miniprogram
npm run check:miniprogram
npm run build:cloudbase
npm run test:cloudbase:runtime
npm run compile:miniprogram
```

原生服务与页面测试覆盖商品完整编辑、权限隔离、草稿预览、变更记录以及商品到售后的完整模拟流程、重复点击、响应丢失、持久化失败、购物车清理、账号切换和库存不重复扣减。Worker测试在隔离本机数据库中运行，微信接口由测试夹具拦截，禁止向真实微信发送测试凭据。

微信官方编译SDK隔离安装在 `tools/wechat/`，通过 `npm ci --prefix tools/wechat` 安装锁定版本。使用该SDK预览和上传另需微信后台授权的代码上传私钥，并配置当前上传出口IP白名单；不通过关闭IP限制解决上传失败。已登录桌面开发者工具的CLI预览是另一条路径，见上文。普通官方编译检查不等于已上传、手机可扫码或正式发布。私钥由用户保存在仓库外并受控使用，不能代替微信AppSecret。

本机macOS／Windows可运行 `npm run compile:miniprogram`，调用锁定版本官方 WCC／WCSC／增强JS编译器，不需要AppID或上传私钥；该原生编译器包没有Linux版本，因此Ubuntu CI运行源码、包体及业务检查，不冒充官方编译。配置真实AppID并由用户准备上传私钥后，运行 `npm run wechat:preview -- --key-file /绝对路径/上传私钥.key` 才会把单独暂存的原生代码提交到微信生成开发预览二维码；不会提交审核或正式发布。预览二维码输出在忽略目录 `.wechat-local/`，生成二维码后仍需真实手机扫码验收。

GitHub保存代码、示例配置、测试和公开素材。数据库、媒体运行数据、微信凭据及本机项目身份不随源码备份。每次阶段性交付在验收记录中写明实际提交、CI结果以及剩余平台步骤。

参考：[微信官方示例工程配置](https://github.com/wechat-miniprogram/miniprogram-demo/blob/master/project.config.json)、[微信官方 miniprogram-ci 工具](https://www.npmjs.com/package/miniprogram-ci)。
