# 云端商家、商品、库存、素材、订单与售后 API

V0.8增加每规格可售库存、当前采收批次、原子扣减、取消回补与库存记录；沿用托管身份、商家权限、商品、素材和云端模拟订单、发货、售后。云数据按登录身份和授权范围读取；购物车、收藏和客服仍为本机记录。不接支付或真实物流。

API 入口为 `handleApi(request, env)`，使用 Web `Request` / `Response`，由托管路由调用。运行环境需绑定已迁移的 Cloudflare D1 `DB`、私有 R2 `BUCKET`，可配置 `BOOTSTRAP_ADMIN_EMAIL`。数据库结构见 `db/schema.ts`，迁移不包含商品、账户或正库存种子。

## 身份与信任边界

不自建密码、验证码、登录 Cookie 或 JWT。Sites dispatch 必须剥离客户端伪造值，再注入 `oai-authenticated-user-id` 与 `oai-authenticated-user-email`；两者齐全才识别为已登录。禁止把这个 handler 直接部署成能由外部任意设置这两个头的公开接口。若需其他托管入口，须先接入能验证身份的网关。

用户以稳定的托管 ID 为主键，邮箱仅用于初次引导和显示。新账户默认 `buyer`；数据库中的角色每次请求重新读取。首次与配置邮箱匹配的身份，通过 D1 原子 batch 和 `admin_bootstrap` 单例记录获 `admin`。后续相同邮箱的不同 ID 不会获管理权；邮箱变化不丢失已保存角色。配置为空时不引导任何管理员，明确撤销的角色也不会在后续登录时自动恢复。

管理员通过商家管理接口按登录邮箱创建档案，采购者首次以可信身份登录时，服务器原子绑定匹配的未绑定档案和稳定用户 ID，并仅在首次绑定成功时授予 `merchant`。即使档案停用也绑定身份，但不授予业务操作权限，防止退回旧角色路径。绑定后的档案邮箱不可修改；可信身份后来更换邮箱，仍按稳定 ID 管理原归属。相同邮箱的另一个稳定 ID 不会获得已绑定权限，同一 ID 不能绑定第二份档案。已绑定用户被明确撤销角色后，再次登录不会自动恢复。

`merchant` 角色本身不授予管理能力，必须同时有已绑定、启用的档案和对应权限。三个权限为 `products`（自己商品、素材、库存及当前批次）、`orders`（自己订单读取、模拟发货和内部备注）、`aftersales`（自己售后读取与处理）。`admin` 拥有全部三项并可管理所有归属；不能通过商家接口创建、升级、停用或纳管已知管理员。客户端提供角色、稳定 ID 或归属均被拒绝。档案不自动创建，也不发送邮件或邀请。

## 通用约定

