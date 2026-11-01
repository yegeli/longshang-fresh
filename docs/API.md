# 云端目录与素材 API

本阶段只实现托管身份、角色、商品目录和素材。订单、购物车、发货、售后仍是本浏览器模拟数据，不跨设备共享，也没有支付或真实物流接口。`/api/v1/orders` 返回 404。

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

## 验证范围

`tests/cloud-api.test.mjs` 将真实 `drizzle/*.sql` 迁移应用到 Node SQLite，再以薄 D1 适配层调用同一个 handler；R2 用内存对象存储适配，测试字节为自有临时数据。覆盖管理员首次引导、角色撤销、并发版本、数据库约束、跨账户拒绝、上传签名/大小/流取消、失败清理及素材可见性与 Range。

这些自动化测试不替代 Sites dispatch、真实 D1/R2、托管登录或手机实际文件上传/播放验收。云端商品和素材的跨设备联动应在部署后单独验证；当前阶段不得声称订单也已云同步。
