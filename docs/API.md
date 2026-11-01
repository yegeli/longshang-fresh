# 云端商品、素材、订单与售后 API

V0.6 实现托管身份、角色、商品、素材与云端模拟订单、发货、售后。订单按登录身份跨设备读取；购物车、收藏和客服仍为本机记录。不接支付或真实物流。

API 入口为 `handleApi(request, env)`，使用 Web `Request` / `Response`，由托管路由调用。运行环境需绑定已迁移的 Cloudflare D1 `DB`、私有 R2 `BUCKET`，可配置 `BOOTSTRAP_ADMIN_EMAIL`。数据库结构见 `db/schema.ts`，迁移不包含商品或账户种子。

## 身份与信任边界

不自建密码、验证码、登录 Cookie 或 JWT。Sites dispatch 必须剥离客户端伪造值，再注入 `oai-authenticated-user-id` 与 `oai-authenticated-user-email`；两者齐全才识别为已登录。禁止把这个 handler 直接部署成能由外部任意设置这两个头的公开接口。若需其他托管入口，须先接入能验证身份的网关。

用户以稳定的托管 ID 为主键，邮箱仅用于初次引导和显示。新账户默认 `buyer`；数据库中的角色每次请求重新读取。首次与配置邮箱匹配的身份，通过 D1 原子 batch 和 `admin_bootstrap` 单例记录获 `admin`。后续相同邮箱的不同 ID 不会获管理权；邮箱变化不丢失已保存角色。配置为空时不引导任何管理员，明确撤销的角色也不会在后续登录时自动恢复。

当前没有公开的角色授予接口。新增 `merchant` 应由部署维护者核实稳定用户 ID 后，经受控数据库操作赋予；不能根据前端输入、邮箱相似或请求正文授予权限。`admin` 可管理所有商品和素材；`merchant` 只管理自己创建的商品，只能为自己的商品绑定自己的素材；`buyer` 无管理写入权限。

## 通用约定

