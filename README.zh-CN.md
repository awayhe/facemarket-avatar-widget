# facemarket-avatar-widget

一个基于 [FaceMarket](https://facemarket.ai) 的实时数字人视频通话自托管集
成方案：一个单独的 Node/Express 服务端，代理 FaceMarket 的平台接口（保证
API key 永远不会到达浏览器），再加上一个可复用、可嵌入、不依赖任何前端框
架的 `FaceMarketWidget` UI 组件，基于 `@sanseng/liveavatar-js-sdk` 的
Direct Mode 构建。

English version: [`README.md`](./README.md)

## 项目包含什么

- **后端**（`index.js`）—— 一个 Express 进程，一个端口。代理 FaceMarket 的
  avatar 列表和 session 开始/结束接口，统一响应格式，按调用方做限流和
  session 记录，同时也负责发前端（开发模式：Vite 中间件 + HMR；生产模式：
  预编译好的静态文件）。
- **`FaceMarketWidget`**（`web/src/FaceMarketWidget.js`）—— 一个自包含的视
  频通话 UI（avatar 选择器、通话中控制按钮、支持手动回看的实时字幕、聊天
  记录、深链接），渲染在 Shadow DOM 里，可以直接嵌入任何页面而不会有 CSS
  冲突。完整 API 参见
  [`web/docs/FaceMarketWidget.zh-CN.md`](web/docs/FaceMarketWidget.zh-CN.md)。
- **Demo 页面** —— `web/src/main.js`（全屏应用）和 `web/demo.html` +
  `web/src/demo.js`（widget 嵌在页面里一个小盒子里，页面自己管理 avatar
  选择）。

正式承接生产流量之前，有几个已知的局限性值得先了解一下——见
[`docs/api.zh-CN.md`](docs/api.zh-CN.md) 的"已知的局限性"一节（没有调用方
身份认证、状态存在内存里）。

## 环境要求

- Node.js 18+（用到了原生 `fetch`）。
- 一个 FaceMarket 账号和 API key。

## 快速开始

```bash
npm install
cp .env.example .env   # 然后填入 FACEMARKET_API_KEY
npm run dev
```

打开终端里打印出来的 `http://localhost:8787`——前端和后端都在这一个进程
里，开发模式下 HMR 完整可用。

其他命令：

```bash
npm run build   # 把前端编译到 web/dist/
npm start       # NODE_ENV=production node index.js —— 要先跑过 build
```

## 配置

全部通过项目根目录的 `.env` 文件配置（参见 `.env.example`）：

| 变量 | 是否必填 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `FACEMARKET_API_KEY` | 是 | — | 只在服务端使用，永远不会发给浏览器。 |
| `FACEMARKET_BASE_URL` | 否 | `https://facemarket.ai/vih/dispatcher` | FaceMarket dispatcher 服务的地址。 |
| `PORT` | 否 | `8787` | 整个 app 监听的唯一端口。 |
| `TRUST_PROXY` | 否 | 不设置 | 部署在反向代理后面时才需要设置——见 [`docs/nginx.zh-CN.md`](docs/nginx.zh-CN.md)。 |
| `BASE_PATH` | 否 | 不设置（挂载在根路径） | 把整个 app 挂载到某个路径前缀下，比如 `/liveavatar`——见 [`docs/nginx.zh-CN.md`](docs/nginx.zh-CN.md)。 |

## 文档

- [`docs/api.zh-CN.md`](docs/api.zh-CN.md)（[English](docs/api.md)）—— 后端
  HTTP API / 通讯协议完整说明。
- [`web/docs/FaceMarketWidget.zh-CN.md`](web/docs/FaceMarketWidget.zh-CN.md)
  （[English](web/docs/FaceMarketWidget.md)）—— widget 组件的完整构造参数
  和实例方法说明。
- [`docs/nginx.zh-CN.md`](docs/nginx.zh-CN.md)（[English](docs/nginx.md)）——
  反向代理部署说明，配套的可直接复制使用的配置片段在
  [`docs/nginx/`](docs/nginx/)。
- [`CLAUDE.md`](CLAUDE.md) —— 给要在这个代码库上做开发的人看的架构说明和
  实现细节。
- [`plans/adaptive-leaping-fairy.md`](plans/adaptive-leaping-fairy.md) —— 最
  初的设计思路，包括为什么选了 Direct Mode 而不是 FaceMarket 那个没有公开
  文档的 Auth Mode token 接口。
