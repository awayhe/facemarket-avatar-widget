# 服务端 API（通讯协议）

本文档描述项目唯一的 Express 服务器（仓库根目录的 `index.js`）对外暴露的
HTTP API。它是 FaceMarket 平台 API 前面的一层薄代理——存在的目的是让
`FACEMARKET_API_KEY` 永远不会到达浏览器，同时让前端不需要了解 FaceMarket
接口实际的字段格式。

English version: [`api.md`](./api.md)

要把它部署到 nginx 后面？参见 [`nginx.zh-CN.md`](./nginx.zh-CN.md)（或英文
版 [`nginx.md`](./nginx.md)），包含反向代理的配置方式，也包括下面提到的
`BASE_PATH` 选项。

## 基础地址

前端和后端同源——一个进程、一个端口（`PORT`，默认 `8787`）。没有任何 CORS
中间件：服务器不返回任何 `Access-Control-*` 响应头，所以只有同源请求才能
成功，浏览器会直接拦截跨域的 `fetch()`。如果以后确实需要让某个特定合作方
域名跨域调用（例如 widget 的 `apiBaseUrl` 指向另一个后端），应该在服务端加
一个明确的域名白名单，而不是反射任意 `Origin`。

### 挂载路径前缀（`BASE_PATH`）

默认情况下，下面每个接口都挂在文档里写的路径上（`/api/avatars` 等）——
整个 app 挂载在你域名的根路径下。设置 `BASE_PATH` 环境变量（比如
`BASE_PATH=/liveavatar`），可以把整个 app（API 和前端页面）一起挂到某个
路径前缀下面——本文档里的每个接口都会相应地变成
`<BASE_PATH>/api/...`。这跟 `web/vite.config.js` 构建资源 URL、以及本仓库
自带 demo（`web/src/main.js`）设置 `apiBaseUrl`/`basePath` 用的是**同一个**
环境变量——只需要配一次，后端路由、编译出来的前端产物、demo 页面就会自动
保持一致。这个前缀和反向代理如何配合，见
[`nginx.zh-CN.md`](./nginx.zh-CN.md)。

前缀之外的请求（比如设置了 `BASE_PATH=/liveavatar` 时访问裸的
`/api/avatars`）会得到一个正常的 `404`——不会落到前端兜底路由，也不会返回
别的接口的内容。

## 约定

- 所有请求体/响应体都是 JSON（`Content-Type: application/json`）。
- 错误响应统一是 `{ "error": string, ...extra }`。代理 FaceMarket 报错时会
  额外带上 `status`（FaceMarket 自己的 HTTP 状态码）和 `detail`
  （FaceMarket 原始响应体，能解析为 JSON 就解析，不能就原样透传）。
