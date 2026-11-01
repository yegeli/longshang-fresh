# 架构说明

## V0.5：云商品与本机订单并存

买家与后台继续使用 `public/` 中的原生 HTML、CSS 和 JavaScript ES Modules。`npm start` 运行独立静态演示；云部署使用 Vinext／Cloudflare Worker 处理业务 API，将商品与素材保存到 D1／R2，`dist/` 是构建输出。云端订单尚未实现，浏览器模拟下单不是可信的服务端交易。

| 文件或目录 | 职责 |
| --- | --- |
| `public/index.html`、`app.js`、`experience.js`、`styles.css` | 买家页面、购物车、收藏与模拟订单 |
| `public/admin.html`、`admin.js`、`admin.css` | 后台登录门禁、商品编辑与本机订单管理 |
| `public/cloud-client.js` | 模式探测、登录状态、API 请求与连接错误 |
| `public/catalog-store.js` | 本机／云目录适配、商品版本与保存 |
| `public/media-store.js` | IndexedDB 或云上传适配、媒体地址、浏览器可读性检查 |
| `public/model.js` | 商品校验、整数分金额、报价、订单快照、模拟发货与售后状态 |
| `app/` | Vinext 入口与云 API 路由；平台登录辅助保留 Sites 集成 |
| `server/cloud-api.js` | 受信身份、D1 角色、商品归属、字段及版本检查、素材上传读取 |
| `db/schema.ts`、`drizzle/` | 云端表定义和版本化 SQL 迁移 |
| `scripts/server.mjs` | 本机静态服务与显式演示标记，不提供云业务 API |
| `public/assets/` | 示意素材与来源记录，独立于源码 MIT 许可 |
| `tests/` | 模型、存储、静态 HTTP 与迁移后的云 API 测试 |

本地入口为 `/` 与 `/admin.html`，另兼容 `/admin`；买家路由使用 URL hash。

## 模式与数据归属

前端首先请求 `/api/v1/session`。仅 `404` 且正文带 `mode: local-demo` 时启用本机模式。云接口异常、未标记的 404、断网或鉴权失败均保持云端错误状态，避免将本机修改误报为服务器保存成功。

| 内容 | 本机演示 | 云端原型 |
| --- | --- | --- |
| 身份和角色 | 无登录或服务器授权 | Sites dispatch 身份与 D1 `users` |
| 商品与状态 | localStorage | D1 `products` |
| 上传文件与元数据 | IndexedDB | R2 文件、D1 `media` |
| 购物车、订单、售后、收藏、足迹 | localStorage | 仍为 localStorage，不跨设备共享 |
| 当前规格、数量、示例地区 | sessionStorage | 仍为当前标签页记录 |
| 客服对话、编辑表单 | 页面内存 | 仍为本机演示 |

沿用 `longshang-demo-*` 键兼容本机记录，不自动上传这些数据。不同来源各自保存本地数据，复制代码或登录其他设备不会迁移记录。云端初始为空目录，由管理员显式加入模拟商品。

## 身份、权限与 API

服务器只在可信 Sites dispatch 入口后使用平台注入的稳定用户 ID 和邮箱；登录和退出由平台负责。`BOOTSTRAP_ADMIN_EMAIL` 用于一次性匹配初始化，D1 单例绑定稳定 ID；后续授权由 D1 角色决定。客户端角色或归属字段不能改变权限。

| 接口 | 授权与校验 |
| --- | --- |
| `GET /api/v1/session` | 当前身份与登录入口，匿名无管理权 |
| `GET /api/v1/products` | 只返回已发布商品 |
| `GET /api/v1/admin/products` | merchant 仅自己的商品，admin 全部 |
| `PUT /api/v1/admin/products/:id` | 同源、管理角色、商品归属、字段白名单、素材归属和类型、`expectedVersion` |
| `POST /api/v1/admin/seed` | 仅管理员，插入缺失的模拟商品，不覆盖已有资料 |
| `POST /api/v1/media?kind=image\|video` | 管理角色、大小、MIME／格式签名、文件名和来源说明 |
| `GET\|HEAD /api/v1/media/:id` | 已发布商品引用的素材可读；其他仅所有者或管理员，支持单段 Range |

商家不能绑定别人的私有素材，管理员有全局管理权限。写请求检查 `Origin`，不开放跨站 CORS。自行托管需提供可信身份适配器；直接公开信任任意请求头的裸源站不具备这一身份保证。

更新商品增加版本。SQL 再次比较 `expectedVersion`，冲突返回 409，避免检查后并发覆盖。前端保留冲突表单，重新载入须明确放弃修改。保存失败不报告成功，也不回退写入本机。

素材先上传为私人记录，再保存商品绑定；仅在售引用开放读取。R2 和 D1 不是同一事务：对象保存后元数据失败，会尝试删除对象并报错；异常可能留下未引用对象，没有元数据的对象不能经媒体 API 公开读取。当前没有自动回收或完整素材历史管理。

## 仍然本地的业务

- 每款保留 `small`、`family` 两种规格，使用整数分价格。
- `draft`、`published`、`offline` 控制可新增购买的商品，云公开目录只含已发布项。
- 同商品与规格在购物车合并，一笔模拟合单只收一次运费。
- 订单保存名称、规格、数量和金额快照，后续改价不重算旧单。
- 主状态为 `created`／`cancelled`，模拟发货放在 `fulfillment`，整单售后为 `submitted`／`resolved`／`withdrawn`。
- 模型阻止重复、取消单、待处理售后及整单退款完成后的发货；这些只保护浏览器演示一致性。

本机数据可被用户自行修改。云商品授权不为本机订单增加身份隔离、可信金额或交易安全保证；其他设备不会看到这些订单，没有 `/api/v1/orders` 业务接口。

## 后续接口演进

订单阶段需由服务器读取在售商品和运费重新报价，事务保存快照与稳定请求标识，执行顾客归属、状态、幂等及并发检查，再迁移售后。历史本机订单默认留在演示环境，不当作真实交易导入。

多商家运营还需角色管理、素材审核、视频封面／采摘日期／版权专用字段、历史版本、上传配额和回收、审计日志、备份恢复。通用来源说明不能替代这些流程。交付见 [路线图](ROADMAP.md)，部署与故障处理见 [云端运行说明](CLOUD-OPERATIONS.md)。

云端买家当前标签页会把曾读到、随后退出公开目录的商品保留为不可购买的下架记录，供购物车移除。重新打开页面后，无法读取的旧购物车商品可能被清理；持久化购物车快照留待账号与订单同步阶段。