- JSON 使用 UTF-8。错误为 `{ "error": { "code": "version_conflict", "message": "…" } }`，不返回 SQL、对象键、凭据或内部异常。
- 响应使用 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`，不设置跨域通配 CORS。
- 所有写入必须有与请求 URL 同源且完全匹配的 `Origin`。JSON 写入必须使用 `Content-Type: application/json`，正文上限 96 KiB。
- 常见状态：400 格式无效；401 未登录；403 无权限或 Origin 被拒；404 不存在或私有素材不可见；409 编辑冲突；413 超限；415 类型或签名不符；422 目录容量限制；503 服务或存储不可用。
- 保存失败不返回成功；503 表示未确认成功，客户端应刷新读取后再决定重试。目录最多 200 款商品，金额使用整数分。

## 会话

`GET /api/v1/session`

```json
{
  "user": { "id": "托管稳定ID", "email": "example@example.test", "name": "example" },
  "role": "admin",
  "canManage": true,
  "signInUrl": "/signin-with-chatgpt?return_to=%2Fadmin.html",
  "signOutUrl": "/signout-with-chatgpt?return_to=%2Fadmin.html"
}
```

未登录返回 `user: null`、`role: "anonymous"`、`canManage: false`。其他角色为 `buyer`、`merchant`、`admin`。登录和退出链接由 Sites 处理，页面使用普通顶层导航链接。读取会话只登记用户，不自动生成商品。

## 商品目录

`GET /api/v1/products` 公开返回已上架商品；`GET /api/v1/admin/products` 需管理权限，管理员看到全部，商家仅看到自己的商品，包含草稿与下架项。

```json
{ "products": [{ "id": "jingtai-apple", "version": 1, "...": "现有完整商品字段" }], "updatedAt": "ISO时间或null" }
```

`PUT /api/v1/admin/products/:id`

```json
{ "product": { "id": "new-food", "...": "完整商品字段" }, "expectedVersion": 0 }
```

创建用 `expectedVersion: 0`；修改用最近读取的正整数版本。成功返回 `{ "product": { "…": "…", "version": 1 }, "version": 1 }`。更新通过 SQL 中的版本条件原子执行，不能以“先读再无条件写”代替。陈旧版本返回 409；客户端应提示冲突并重新读取，不自动覆盖。

商品为完整替换，非 PATCH，使用 `public/model.js` 中 `normalizeCatalogProduct` 的完整数据形状。必填字符串字段包括 `id/name/category/status/image/origin/subtitle/summary/storage/sizeNote/video/videoTitle/videoNote`；列表包括 `tags/facts/harvestSteps/variants`。字段类型、长度、分类、状态、两种 `small` / `family` 规格及每规格 1–999999 分整数价格均校验。拒绝未知字段，特别是客户端提供的 `ownerId`、`userId`、角色和审计信息。可附带 `product.version`，但必须等于 `expectedVersion`；持久化时剥离该字段，版本由数据库管理。

`image` 只能为当前内置图片白名单：`assets/` 下的 `apples.jpg`、`goji.jpg`、`pear.jpg`、`potato.jpg`、`corn.jpg`、`onion.jpg`、`orchard.jpg`、`apple-orchard.jpg`、`apples-hero.jpg`。当前没有内置视频，`video` 必须为 `""`。上传素材通过 `imageMediaId` / `videoMediaId` 绑定，不把对象 URL 或外链写进 `image/video`。空字符串或省略素材 ID 表示移除绑定。素材必须存在、类型匹配并具有所需归属权限。创建者、最后修改者、版本和时间由服务端记录，编辑不转移商品归属。

`POST /api/v1/admin/seed`，JSON 正文 `{}`，只限管理员显式调用。幂等插入六款模拟商品；主键冲突不更新，不能覆盖既有资料。返回 `{ "inserted": 6, "products": [], "updatedAt": "…" }`，其中 `products` 为实际管理员目录，示例中的空数组仅代表响应形状。前端应在空目录时显示明确的初始化动作，不把本地演示记录自动导入云端。

## 上传素材

`POST /api/v1/media?kind=image` 或 `?kind=video`，需管理权限，同源 `Origin`，正文为文件原始字节，非 multipart。

| 头或参数 | 要求 |
| --- | --- |
| `kind` | `image` 或 `video` |
| `Content-Type` | 图片：`image/jpeg`、`image/png`、`image/webp`、`image/gif`；视频：`video/mp4`、`video/webm` |
| `X-File-Name` | `encodeURIComponent(文件名)`，解码后 1–180 字符，不含目录分隔符或控制字符 |
| `X-Media-Source` | `encodeURIComponent(素材来源与授权说明)`，解码后 1–500 字符，不能为空 |
| 正文大小 | 图片最多 5 MiB，视频最多 30 MiB，不能为空 |

服务器先检查已声明长度，再逐块计数读取；超限立即取消读取，不先把无限正文转换成 ArrayBuffer。保存前检查 MIME 与对应文件/容器签名；不把这些检查等同于完整媒体解码、病毒扫描或素材授权核验。浏览器仍须对实际可解码、预览及播放做验收。

成功返回 201：

```json
{
  "id": "CLOUD-服务端生成UUID",
  "url": "/api/v1/media/CLOUD-服务端生成UUID",
  "name": "自有图片.png",
  "type": "image/png",
  "size": 12345,
  "kind": "image",
  "source": "上传者填写的来源与授权记录"
}
```

R2 对象键由服务端生成，数据库记录上传者、类型、大小、来源与创建时间。上传不等于发布，商品保存成功后绑定才生效。R2 保存失败不登记素材；数据库登记失败时尝试清理对象。即使清理失败留下孤立对象，它没有可读取的素材记录，且桶须保持私有。当前不提供直接桶 URL、覆盖素材或删除接口。

## 读取素材

`GET /api/v1/media/:id` 与 `HEAD /api/v1/media/:id`。

素材被至少一个已发布商品引用时可公开读取；否则只有上传者或管理员能读取。权限检查在 Range 处理前执行，匿名或他人不能通过 HEAD、416 长度或分段请求探测草稿素材。商品下架且没有其他已发布引用后，素材重新变为私有。

响应使用数据库已验证的 MIME、`nosniff`、`private, no-store`。GET 支持单段 `bytes=start-end`、开放结尾和后缀 Range，成功 206 附 `Content-Range`；越界或无效单段返回 416 和 `Content-Range: bytes */总长`。多段或未知单位回退完整 200；不匹配的 `If-Range` 回退完整内容。HEAD 无正文，描述完整长度并忽略 Range，不绕过权限。R2 对象必须存在且长度与登记记录一致。

## 云端模拟订单与售后（V0.6）

以下接口均需受信登录身份。买家接口只访问当前用户的订单（管理员身份调用买家接口也不能读取他人的订单）；管理接口允许管理员管理全部订单、商家管理其商品所属订单。未知或他人的订单统一404，匿名401、无管理角色调用后台403。买家响应不包含内部 `merchantNote`，也不包含买卖双方的稳定内部ID。

`GET /api/v1/orders`、`GET /api/v1/admin/orders` 返回 `{orders, updatedAt, nextCursor}`。每页最多100笔，按创建时间和编号降序；有后续页时将返回的游标原样URL编码传入 `?cursor=...`。`GET` 同一路径下 `/:id` 返回 `{order}`。所有读取均不缓存。

`POST /api/v1/orders/quote`：

```json
{"items":[{"productId":"jingtai-apple","variant":"small","quantity":1}],"address":"gansu"}
```

返回 `{quote:{items,quantity,subtotal,shipping,total,address,productVersions}}`，其中items为服务端商品快照，address为地区ID，productVersions为商品ID到整数版本的映射。每单1–12种规格，每规格1–10份，不允许重复行。只支持 `gansu`、`shaanxi` 示例地区，模拟运费分别为600分、1000分；不收集真实地址。商品须已发布，跨商家组合返回422 `mixed_merchants`，请分开下单。

`POST /api/v1/orders` 接收同样的items/address，并增加：

```json
{
  "items":[{"productId":"jingtai-apple","variant":"small","quantity":1}],
  "address":"gansu",
  "expectedTotal":5480,
  "productVersions":{"jingtai-apple":3},
  "idempotencyKey":"ORDER-客户端生成的唯一UUID"
}
```

金额和版本仅为请求示例，实际从quote响应取得。客户端不能指定订单ID、归属、状态或价格。服务端重新读取当前商品计算快照，并在单条 `INSERT SELECT` 中再次检查版本、归属与上架状态；变化返回409 `quote_changed`。前端金额变化后须重新确认，不能静默按新价提交。

创建成功201 `{order,replayed:false}`。同买家+同幂等键+同规范化参数重试返回200 `{order,replayed:true}`，即使商品随后已下架，也返回原订单；同键不同参数409 `idempotency_conflict`。失败响应或响应丢失时保留原请求重试，不自动更换key。

订单保留下单时名称、图片引用、规格、单价、数量、运费、合计、示例地区和时间；编号为 `DEMO-大写UUID`，另带 `version`、`updatedAt`。主状态 `created/cancelled`，发货位于 `fulfillment`，当前售后位于 `afterSale`。`afterSaleHistory` 追加每次申请、撤回和处理后的完整售后快照（同一售后ID可有多个状态），不覆盖历史。没有支付状态、库存扣减、真实运单或实际退款。

| POST 路径 | 正文字段（均必带expectedVersion） | 权限及行为 |
| --- | --- | --- |
| `/api/v1/orders/:id/cancel` | `expectedVersion` | 本人取消未发货、无待售后、未完成整单退款的订单 |
| `/api/v1/orders/:id/aftersale` | `expectedVersion,type,reason,description,hasEvidence` | 本人申请；type为refund/replacement；reason为damaged/spec/delivery/other；description最多300字；hasEvidence为模拟凭证布尔值，不上传真实凭证 |
| `/api/v1/orders/:id/aftersale/withdraw` | `expectedVersion` | 本人撤回待处理售后 |
| `/api/v1/admin/orders/:id/ship` | `expectedVersion,carrier,tracking` | 授权后台模拟发货；carrier最多40字，tracking必须为DEMO-开头演示单号 |
| `/api/v1/admin/orders/:id/note` | `expectedVersion,note` | 授权后台保存最多300字内部备注 |
| `/api/v1/admin/orders/:id/aftersale/resolve` | `expectedVersion,reply` | 授权后台处理待售后；reply最多300字，买家可见，不发生退款或补发 |

成功均返回 `{order}` 并递增版本；SQL按 `id+expectedVersion+归属` 条件原子更新。陈旧版本409 `version_conflict`，不允许静默覆盖；非法状态409 `order_state_invalid`。已取消、重复发货、待处理售后或整单模拟退款完成的订单均不能发货；退款完成后不能再次申请或取消。售后历史达到100条后不再接受新申请，但仍可处理已有待办。没有云端清空/删除/自动样例订单接口。

## 验证范围

`tests/cloud-api.test.mjs` 将真实 `drizzle/*.sql` 迁移应用到 Node SQLite，再以薄 D1 适配层调用同一个 handler；R2 用内存对象存储适配，测试字节为自有临时数据。覆盖管理员首次引导、角色撤销、并发版本、数据库约束、跨账户拒绝、上传签名/大小/流取消、失败清理及素材可见性与 Range。

这些自动化测试不替代 Sites dispatch、真实 D1/R2、托管登录或手机实际文件上传/播放验收。云端商品和素材的跨设备联动应在部署后单独验证；V0.6 订单使用 D1 独立持久化，真实手机交互仍需单独验收。