- 每个接口都会把 FaceMarket 的响应改写成下文这套固定格式（比如
  `avatarId` → `id`，把 `data`/`records` 这层包装拆掉）——这是故意的设
  计，让前端跟这台服务器之间有一个稳定的约定，不管 FaceMarket 自己怎么命
  名字段、以后会不会改。FaceMarket 实际用的字段名是通过两个来源确认的：
  avatar 相关接口对照了它公开的
  [Avatar User V2 接口文档](https://doc.facemarket.ai/docs/API%20Reference/)
  （`avatarId`/`avatarName`/`avatarDesc`/`cover`，列表包在 `data.records`
  里）；`/v1/session/start`（这个公开文档里没有）则是通过读
  `@sanseng/liveavatar-js-sdk` 编译产物里的代码确认的——它的"auth mode"
  调用的正是同一个 dispatcher 接口，解析的是
  `{ code, msg, data: { sessionId, sfuUrl, userToken } }`（`code === 0`
  表示成功），这台服务器现在也是这么检查的（见下面的
  `POST /api/session/start`）。

  > FaceMarket 的响应格式也不代表以后一定不会变——上面这些只是**截至目
  > 前**通过外部渠道确认过的结果，并不是 FaceMarket 跟我们有正式的格式约
  > 定。注意这跟"格式不稳定"不是一回事：不是说它今天这样明天那样，只是长
  > 期来看这台服务器对这个格式没有任何保证。

## 接口列表

### `GET /api/avatars`

列出这台服务器的 `FACEMARKET_API_KEY` 下所有可用的 avatar。

**响应 `200`**
```json
{
  "avatars": [
    { "id": "avatar_...", "name": "Clara", "description": "...", "cover": "https://..." }
  ]
}
```

**响应 `502`** —— 调用 FaceMarket 列表接口失败：
```json
{ "error": "Failed to list avatars", "status": 500, "detail": { "...": "..." } }
```

**响应 `500`** —— 服务端内部未预期的错误。

---

### `GET /api/avatars/:avatarId`

查询单个 avatar，用于可分享的 `/avatar/<id>` 深链接场景，这样页面不需要
先拉全部列表才能显示一个 avatar。

**响应 `200`**
```json
{ "id": "avatar_...", "name": "Clara", "description": "...", "cover": "https://..." }
```

**响应 `404`** —— `avatarId` 不存在。
> FaceMarket 自己对未知 avatarId 返回的是 HTTP `200` + 一个空的/没有 name
> 字段的响应体，而不是真正的 `404`。这台服务器会自己识别这种情况（响应里
> 缺少 `id`/`name`）并转换成标准的 `404`，客户端不需要单独处理 FaceMarket
> 这个特殊行为。

**响应 `502` / `500`** —— 格式同上。

---

### `POST /api/session/start`

为指定 avatar 创建一个 FaceMarket session（SFU 连接信息），让浏览器能以
**Direct Mode** 直接入会——浏览器全程看不到 `FACEMARKET_API_KEY`。

**请求体**
```json
{ "avatarId": "avatar_..." }
```

**响应 `200`**
```json
{
  "sessionId": "9f6f366e4c804918",
  "sfuUrl": "wss://....livekit.cloud",
  "userToken": "eyJhbGciOi..."
}
```
如果调用方的 IP 之前已经为同一个 `avatarId` 记录过一个 session（见下面的
[Session 记录](#session-记录--重连行为)），会先把旧的那个停掉，再正常开
新的——返回的永远是新 session 的信息，不存在"已经在通话中"这种需要单独处
理的错误。

**响应 `400`** —— 缺少 `avatarId`：
```json
{ "error": "Missing avatarId" }
```

**响应 `429`** —— 触发限流（见下方 [限流](#限流)）：
```json
{ "error": "Too many session requests from this network — try again in a minute." }
```

**响应 `502`** —— 有三种可能，都会在服务端日志里记录 FaceMarket 的原始响
应方便排查：
- 调用 FaceMarket 的 HTTP 请求本身失败了（非 2xx 状态码）。
- FaceMarket 返回了 `200`，但响应体里带着业务层面的错误——
  `{ "code": N, "msg": "..." }`，`N !== 0`（这个接口即使 HTTP 层面成功，
  也会把结果包一层 `{ code, msg, data }`；`code` 非 0 是单靠
  `response.ok` 抓不到的业务层错误）。FaceMarket 给的 `msg` 会原样透传成
  `error`，同时带上 `code` 字段。
- 响应看起来是成功的，但缺少 `sfuUrl`/`userToken`。

**响应 `500`** —— 服务端内部未预期的错误。

---

### `POST /api/session/stop`

尽力而为地释放一个 FaceMarket session。不管上游调用 FaceMarket 是否成功，
始终返回 `200 { "ok": true }`——失败只会记录在服务端日志里，不会透传给调
用方，因为不管怎样客户端都是要挂断的。

**请求体**
```json
{ "sessionId": "9f6f366e4c804918" }
```

如果这个 `sessionId` 匹配一条记录中的 session（见下方），对应的记录也会
一并清掉。

## Session 记录 / 重连行为

服务端在内存里维护一个从 `(调用方 IP, avatarId)` 到"最近一次为这个组合创
建的 session"的小映射表。这**不是**一个锁——它从不拒绝任何请求，只是用来
决定 `POST /api/session/start` 要不要先停掉一个旧的 session：

- **同一个 avatar、同一个 IP、已经有记录的 session** → 先把旧的停掉（尽力
  而为地调用 FaceMarket），再正常开新的。这正是"刷新页面能正常工作"的原
  因：浏览器为同一个 avatar 再次调用 `session/start`，只会顶替掉自己之前
  的 session，而不会报错。
- **不同的 avatar，或者不同的 IP** → 各自独立开始，不会影响别的记录。

每条记录如果一直没人调用 `session/stop`（关闭标签页、崩溃、断网），会在
**30 分钟**后自动过期——这纯粹是为了防止这张表无限增长占内存，不是功能上
的必需；一条已经过期但没被清理的记录不会挡住或搞坏任何东西，最多就是下一
次 `session/start` 时，对一个其实早就自然结束了的 FaceMarket session 多发
一次没什么用的（失败了也会被忽略的）停止请求。

> **历史**：早期版本这个接口用一个 `lac_id` cookie 来做**硬性拒绝**——如
> 果同一浏览器已经有一通活跃通话，第二次 `session/start` 会直接返回
> `409`。后来去掉了：因为普通的页面刷新根本不会调用 `session/stop`（没有
> `beforeunload` 监听，而且刷新后 cookie 还在），一次很正常的刷新就可能把
> 一个浏览器卡在"无法开始新通话"里，卡到那个锁自己的 TTL 到期为止，界面上
> 也没有任何办法自己恢复。上面这套"按 IP+avatarId 顶替而不是拒绝"的行为就
> 是用来替代它的。

## 限流

`POST /api/session/start` 限制为**每个 IP 地址每分钟最多 6 次请求**
（`express-rate-limit`，时间窗口 `60` 秒）——这才是真正意义上防刷量/防成
本滥用的机制（上面那套 session 记录只是重连时的便利功能，不是安全边界）。
响应里会带标准的限流响应头：

```
RateLimit-Policy: 6;w=60
RateLimit-Limit: 6
RateLimit-Remaining: 4
RateLimit-Reset: 60
```

一旦触发限流，`429` 响应还会额外带一个 `Retry-After`（距离窗口重置还有多
少秒）。

`POST /api/session/stop`、`GET /api/avatars`、`GET /api/avatars/:id` **不**
受限流限制。

上面的限流和 session 记录的 key，用的都是调用方的 IP（`req.ip`）。如果这
个 app 部署在反向代理后面，需要设置 `TRUST_PROXY`（见 `.env.example`），
这样 `req.ip` 才能反映真实访客的 IP，而不是代理自己的地址——见
[`nginx.zh-CN.md`](./nginx.zh-CN.md)。

## 已知的局限性（都是有意为之的设计选择）

- **没有调用方身份认证。** 任何能访问到这台服务器的人都能调用所有接口——
  限流能降低滥用的规模，但并不能验证"到底是谁在调用"。如果要接入一个真正
  有登录体系的产品，正式上线前应该在创建 FaceMarket session 之前先校验调
  用方自己的登录状态（参见 `index.js` 里 `POST /api/session/start` 上方的
  `TODO` 注释）。
- **状态保存在内存里。** Session 记录表（`activeSessionByIpAndAvatar`）和
  限流计数器都只存在于当前这一个 Node 进程的内存中。如果以后要在负载均衡
  后面跑多个实例，这部分状态需要挪到一个共享存储（比如 Redis）里，才能在
  多实例之间保持正确。
