# FaceMarketWidget

一个自包含、可嵌入的 FaceMarket 数字人实时视频通话 UI 组件。它渲染在一个
[Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)
子树里，所以它的样式永远不会泄漏到宿主页面（也不会被宿主页面的样式影
响）——可以直接把它放进任何现有页面，不会有 CSS 冲突。

源码：`web/src/FaceMarketWidget.js`。示例用法：`web/src/main.js`。

English version: [`FaceMarketWidget.md`](./FaceMarketWidget.md)

## 包含的功能

- 一个 avatar 选择器（从后端拉取的 avatar 网格列表），或者当直接链接到某
  一个 avatar 时显示单个 avatar 的"拨号"界面。
- 一个全屏通话中 UI：静音、文字聊天输入、实时字幕、打断、挂断，以及一个
  可滑出的聊天记录抽屉。
- 一个"会话意外结束"弹窗，带一键重连，只有在通话不是用户自己挂断、而是
  意外掉线时才会出现。

## 依赖要求

这个组件需要配合一个实现了本仓库 API 约定的后端（参见项目根目录的
`index.js`，完整协议见 [`docs/api.zh-CN.md`](../../docs/api.zh-CN.md)）：

- `GET /api/avatars` → `{ avatars: [{ id, name, description, cover }] }`
- `GET /api/avatars/:id` → `{ id, name, description, cover }`
- `POST /api/session/start`（请求体 `{ avatarId }`）→ `{ sessionId, sfuUrl, userToken }`
- `POST /api/session/stop`（请求体 `{ sessionId }`）

默认情况下这些请求都是同源的相对路径；如果要指向不同的后端，用下面的
`apiBaseUrl` 选项。

## 快速开始

```js
import { FaceMarketWidget } from "./FaceMarketWidget.js";

// 下面每一项都写成了它的默认值，方便对照。
const widget = new FaceMarketWidget("#app", {
  avatarId: null,
  buttons: { mic: true, keyboard: true, captions: true, interrupt: true, disconnect: true, chatToggle: true, share: true },
  captionScrollSpeed: 1,
  manageUrl: false,
  autoLoadPicker: true,
  apiBaseUrl: "",
  basePath: "",
});
```

`#app` 应该是一个由宿主页面自己控制大小的元素（组件本身会撑满其宽高的
100%——它**不会**假设自己独占整个浏览器视口）。如果要做成全屏效果，自己
给这个容器设置尺寸即可，例如：

```css
#app { position: fixed; inset: 0; }
```

## `new FaceMarketWidget(target, options?)`

| 参数      | 类型                  | 说明                                                                 |
| --------- | --------------------- | ----------------------------------------------------------------------------- |
| `target`  | `Element \| string`   | 要渲染进去的容器，或者一个会通过 `document.querySelector` 解析的 CSS 选择器。必填。 |
| `options` | `object`              | 可选的 JSON 配置，见下方。传入的对象会和默认值做合并——只需要写你想改的那部分即可。 |

构造是同步的，调用后立即挂载；avatar 列表（或者深链接指定的单个 avatar）
会异步加载。

### 配置项

