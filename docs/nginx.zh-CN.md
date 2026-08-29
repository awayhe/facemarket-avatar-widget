# 反向代理配置（nginx）

这个 app 是一个单独的 Node/Express 进程，前端和 API 都跑在同一个端口上
（`PORT`，默认 `8787`，参见 [`api.zh-CN.md`](./api.zh-CN.md)）。把它放到
nginx 后面，主要就是两件事：决定它挂在你域名的哪个位置，以及（生产环境
下）让 nginx 直接把编译好的静态文件发出去，而不是全部代理给 Node。

English version: [`nginx.md`](./nginx.md)

真正可以直接复制粘贴用的配置片段都在 [`docs/nginx/`](./nginx/) 目录下——
它们是设计成 `include` 进你**自己已有**的 nginx 配置里的，不是拿来当一份
独立完整的 `nginx.conf` 用。本文档解释这些配置背后的思路，以及该用哪一个。

## 核心思路：`BASE_PATH`

这里所有东西都建立在一个环境变量上：`BASE_PATH`（见 `.env.example`）。设
置成一个路径前缀（比如 `BASE_PATH=/liveavatar`），app **自己**（不是靠
nginx）就会知道自己挂在这个路径下：

- `index.js` 会把每个 API 路由挂到 `<BASE_PATH>/api/...` 而不是
  `/api/...`，前端也是从 `<BASE_PATH>/` 而不是 `/` 提供服务。
- `web/vite.config.js` 读的是同一个变量来设置构建时的 `base`，所以编译出
  来的资源 URL（`<script>` 标签等）也会带上 `<BASE_PATH>` 前缀。
- 本仓库自带的 demo（`web/src/main.js`）也会读这个值（通过 Vite 在构建时
  注入的一个常量），用来设置 widget 的 `apiBaseUrl`/`basePath` 选项，让它
  们保持一致。

只需要配一次，后端路由、编译出来的前端、demo 页面就会自动保持一致——不用
再手动改三个地方、还要自己保证它们没配错、没配漏。这对 nginx 那边的实际
好处是：**完全不需要做路径改写**。下面每一份配置都是纯透传
（`proxy_pass http://liveavatar_backend;`，不带任何 URI 部分），因为 app
自己已经知道会收到什么样的路径。

不设置 `BASE_PATH` 就是默认行为：整个 app 挂在你域名的根路径下。

## 该用哪个文件？

| 你的场景 | 用哪个文件 |
| --- | --- |
| app 独占整个域名根路径（自己的子域名，或者这个域名上没跑别的东西）；开发模式（`npm run dev`） | [`location.conf`](./nginx/location.conf) |
| app 独占根路径；生产构建（`npm run build` + `npm start`） | 在 [`location-static.conf`](./nginx/location-static.conf) 基础上改一下：`alias` 换成 `root`，`location` 路径里去掉 `/liveavatar` 前缀 |
| app 挂在某个路径前缀下（比如 `/liveavatar`），域名上其他地方是空的；开发模式 | [`location-app-prefix.conf`](./nginx/location-app-prefix.conf) |
| 同上，但是生产构建 | [`location-static.conf`](./nginx/location-static.conf)——nginx 直接把 `web/dist/` 发出去，只有 `/liveavatar/api/*` 才会打到 Node |
| 只想把**这个 widget 组件**嵌入到一个已经有自己的 `/`（很可能也有自己的 `/api/*`）的现有网站里——不是嵌整个 app | [`location-api-prefix.conf`](./nginx/location-api-prefix.conf)——只暴露 API，挂在一个不会冲突的前缀下 |

除了 API-only 那个不需要之外，其余每个都需要先在 `http {}` 层级 include
一次 [`upstream.conf`](./nginx/upstream.conf)——具体位置见那个文件自己的
注释。

每个文件里都有详细的行内注释，上面这张表只是个索引。

## 为什么开发和生产要用不同的文件

`npm run dev` 是在同一个 Express 进程里跑 Vite 的开发中间件——每一个请求
（哪怕只是一个 `.js` 文件）都是实时转换出来的，需要一个活着的 Node 进程
才能处理，所以 nginx 只能全部代理过去（对应 `location.conf` /
`location-app-prefix.conf`）。

`npm run build` + `npm start` 会在 `web/dist/` 下产出纯静态文件。这时候让
nginx 直接把它们发出去（`location-static.conf`，用 `alias` + `try_files`）
比继续代理给 Node 要好得多——Node 进程负载更小，而且 nginx 本来就更擅长
发静态文件。只有真正的 API 请求（`/api/*`）才还需要打到后端进程。

## `TRUST_PROXY`

`POST /api/session/start` 的限流、以及 session 重连的记录表，用的都是调
用方的 IP（`req.ip`——见 [`api.zh-CN.md`](./api.zh-CN.md) 的"限流"一节）。
在反向代理后面，Express 默认看到的是代理自己的 IP，除非明确告诉它要信任
代理传过来的 `X-Forwarded-For` 头。在 app 的 `.env` 里设置：

```
TRUST_PROXY=1
```

（"1" 表示信任前面正好一跳，也就是这个 nginx。）**如果 app 有可能被直接
裸跑、前面什么代理都没有，就不要设置这个值**——没有真实代理的情况下信任
转发头，会让任何客户端伪造自己的 IP，把限流完全绕过去。`docs/nginx/` 下
每份配置都已经设置了 `X-Forwarded-For`/`X-Real-IP`/`X-Forwarded-Proto` 这
些头；这个环境变量是另一半——nginx 单方面发了这些头，app 不被告知要信任
它们的话也没有用。

## 这里故意没有代理的东西

真正的通话音视频/信令完全不经过这个 app 或者这份 nginx 配置。
`POST /api/session/start` 返回的 `sfuUrl`（`wss://...`）是浏览器**直接**
连接的——直连 FaceMarket 的 SFU。所以这里的配置完全不需要（也不应该有）
任何 WebRTC/媒体相关的处理逻辑；它只会承载普通的 HTTP 请求/响应流量，外
加（开发模式下）Vite 自己的 HMR websocket。

## 本地测试

如果想在部署前先在本机 nginx 上试一下这些配置，搭建这些文件时用的方法
是：自己开一个 `server { listen 8081; ... }` 的新 server block（用一个不
会跟现有 nginx 服务冲突的端口），include 上面对应的文件，`nginx -t` 验证
语法，`nginx -s reload`，然后直接访问这个端口测试——不需要动 80/443 端口
或者任何现有配置，边试边改也很安全。