- JSON 使用 UTF-8。错误为 `{ "error": { "code": "version_conflict", "message": "…" } }`，不返回 SQL、对象键、凭据或内部异常。
- 响应使用 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`，不设置跨域通配 CORS。
- 所有写入必须有与请求 URL 同源且完全匹配的 `Origin`。JSON 写入必须使用 `Content-Type: application/json`，正文上限 96 KiB。
- 常见状态：400 格式无效；401 未登录；403 无权限或 Origin 被拒；404 不存在或私有素材不可见；409 编辑冲突；413 超限；415 类型或签名不符；422 目录容量限制；503 服务或存储不可用。
- 保存失败不返回成功；503 表示未确认成功，客户端应刷新读取后再决定重试。目录最多 200 款商品、商家档案最多 200 份，金额使用整数分。

## 会话

`GET /api/v1/session`

```json
{
  "user": { "id": "托管稳定ID", "email": "example@example.test", "name": "example" },
  "role": "admin",
  "canManage": true,
  "permissions": ["products", "orders", "aftersales"],
  "merchant": null,
  "signInUrl": "/signin-with-chatgpt?return_to=%2Fadmin.html",
  "signOutUrl": "/signout-with-chatgpt?return_to=%2Fadmin.html"
}
```

未登录返回 `user: null`、`role: "anonymous"`、`canManage: false`、`permissions: []`、`merchant: null`。其他角色为 `buyer`、`merchant`、`admin`。采购者会话的 `merchant` 仅包含自己的档案 DTO；停用或无权限时 `permissions: []`、`canManage: false`。管理员始终拥有三权限，不受商家档案控制。登录和退出链接由 Sites 处理，页面使用普通顶层导航链接。读取会话可触发首次可信身份绑定，不自动生成商品或商家档案。

## 商家账号管理（V0.7）

以下接口均仅限管理员，管理邮箱对应的业务档案，不创建平台登录账户或密码。基础路径为 `/api/v1/admin/merchants`。

| 请求 | 返回与行为 |
| --- | --- |
| `GET /api/v1/admin/merchants` | `{merchants,updatedAt}`；全部至多200份，不分页 |
| `POST /api/v1/admin/merchants` | 创建成功201 `{merchant}`；不发邮件、不自动绑定 |
| `GET /api/v1/admin/merchants/:id` | `{merchant}`；不存在404 |
| `PUT /api/v1/admin/merchants/:id` | 完整替换可编辑字段，成功200 `{merchant}`，版本递增 |
| `GET /api/v1/admin/merchants/:id/audit` | `{events}`；最新50条创建、修改和首次绑定记录 |

创建请求示例：

```json
{
  "name": "景泰采购者（模拟）",
  "email": "jingtai@example.test",
  "region": "甘肃·景泰",
  "status": "enabled",
  "permissions": ["products", "orders", "aftersales"]
}
```

修改使用同样五个字段，另必带最近读取的正整数 `expectedVersion`。`name` 1–80字，`region` 1–100字，`email` 最多320字、去首尾空格并转小写且有效；字符串不接受控制字符。`status` 为 `enabled/disabled`；`permissions` 为上述三项的无重复子集，可为空。拒绝未知字段。已绑定档案不可更改邮箱，未绑定档案可修改。重复邮箱409 `merchant_duplicate`；陈旧版本409 `version_conflict`；已知管理员邮箱409 `admin_protected`；达到200份422 `merchant_limit`。

档案 DTO 为 `{id,name,email,region,status,permissions,version,createdAt,updatedAt,bound}`，其中 `id` 为 `MERCHANT-大写UUID`，`bound` 为布尔值；不暴露绑定的内部稳定 ID。审计事件为 `{id,action,createdAt,actorName,before,after}`，`action` 为 `created/updated/bound`，首次创建 `before: null`，其他为前后完整 DTO。每次创建、修改、首次绑定与审计以同一 D1 batch 事务落盘；审计保存失败会回滚主变更，不返回成功。

停用立即使该采购者失去管理权，公开目录不显示其商品，依赖其商品的公开素材引用也失效，新报价和创建订单均拒绝；下单 SQL 再检查停用状态，阻止报价后停用仍建单。旧订单及归属保留，买家仍可查看和申请售后，管理员可接手处理；重新启用后同一采购者按新权限处理旧单。已有订单的同幂等请求重放仍返回原单。停用不删除或转移商品、素材、订单，也不将账号升级为管理员。

## 商品目录

`GET /api/v1/products` 公开返回已上架且卖家未停用的商品；`GET /api/v1/admin/products` 需 `products` 权限，管理员看到全部，商家仅看到自己的商品，包含草稿与下架项。商品写入也要求 `products`，并在最终 SQL 重新检查当前角色、权限与归属。

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

## 可售库存与当前采收批次（V0.8）

库存独立于商品JSON和商品版本，每商品只有一个当前采收批次。单位为每种规格的整数“份”，保存当前还能出售的余量，不是农场总产量、重量或批次最初入库量。迁移、新建商品和初始化示例商品均不会自动产生正库存；缺少记录视为0，不能新下单。这里不是完整多批次仓库或真实库存盘点。

| 请求 | 返回与权限 |
| --- | --- |
| `GET /api/v1/inventory` | `{inventories,updatedAt}`，仅已上架且卖家未停用的商品；未配库存的商品也返回0余量DTO，不需应用登录身份 |
| `GET /api/v1/admin/inventory` | 同形状，需products权限；商家仅自己的商品，管理员全部，包含草稿、下架及未配置库存商品 |
| `PUT /api/v1/admin/inventory/:productId` | products权限及商品归属；同源写入，按库存expectedVersion创建或替换，成功200 `{inventory}` |
| `GET /api/v1/admin/inventory/:productId/history` | 同商品管理权限，返回 `{events}`，最新50条库存记录 |

列表最多与200款目录对应，不分页。这里的公开可见性仍受站点整体访问策略限制；不开放跨站CORS。没有单库存GET、库存删除或批量灌入正库存接口。未知商品或无权管理他人商品返回404，未登录管理接口401，无products权限403。

库存DTO示例：

```json
{
  "productId": "jingtai-apple",
  "configured": true,
  "stocks": {"small": 20, "family": 12},
  "batchId": "BATCH-服务端生成的大写UUID",
  "batchCode": "DEMO-JINGTAI-20261101",
  "harvestDate": "2026-11-01",
  "note": "模拟采收批次介绍，待真实货源核实。",
  "version": 1,
  "updatedAt": "ISO时间"
}
```

尚未配置返回 `configured:false`、`stocks:{small:0,family:0}`、`batchId/batchCode/harvestDate/note`均为空字符串、`version:0`、`updatedAt:null`。公开库存DTO不包含调整原因、操作人或历史。目录和库存分别读取，客户端不能将库存属性附在完整商品替换请求中保存。

写入示例：

```json
{
  "expectedVersion": 0,
  "stocks": {"small": 20, "family": 12},
  "batchCode": "DEMO-JINGTAI-20261101",
  "harvestDate": "2026-11-01",
  "note": "模拟采收批次介绍，待真实货源核实。",
  "reason": "首次设置模拟可售余量"
}
```

以上六个字段均须提供，拒绝未知字段。首次配置 `expectedVersion:0`；已有记录使用最近读取的库存版本，须为小于 `Number.MAX_SAFE_INTEGER` 的非负安全整数。`stocks`必须恰好包含small、family，每项为0–999999整数；`batchCode`去首尾空格后1–80字；`harvestDate`为空或有效的YYYY-MM-DD；`note`最多300字；`reason`去首尾空格后1–200字。字符串不接受控制字符。无效数量400 `stock_invalid`，无效批次字段400 `inventory_invalid`，版本格式错误400 `version_invalid`；陈旧版本、在途权限或归属变化409 `version_conflict`。

首次配置、批次编号或采收日期变化生成新的 `batchId`；只改库存和介绍保留原批次标识。人工调整与库存记录在同一D1 batch事务内落盘，最终SQL再次检查当前products权限、启用状态、归属和版本。失败整体回滚，不返回保存成功。人工调整、订单扣减或回补均递增库存版本，商品版本不因此改变。取消回补可能使返回余量超过999999，读取不得截断；数据库仍限制为安全非负整数，人工写入上限保持不变。

库存记录事件为 `{id,productId,action,reason,orderId,actorName,createdAt,before,after}`，其中 `action` 为 `adjusted`（人工设置）、`reserved`（模拟下单扣减）、`released`（取消回补）、`release_review`（取消需人工核对）。`orderId`人工调整时null，其他为关联订单编号；首次设置before为null，否则before／after为完整库存DTO。历史只允许该商品管理者读取，不向买家公开，不开放删除。

## 上传素材

`POST /api/v1/media?kind=image` 或 `?kind=video`，需 `products` 权限，同源 `Origin`，正文为文件原始字节，非 multipart。文件接收期间权限被撤销时，元数据不落盘并尝试清理对象。

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

素材被至少一个未停用卖家的已发布商品引用时可公开读取；否则仅有 `products` 权限的归属上传者或管理员能读取。权限检查在 Range 处理前执行，匿名或他人不能通过 HEAD、416 长度或分段请求探测草稿素材。商品下架或卖家停用且没有其他有效公开引用后，素材重新变为私有。

响应使用数据库已验证的 MIME、`nosniff`、`private, no-store`。GET 支持单段 `bytes=start-end`、开放结尾和后缀 Range，成功 206 附 `Content-Range`；越界或无效单段返回 416 和 `Content-Range: bytes */总长`。多段或未知单位回退完整 200；不匹配的 `If-Range` 回退完整内容。HEAD 无正文，描述完整长度并忽略 Range，不绕过权限。R2 对象必须存在且长度与登记记录一致。

## 云端模拟订单与售后（V0.6，V0.8加入库存）

以下接口均需受信登录身份。买家接口只访问当前用户的订单（管理员身份调用买家接口也不能读取他人的订单）；管理读取需 `orders` 或 `aftersales` 权限，管理员可读全部，商家只读其 seller_id 订单。仅有 `aftersales` 时，列表和详情只读已有 `afterSale` 的订单，无售后订单统一404；无需额外 scope 参数。未知或他人的订单统一404，匿名401、无所需权限调用后台403。买家响应不包含内部 `merchantNote`，也不包含买卖双方的稳定内部ID。

`GET /api/v1/orders`、`GET /api/v1/admin/orders` 返回 `{orders, updatedAt, nextCursor}`。每页最多100笔，按创建时间和编号降序；有后续页时将返回的游标原样URL编码传入 `?cursor=...`。`GET` 同一路径下 `/:id` 返回 `{order}`。所有读取均不缓存。

`POST /api/v1/orders/quote`：

```json
{"items":[{"productId":"jingtai-apple","variant":"small","quantity":1}],"address":"gansu"}
```

返回 `{quote:{items,quantity,subtotal,shipping,total,address,productVersions,inventoryVersions}}`，其中items为服务端商品快照，另含每项 `batchId/batchCode/harvestDate/batchNote`。address为地区ID，productVersions与inventoryVersions分别为商品ID到当前商品版本和库存版本的映射。报价只读，不预留或扣减库存；随后创建订单仍可能因其他买家抢先下单而失败。每单1–12种规格，每规格1–10份，不允许重复行。只支持 `gansu`、`shaanxi` 示例地区，模拟运费分别为600分、1000分；不收集真实地址。商品须已发布且卖家未停用，所选规格须已配置足够可售余量；未配置或不足返回409 `stock_insufficient`，商品不存在／下架返回409 `product_unavailable`。跨商家组合返回422 `mixed_merchants`，请分开下单。

`POST /api/v1/orders` 接收同样的items/address，并增加：

```json
{
  "items":[{"productId":"jingtai-apple","variant":"small","quantity":1}],
  "address":"gansu",
  "expectedTotal":5480,
  "productVersions":{"jingtai-apple":3},
  "inventoryVersions":{"jingtai-apple":1},
  "idempotencyKey":"ORDER-客户端生成的唯一UUID"
}
```

金额和版本仅为请求示例，实际从quote响应取得。新单必须带有与所选商品ID一一对应的productVersions和inventoryVersions，不能漏项或多项；库存版本为1至小于安全整数上限的整数。缺失或无效库存版本400 `quote_invalid`。客户端不能指定订单ID、归属、状态、批次或价格。

服务端重新读取当前商品与库存计算快照。当前库存不足可返回409 `stock_insufficient`；商品、库存版本或报价金额变化返回409 `quote_changed`，需要重新获取报价和确认，不静默按新价或新批次提交。建单在D1 batch中先用 `INSERT SELECT` 再次核对全部商品版本、归属、上架、卖家状态、库存版本及每规格余量，再仅对本次新订单编号扣减并记录库存事件，任一失败整单回滚。这个最终条件同时防止报价后停用、换批次或其他下单造成卖超。

创建成功201 `{order,replayed:false}`。同买家+同幂等键+同规范化参数重试返回200 `{order,replayed:true}`，即使商品随后下架、卖家停用或库存不足，也返回原订单，不重复扣减。参数指纹包含库存版本；同键不同参数409 `idempotency_conflict`。失败响应或响应丢失时保留原请求重试，不自动更换key。

兼容升级前的旧幂等重放：没有inventoryVersions的请求，只能在当前买家已存在同key且旧规范化请求指纹完全一致时返回原单；不要求先通过当前库存检查，也不追加库存扣减。若同key已有新格式请求或其他参数不同，则409；没有历史匹配订单则400 `quote_invalid`，不能借兼容路径创建绕过库存的新单。不要给旧重试请求擅自补新库存版本或换key。

订单保留下单时名称、图片引用、规格、单价、数量、运费、合计、示例地区、时间及每项批次编号、稳定批次ID、采收日期和介绍；编号为 `DEMO-大写UUID`，另带 `version`、`updatedAt`。主状态 `created/cancelled`，发货位于 `fulfillment`，当前售后位于 `afterSale`。`afterSaleHistory` 追加每次申请、撤回和处理后的完整售后快照（同一售后ID可有多个状态），不覆盖历史。库存扣减只用于模拟订单，没有支付状态、真实运单或实际退款。

| POST 路径 | 正文字段（均必带expectedVersion） | 权限及行为 |
| --- | --- | --- |
| `/api/v1/orders/:id/cancel` | `expectedVersion` | 本人取消未发货、无待售后、未完成整单退款的订单；库存规则见下文 |
| `/api/v1/orders/:id/aftersale` | `expectedVersion,type,reason,description,hasEvidence` | 本人申请；type为refund/replacement；reason为damaged/spec/delivery/other；description最多300字；hasEvidence为模拟凭证布尔值，不上传真实凭证 |
| `/api/v1/orders/:id/aftersale/withdraw` | `expectedVersion` | 本人撤回待处理售后 |
| `/api/v1/admin/orders/:id/ship` | `expectedVersion,carrier,tracking` | `orders`权限，模拟发货；carrier最多40字，tracking必须为DEMO-开头演示单号 |
| `/api/v1/admin/orders/:id/note` | `expectedVersion,note` | `orders`权限，保存最多300字内部备注 |
| `/api/v1/admin/orders/:id/aftersale/resolve` | `expectedVersion,reply` | `aftersales`权限，处理待售后；reply最多300字，买家可见，不发生退款或补发 |

成功均返回 `{order}` 并递增版本；SQL按 `id+expectedVersion+归属` 条件原子更新，管理写入同时再次检查当前角色、启用状态和动作权限。陈旧版本409 `version_conflict`，不允许静默覆盖；非法状态409 `order_state_invalid`。已取消、重复发货、待处理售后或整单模拟退款完成的订单均不能发货；退款完成后不能再次申请或取消。售后历史达到100条后不再接受新申请，但仍可处理已有待办。没有云端清空/删除/自动样例订单接口。

### 取消时的整单回补

新订单若含完整库存批次快照，成功取消返回的order会增加 `stockRelease:{status,message}`：

- `status:"released"`：全单所有商品仍匹配下单批次，且余量与版本可在安全整数范围内增加；一次性整单回补原规格份数，并写released记录。
- `status:"review"`：任一商品已换批次或安全范围需要核对。取消仍成功，但整单不自动回补任何商品，记录release_review并提示采购者核对。不是只跳过换批次商品再回补其余商品。

订单版本更新、唯一回补标记、库存增量和记录位于同一事务，失败整体回滚。并发的相同expectedVersion取消只有一次成功，失败者不能凭“订单已经是下一版”重复回补。内部回补标记不出现在API响应；使用者只读取stockRelease提示，不把message当作实际物流或退款凭证。

没有库存批次快照的历史订单取消仍保留原行为，不新增库存、不生成伪造回补。售后申请、撤回、退款处理及补发处理均不自动回库。待核对的实物数量由有products权限的采购者或管理员核实，再通过库存PUT人工调整并填写原因；本轮没有自动恢复历史批次、部分回补或完整仓储流程。

## 验证范围

`tests/cloud-api.test.mjs` 将真实 `drizzle/*.sql` 迁移应用到 Node SQLite，再以薄 D1 适配层调用同一个 handler；R2 用内存对象存储适配，测试字节为自有临时数据。覆盖管理员首次引导、角色撤销、并发版本、数据库约束、跨账户拒绝、上传签名/大小/流取消、失败清理及素材可见性与 Range。

这些自动化测试不替代 Sites dispatch、真实 D1/R2、托管登录或手机实际文件上传/播放验收。云端商品和素材的跨设备联动应在部署后单独验证；V0.6 订单使用 D1 独立持久化，真实手机交互仍需单独验收。

V0.7 的 `tests/merchant-api.test.mjs` 使用同一批真实 SQLite 迁移，覆盖商家增改与管理员保护、稳定身份绑定竞争、角色撤销、权限组合、跨采购者隔离、停用与旧单保留、报价后停用、最终写权限检查及审计故障事务回滚。`scripts/smoke-merchants-local.mjs` 可检查实际本机 Worker；只接受 HTTP 回环地址，使用模拟身份和模拟资料，不能用于托管身份或真实手机验收。


V0.8 `tests/inventory-api.test.mjs`使用真实迁移与SQLite适配器核对库存字段、归属及products权限、当前批次生成、版本冲突、人工记录事务、原子下单／幂等扣减、同批次取消回补及换批次整单review。控制器与store测试另覆盖未配置0、模拟仅填表、库存变动后的表单冲突和权限收缩旧响应隔离。以上是源码与自动化范围，不代表生产登录后的完整操作或真实手机验收，实际结果以本轮QA记录为准。