```ts
{
  // 直接初始化到指定 avatar 的拨号界面（"点击拨打"状态），效果和打开一个
  // "/avatar/<id>" 深链接一样——用于宿主页面只会嵌入某一个固定 avatar 的
  // 常见场景，这样就不用在构造之后自己再调用 showAvatar()/callAvatar()。
  // 优先级高于当前 URL 路径和 autoLoadPicker。默认 null，保持原来的启动
  // 行为不变（选择器网格，或基于 URL 的深链接）。
  avatarId: string | null,

  // 控制条/顶部栏要渲染哪些按钮。每一项默认都是 true。
  buttons: {
    mic: boolean,          // 静音/取消静音开关
    keyboard: boolean,     // 切换到文字输入模式
    captions: boolean,     // 实时字幕条以及它的开关按钮
    interrupt: boolean,    // 打断 avatar 正在说的话
    disconnect: boolean,   // 挂断按钮
    chatToggle: boolean,   // 聊天记录抽屉以及它的开关按钮
    share: boolean,        // 选择器卡片/拨号界面上的"复制该 avatar 链接"按钮
  },

  // 应用在字幕滚动速度上的倍率。
  // 1 = 默认速度（英文约 150 词/分钟，中日韩文字约 300 字/分钟），
  // 2 = 两倍速（每行停留更短），0.5 = 半速。必须 > 0。
  captionScrollSpeed: number,

  // 组件是否会在加载时读取页面 URL 里的 "/avatar/<id>"，并且在用户在组件
  // 内部导航时更新 URL/history/文档标题（通过 history.pushState——不会整
  // 页刷新）。默认关闭，因为大多数嵌入场景下组件只是一个更大页面的一部
  // 分，路由/标题应该由宿主页面自己掌控——如果这个组件要独占整个页面，把
  // 它打开。
  manageUrl: boolean,

  // 组件加载时是否显示自带的 avatar 选择器网格。如果宿主页面想用自己的 UI
  // 来做 avatar 选择（组件外部），并改为调用 callAvatar()，就把它关掉——
  // 这样组件会保持空闲状态，直到被告知要拨打哪个 avatar，而不是自己去加
  // 载并渲染那个网格。
  autoLoadPicker: boolean,

  // 后端 API 调用的地址前缀。"" （默认）表示发起同源的相对路径请求——当
  // 组件所在页面和本仓库的后端是同一个服务时用这个默认值。如果组件被嵌入
  // 到和后端不同源的页面上，设置成例如 "https://api.example.com"。
  apiBaseUrl: string,

  // 组件自己所在页面挂载的路径前缀——比如反向代理到了 "/liveavatar" 下
  // 面。只有 manageUrl 为 true 时才会用到，让深链接按
  // "<basePath>/avatar/<id>" 的格式读写，而不是假设组件独占域名根路径下
  // 的 "/avatar/<id>"。跟 apiBaseUrl 是相互独立的两个选项：页面自己的挂
  // 载路径，和后端 API 的位置，不一定是同一件事。默认 ""，表示挂载在根
  // 路径下。
  basePath: string,
}
```

把 `buttons.disconnect` 设为 `false` 会去掉 UI 上的挂断按钮，但仍然可以
通过编程方式挂断当前通话——见下面的 `hangUp()`。

### 示例：偏"只读"的精简嵌入、更快的字幕、远程 API

```js
new FaceMarketWidget(document.getElementById("call-widget"), {
  buttons: { keyboard: false, share: false }, // 其余按钮保持默认（true）
  captionScrollSpeed: 1.5,
  apiBaseUrl: "https://avatar-backend.example.com",
});
```

### 示例：固定单个 avatar（最常见的嵌入方式）

```js
new FaceMarketWidget("#call-widget", {
  avatarId: "avatar_01m0zwzpntef4tcsam1sxfcgcm",
});
```

### 示例：由宿主页面来选择 avatar，而不是组件自己

```js
const widget = new FaceMarketWidget("#call-widget", {
  autoLoadPicker: false, // 不渲染组件自带的 avatar 网格
});

// 在你自己的 avatar 列表 UI 里（用什么方式实现都行）：
myAvatarListEl.querySelector(".avatar-item").addEventListener("click", () => {
  widget.showAvatar("avatar_01m0zwzpntef4tcsam1sxfcgcm"); // 落到拨号界面，等用户点击才连接
  // 或者，如果已经从 GET /api/avatars 拿到了完整记录：
  // widget.showAvatar({ id, name, description, cover });
  // 想直接跳过拨号界面、立刻发起连接：widget.callAvatar(...) —— 参数形式一样。
});
```

## 实例方法

| 方法               | 说明                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `showAvatar(avatarIdOrAvatar)` | `async`。从组件外部驱动，为指定 avatar 显示单 avatar 拨号界面（"点击拨打"状态），但不会发起连接——用户仍然需要自己点击拨打按钮。参数形式和 `callAvatar()` 一样。当宿主页面自己的 avatar 选择 UI 应该落到正常的"点击连接"状态、而不是立刻拨号时，用这个方法。 |
| `callAvatar(avatarIdOrAvatar)` | `async`。从组件外部驱动，立即开始（或切换到）与指定 avatar 的通话。可以传一个 avatar id（组件会通过 `GET /api/avatars/:id` 自己获取详情），也可以传一个已经拿到手的 avatar 对象（`{ id, name, description, cover }`，比如来自你自己调用的 `GET /api/avatars`）。通常和 `autoLoadPicker: false` 搭配使用，这样组件永远不会显示自带的选择器网格，avatar 选择完全由宿主页面决定。 |
| `destroy()`           | 结束当前活跃的通话（如果有），释放 SDK 相关资源，并把组件的 DOM 从容器里移除。调用之后不应再复用这个实例。 |
| `hangUp()`             | `async`。结束当前通话（如果有），效果和点击挂断按钮一样。适用于 `buttons.disconnect: false` 的情况，或者需要从组件外部结束通话（比如页面级的"离开"操作）。 |

没有 `mount()` 方法——构造函数调用后就会立即挂载。如果要把组件移动到别的
容器，先 `destroy()` 当前实例，再针对新的目标重新构造一个。

## 补充说明

- **样式**：所有 CSS 都写在组件的 Shadow DOM 内部（源码里的 `STYLE_TEXT`
  模板字符串），会自动作用域隔离——你没办法（也不需要）用页面级 CSS 去覆
  盖它。如果需要 `buttons`/`captionScrollSpeed` 配置项之外的视觉定制，直
  接修改 `STYLE_TEXT`。
- **同时只能有一通通话**：一个 `FaceMarketWidget` 实例只管理一通活跃通
  话。如果需要同时进行多通，挂载第二个实例（放进另一个容器）。
- **字幕滚动算法**：字幕会一次推进一整行渲染出来的文字，每行在屏幕上停留
  的时长由**这一行自己的**词数（对中日韩文字则是字数，因为它们没有像英文
  那样的分词边界）决定，停留够了再滑到下一行——不是连续滚动。行的边界是
  从实际渲染出来的布局中测量出来的（`Range.getClientRects()`，通过
  `TreeWalker` 遍历字幕元素下的每一个文本节点，而不是只假设只有一个文本
  节点——因为字幕文字里可能会内联链接，见下面的"链接识别"），而不是靠猜测
  原始字符串，因为 CSS 换行取决于渲染宽度。
- **手动回看字幕**：一旦自动滚动已经完全推进到底（没有更多内容可以往下滚
  了），在字幕上拖拽或者用鼠标滚轮就可以手动往回翻看之前的行——按住鼠标
  拖动、触摸拖动、或者滚轮都可以。这个交互只会在自动滚动完全静止时才会启
  用，不会在动画播放到一半时启用，所以不会跟正在进行的换行动画打架。回看
  期间，即使有新的字幕内容流式进来，也不会把你的位置拽回去——只有你自己
  滑回最新的位置，或者下一轮新的问答开始时，才会恢复自动滚动（从你停留的
  位置继续）。
- **深链接**：当 `manageUrl: true`（默认是关闭的——如果这个组件要独占整
  个页面，把它打开）时，打开 `<basePath>/avatar/<id>` 会直接落到那个
  avatar 的拨号界面。每张 avatar 卡片上也有一个"复制链接"按钮
  （`buttons.share`），会把 `location.origin + basePath + /avatar/<id>`
  复制到剪贴板——这个功能只有在 `manageUrl: true` 时才有意义，因为如果组
  件在加载时读不回这个 URL，复制链接也没有用。
- **小型/浮动容器**：布局的计算依据是组件自己所在的容器（通过
  [CSS Container Queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries)，
  在内部根节点上设置了 `container-type: size`），而不是浏览器视口——所以
  把它放进一个很小的浮动窗口（比如一个 320×480px 的聊天小窗）也能正确排
  版，不会假设自己独占整个屏幕。只需要把 `target` 元素设置成你想要的尺寸
  即可。
- **链接识别**：不管是聊天记录（打字提问、语音提问、还是 avatar 的回答）
  还是实时字幕，文字里出现的 `http(s)://` 链接都会被渲染成真正可点击的
  `<a target="_blank">` 链接，后面跟一个小的外链图标。文本会先做 HTML 转
  义，所以即使消息里恰好包含 `<`/`>`/`&` 这类字符也是安全的。字幕里的链接
  比较特殊：链接（连同图标）是直接内联进行边界测量算法要遍历的那套文本节
  点结构里的（见上面的字幕节奏说明），而不是单独定位的浮层——所以它会跟着
  周围的文字自然一起滚动，不需要额外的位置跟踪逻辑。
