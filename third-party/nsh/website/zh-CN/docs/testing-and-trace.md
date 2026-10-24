---
title: 测试
description: 无界面测试应用：用 Rust 配合 cargo test 和 nsh_testing，或用 TypeScript 配合 nsh test：像用户一样打开应用、点击、输入、滚动和等待，模拟网络和存储；读懂 --trace 打印的原生视图操作和耗时；以及用于 UI 测试的 testID。
order: 61
group: tools
---

# 测试

NSH 以 **无界面（headless）** 方式运行应用：使用真实的引擎（与设备上相同的响应式图、渲染器、组件、布局和列表虚拟化，
TSX 还有 QuickJS），以 60 Hz 提供显示帧，但不需要模拟器、设备或窗口。只要 Cargo 或 CLI 能运行的地方它都能运行，包括
Linux CI 机器。它做两件事：

- 运行测试：每个测试打开应用，像用户一样操作（点击、输入、滚动），并检查屏幕上的内容。Rust 应用的测试用 Rust 编写，由
  `cargo test` 配合 `nsh-testing` crate 运行；用 TypeScript 编写的测试由 `nsh test` 运行，TSX 应用和 Rust 应用都适用；
- 加上 `--trace` 时，打印运行时发送给原生视图的每一个操作并附带耗时：首帧、一次点击或一帧滚动的开销。

## 编写测试

同一个测试，分别用 Rust 和 TypeScript 编写：它在存储中放一个空的待办列表打开应用，输入、点击，并检查屏幕显示的内容。

```rust tabs
// tests/app/main.rs
use nsh_engine::{EngineConfig, Root};
use nsh_testing::{Headless, MemoryStorage};

#[test]
fn adds_a_todo() {
    let mut config = EngineConfig::new(Root::of::<my_app::App>());
    config.storage = Some(MemoryStorage::new([("todos".to_owned(), "[]".to_owned())]));
    let mut app = Headless::start(config).unwrap();
    app.type_text("id:new-todo", "Buy milk").unwrap();
    app.press("text:Add").unwrap();
    app.wait_for("text:Buy milk").unwrap();
    assert!(app.screen().texts().contains(&"1 item left"));
}
```

```tsx tabs
// App.test.tsx
import { expect, open, test } from "nsh/test";

test("adds a todo", async () => {
  const app = await open("./App.tsx", { storage: { todos: "[]" } });
  await app.type("id:new-todo", "Buy milk");
  await app.press("text:Add");
  await app.waitFor("text:Buy milk");
  expect(app.texts()).toContain("1 item left");
});
```

## 用 cargo test 编写 Rust 测试

Rust 应用的测试是它的 crate 的集成测试，以 `nsh-engine` 和 `nsh-testing`（默认 feature，不含 QuickJS）作为 dev-dependencies：

```toml
[dev-dependencies]
nsh-engine = "0.1"
nsh-testing = "0.1"
```

```sh
cargo test                    # crate 的所有测试
cargo test adds_a_todo        # 名称包含 "adds_a_todo" 的测试
```

`EngineConfig::new(root)` 是一个手机尺寸（390×844 点）、其余都未设置的引擎；它的字段对应下文 `open` 的选项：`storage`
（`MemoryStorage::new(entries)`）、`network`（`StubNetwork`，见下文）、`viewport`、`environment`（外观、区域设置、减少动态效果）、
`clock`（`Clock::manual(time)`，见下文）。`nsh_testing::Headless::start(config)` 启动应用，并维护它所显示视图的模型。它的步骤就是
下文 `nsh test` 的步骤，选择器相同，只是用 Rust 写：`press`、`long_press`、`clear`、`type_text`、`submit`、
`scroll(selector, px(3000.0))`、`back`、`wait`、`wait_for`、`wait_for_gone`、`wait_until`、`run_for`、`fast_forward`、
`set_system_time`、`set_viewport`、`set_clipboard` 和 `on_dialog`；`app.shows(text)` 和 `app.screen()`（`texts()`、
`count(selector)`、`enabled(selector)`、`dialogs()`、`clipboard()`、`commands()`）读取屏幕上的内容。无法执行的步骤会返回一个错误，
附带屏幕上的文字。

`nsh_testing::tsx(entry, sets)`（feature `bundle`）以同样的方式打开应用的 TSX 入口，基于 NSH 的和 crate 的 UI 集合构建
（[用 Rust 开发](./rust.md#测试)）。`examples/gallery-rs` 就这样测试它的 Rust 根组件，每个演示一个模块；`examples/rust-exports`
从 Rust 测试它的 TSX 入口。

`nsh test` 也会运行这些测试：传入带有 Rust crate 的应用（`nsh.json` `"rust"`）的目录时，它会在测试文件之前为其中每个 crate
运行 `cargo test`，并把 Rust 测试与 TypeScript 测试一起显示和计数（`✓ src/lib.rs › tests::adds`），计入汇总和 `--junit`
报告。所以无论是 Rust 应用、带 crate 的 TSX 应用还是 TSX 应用，`nsh test` 都是同一个命令；`nsh check` 同样会先对 crate 运行
`cargo check --all-targets`，再对 TypeScript 做类型检查。

## 用 nsh test 编写测试

测试文件是放在代码旁边的 `*.test.tsx` 或 `*.test.ts` 文件，它导入 `nsh/test`，就像上面的 `App.test.tsx`：

```sh
nsh test                      # 当前目录中应用的所有测试文件
nsh test App.test.tsx         # 一个文件
nsh test --filter "adds"      # 名称包含 "adds" 的测试
```

```text
✓ App.test.tsx › adds a todo (84ms)
✗ App.test.tsx › keeps todos after a restart (312ms)
    expected ["Todos","0 items left"] to contain "1 item left"
    at <anonymous> (App.test.tsx:21:22)
    on screen: "Todos", "0 items left"
error 2 tests: 1 passed, 1 failed (0.9s)
```

失败的测试会显示抛出的内容、它在测试文件中的位置，以及所打开应用当时屏幕上的文字。只要有失败，`nsh test` 就以非零
退出码结束。`nsh init` 会随应用创建一个 `App.test.tsx`，`nsh check` 会连同其他代码一起对测试文件做类型检查
（`.nsh/types` 中声明了 `nsh/test`）。

每个测试文件在各自的引擎上运行，文件中的测试按顺序逐个运行。`open` 在另一个全新的引擎上启动应用，因此测试之间从不
共享状态；测试结束时，它打开的应用会被关闭。测试在抛出异常、返回的 promise 被 reject 或超时时失败：超时默认 30 秒，
也可以用 `test` 的第三个参数按毫秒指定（`test("syncs", body, 60_000)`）。带有自己
Rust crate 的应用（`nsh.json` 的 `"rust"`）以同样的方式，在 NSH 用这些 crate 构建的无界面运行器中运行测试；在 Rust 应用
（`nsh.json` 的 `"root"`，[用 Rust 开发](./rust.md)）中，`open(".")` 启动它的根组件。

### 分组与准备测试

`describe`、各个钩子和 `test` 的变体与 Jest 的用法一致：

```tsx
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

describe("the cart", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("./App.tsx", { storage: { cart: "[]" } });
    await app.press("Cart");
  });

  test("starts empty", () => {
    expect(app.texts()).toContain("No items");
  });

  test.todo("applies a coupon");
});
```

| 函数 | 说明 |
|---|---|
| `describe(name, body)` | 把 `body` 声明的测试和块归为一组（在文件加载时立即声明）：它们的名称以 `name` 开头（`the cart › starts empty`），其中声明的钩子只在它们前后运行。块可以嵌套。 |
| `beforeEach(fn, timeout?)`、`afterEach(fn, timeout?)` | 在所在块（文件或某个 `describe`）的每个测试之前 / 之后运行 `fn`：`beforeEach` 外层块的先运行，`afterEach` 内层块的先运行。`beforeEach` 失败时该测试失败；无论如何 `afterEach` 都会运行。 |
| `beforeAll(fn, timeout?)`、`afterAll(fn, timeout?)` | 当所在块有测试要运行时，在第一个测试之前、最后一个测试之后各运行一次 `fn`。`beforeAll` 失败时，该块的测试都失败；`afterAll` 失败时报告为一个失败的 `<块> › afterAll`。`beforeAll` 打开的应用在该块的测试期间保持打开，在其 `afterAll` 之后关闭。 |
| `test.skip(name, body, timeout?)`、`describe.skip(name, body)` | 声明不运行的测试或块：它们报告为已跳过。 |
| `test.only(name, body, timeout?)`、`describe.only(name, body)` | 测试文件中有它们时，只运行这些测试和块；文件中的其他测试报告为已跳过。 |
| `test.todo(name)` | 还没写的测试，报告为 todo。 |

钩子可以是 `async` 函数；`timeout` 默认 30 秒。测试和钩子在文件加载时声明：在测试或钩子里声明测试会抛出异常。

### 打开应用

`open(entry, options?)` 构建 `entry` 处的应用（路径相对于测试文件；每次运行中每个入口只构建一次），以 390×844 的视口
启动它，并在它完成渲染且空闲后 resolve。

| 选项 | 默认值 | 说明 |
|---|---|---|
| `storage` | 空 | `nsh/storage` 初始保存的内容：`{ todos: "[]" }`。 |
| `network` | 无 | 应用的请求按路由得到的结果，见[模拟网络](#模拟网络)。`"live"`：使用真实网络。 |
| `width`、`height` | 390、844 | 视口大小，单位为点。 |
| `safeArea` | 0 | 安全区域内边距，单位为点：`{ top: 47, bottom: 34 }`。 |
| `clipboard` | 空 | 剪贴板初始的文字。 |
| `colorScheme` | `"light"` | 系统外观：`"light"` 或 `"dark"`（`colorScheme()`、`dark:` 类）。 |
| `locale` | `"en-US"` | 设备的区域设置，BCP 47 标签（`locale()`、`Intl` 的默认值）。 |
| `reducedMotion` | `false` | 用户要求减少动态效果（`reduceMotion()`）。 |
| `platform` | `"ios"` | headless 时应用运行所在的平台：`"ios"`、`"android"`，或桌面平台 `"macos"`、`"windows"`、`"linux"`，以及桌面形态的 `"web"`（`platform.os`、`ios={{…}}` / `android={{…}}` / `desktop={{…}}` 属性、键盘快捷键）。在真实平台上就是该平台。 |
| `clock` | 系统时钟 | 手动时钟，它的时间只随测试推进：`{}`，或者用 `{ time }` 从某个 `Date`（或自 Unix 纪元起的毫秒数）开始。见[控制时间](#控制时间)。 |
| `host` | 无 | 由测试扮演的宿主应用：`{ params, handlers }`。见[扮演宿主应用](#扮演宿主应用)。 |

### 扮演宿主应用

嵌入在原生应用中的应用通过 [`nsh/host`](../modules/nsh-host.md) 与宿主应用通信。在测试里由测试扮演宿主应用：`host.params` 是应用启动时读取的启动参数，`host.handlers` 按名称回答应用的 `host.call`、接收它的 `host.post`。处理函数可以是一个值，用它回答每次调用；也可以是一个函数，接收调用的数据并返回回答（或回答的 promise）。函数抛出的错误会让调用失败，与宿主应用出错时一样。`handlers` 没有列出的名称的调用会失败，与不处理任何调用的宿主应用一样。

```tsx
const app = await open("./App.tsx", {
  host: {
    params: { conversation: "c-42" },
    handlers: {
      "user.profile": async ({ id }) => ({ id, name: "Ada" }),
      "feature.flags": { search: true },
      analytics: null,
    },
  },
});
await app.press("Profile");
expect(app.host.calls()).toEqual([{ name: "user.profile", data: { id: 7 } }]);
expect(app.host.posts()).toEqual([{ name: "analytics", data: { screen: "profile" } }]);
// 应用的 `host.on("conversation.open", …)` 会收到它。
await app.host.send("conversation.open", { id: "c-43" });
expect(app.shows("Conversation c-43")).toBe(true);
```

`app.host.send(name, data)` 发送一个事件，然后等待应用空闲。`app.host.calls()` 和 `app.host.posts()` 按顺序列出处理函数收到的调用和投递：`name` 和 `data`。

应用打开的 URL（[`openUrl`](../modules/nsh-device.md#openurl)，以及 `links="open"` 的 `TextView` 中的链接）会被记录下来，并以“已打开”回报给应用，本机上不会真正打开任何东西。`app.openedUrls()` 列出它们：

```tsx
await app.press("Contact us");
expect(app.openedUrls()).toEqual(["mailto:help@example.com"]);
```

### 模拟网络

`network` 按 `"<METHOD> <URL>"` 列出路由（只写 URL 表示 `GET`；`*` 匹配任意文字）。没有路由匹配的请求会失败，因此测试不会在
未经允许时访问网络。路由是一个响应，或者一个接收请求、返回响应（或响应的 Promise）的函数；在 Rust 中，
`StubNetwork::new(routes)` 接受同样的路由，每个是一个 `StubResponse` 或一个 `StubRoute::Handler`：

```rust tabs
use std::sync::Arc;
use nsh_engine::{EngineConfig, Root};
use nsh_testing::{Headless, StubNetwork, StubResponse};

#[test]
fn adds_a_todo_on_the_server() {
    let mut todos = StubResponse::default();
    todos.status = 200;
    todos.headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    todos.body = br#"[{ "id": 1, "title": "Walk" }]"#.to_vec();
    let mut created = StubResponse::default();
    created.status = 201;
    let mut offline = StubResponse::default();
    offline.error = Some("offline".to_owned());
    let network = Arc::new(StubNetwork::new([
        ("GET https://api.example.com/todos".to_owned(), todos),
        ("POST https://api.example.com/todos".to_owned(), created),
        ("GET https://api.example.com/sync".to_owned(), offline),
    ]));
    let mut config = EngineConfig::new(Root::of::<my_app::App>());
    config.network = Some(network.clone());
    let mut app = Headless::start(config).unwrap();
    app.press("Add").unwrap();
    let methods: Vec<String> = network.requests().iter().map(|r| r.method.clone()).collect();
    assert_eq!(methods, ["GET", "POST"]);
}
```

```tsx tabs
const app = await open("./App.tsx", {
  network: {
    "GET https://api.example.com/todos": { body: [{ id: 1, title: "Walk" }] },
    "POST https://api.example.com/todos": (request) => ({ status: 201, body: JSON.parse(request.body!) }),
    "GET https://api.example.com/todos/*": { status: 404 },
    "GET https://api.example.com/sync": { error: "offline" },
    "GET https://api.example.com/slow": { body: "done", delay: 2000 },
  },
});
await app.press("Add");
expect(app.requests().map((r) => r.method)).toEqual(["GET", "POST"]);
```

| 响应成员 | 默认值 | 说明 |
|---|---|---|
| `status` | 200 | 状态码。 |
| `headers` | 无 | 响应头的名称和值。 |
| `body` | 空 | 字符串，或者作为 JSON 发送的值（`headers` 未指定时带上 `content-type: application/json`）。 |
| `error` | 无 | 请求改为以这条消息失败，就像设备离线时那样。 |
| `delay` | 0 | 响应需要的时间，单位为毫秒；步骤不会等它，`waitFor` 会。在手动时钟上，时钟走过这段时间后响应才到达。 |

路由的函数接收请求（`method`、`url`、`headers`，以及文字形式的 `body`），在测试文件中运行，所以可以统计请求次数，或者根据
测试准备好的数据作答。函数抛出异常时，请求失败，发出该请求的步骤也随之失败。`app.requests()` 以同样的形式按顺序列出应用发出的请求。

### 控制时间

在系统时钟上，应用的定时器和原生动画与在设备上耗时相同，等待它们的测试也一样慢。使用手动时钟（Rust 中的
`EngineConfig::clock`，TypeScript 中 `open` 的 `clock`）时，应用改在手动时钟上运行，就像 Jest 的假定时器或 Playwright 的
`page.clock`：时间只随测试推进，并且立即推进：

```rust tabs
use std::time::{Duration, SystemTime};
use nsh_engine::{Clock, EngineConfig, Root};
use nsh_testing::Headless;

#[test]
fn autosaves() {
    let mut config = EngineConfig::new(Root::of::<my_app::App>());
    // 2026-01-01T09:00:00Z
    config.clock = Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_secs(1_767_258_000));
    let mut app = Headless::start(config).unwrap();
    app.type_text("label:Note", "Milk").unwrap();
    app.run_for(Duration::from_secs(10)).unwrap(); // 十秒后的自动保存
    assert!(app.shows("Saved at 09:00:10"));
}
```

```tsx tabs
const app = await open("./App.tsx", { clock: { time: new Date("2026-01-01T09:00:00Z") } });
await app.type("label:Note", "Milk");
await app.clock.runFor(10_000);            // 十秒后的自动保存
expect(app.texts()).toContain("Saved at 09:00:10");
```

响应带 `delay` 的 `StubNetwork` 用 `.with_clock(clock.clone())` 跟随手动时钟。下面是 `nsh test` 的步骤；`Headless` 都有对应的方法
（`run_for`、`fast_forward`、`set_system_time`）。

| 步骤 | 说明 |
|---|---|
| `await app.clock.runFor(ms)` | 把时钟推进 `ms` 毫秒，每次一个显示帧：定时器、`requestAnimationFrame`、原生动画和延迟的响应在到期时按顺序执行，各自在自己的时刻；应用空闲后 resolve。 |
| `await app.clock.fastForward(ms)` | 一次把时钟推进 `ms` 毫秒，就像设备从睡眠中醒来：期间到期的定时器各执行一次。 |
| `app.clock.setSystemTime(time)` | 把墙上时间（`Date.now()`、`new Date()`）设为某个 `Date` 或毫秒数，不触发任何定时器。 |

`Date`、`performance.now()` 和 `Intl` 的默认日期都跟随这个时钟。步骤不再等待正在进行的内容：只要应用在请求帧或有原生
动画在运行，帧就一帧接一帧地立即到来，每帧在时钟上相隔一帧的时间（1/60 s）；300 ms 的转场只需几毫秒，期间到期的
定时器也会执行。`app.wait(ms)` 和长按会把时钟推进它们各自的时长。更晚到期的定时器只有在测试把时钟推进到那里时才会执行。
`waitFor` 的超时仍按真实时间计算，因为它也在等待来自外部的内容（路由的函数、网络）。gallery 的测试就是这样运行的
（`examples/gallery/tests`）：其中十二个要等动画的测试用 6 s，而不是 28 s。

### 操作步骤

步骤用 **选择器** 指定视图，写法和 Playwright 一致：

| 选择器 | 匹配 |
|---|---|
| `id:<testID>` | 设置了该 `testID` 的视图。 |
| `label:<label>` | 设置了该 `accessibilityLabel` 的视图。 |
| `text:<text>` | 内容为该文字的文本（忽略首尾空格）、文本中可以按的片段（嵌套的 `<Text onPress>`、`TextView` 的链接），或者内容为该文字、空着时占位文字为该文字的输入框。 |
| `role:<role>`、`role:<role>[<name>]` | 设置了该 `role` 的视图（`role:button`），并且名称为 `<name>`：它的标签，没有标签时取它内部的文字（`role:button[Save]`）。 |
| `view:<id>` | `--trace` 输出中该 id 的视图。 |
| 其他写法 | 依次按 `testID`、标签、文字匹配。 |

`label:`、`text:` 和角色的名称也可以写正则：`text:/^Buy/i`。` >> ` 在前一部分匹配到的视图内部继续查找
（`id:cart >> role:button[Remove]`），`nth=<n>` 只保留第 n 个匹配，从 0 开始（`text:Delete >> nth=1`）。选择器找到的是用户
最先会看到的视图：先在最上层的模态窗口中找，再在屏幕上找；对于导航栈只看最上面的页面。它只匹配用户看得见的视图：有面积、不在
`visibility: hidden` 之内、位于窗口和裁剪它的视图（`overflow: hidden`）之内，或者位于用户可以滚动的滚动视图内容中的任何位置（滚动就能
把它带进来）；`opacity` 和 transform 不影响，与 Playwright 一致。作用于视图的步骤（`press`、`type`、
`clear`、`submit`、`scroll`、`longPress`）要求恰好匹配一个视图：匹配到多个时步骤失败，错误信息会说明怎样缩小范围。

| 步骤 | 说明 |
|---|---|
| `await app.press(selector)` | 按下该视图，或者它外层最近的可按压视图（文字外面的按钮）：依次触发 `onPressDown`、`onPressUp`、`onPress`，期间手指按下再抬起，外层监听触摸的视图都能收到（例如 Overlay 的 `onPressOutside`）。文本中的片段按在它的文字上（`await app.press("Privacy policy")`），headless 以及 iOS、Android 和桌面平台都支持。视图被禁用时 reject。 |
| `await app.longPress(selector)` | 按住它（或它外层最近的可按压或监听触摸的视图），持续它的 `delayLongPress`（500 ms）：依次触发 `onPressDown`、`onLongPress`、`onPressUp`，之后不再触发 `onPress`。触摸处理函数能收到这根手指（`ContextMenu`、`Tooltip` 会打开）。 |
| `await app.clear(selector)` | 清空输入框，相当于全选后删除。 |
| `await app.type(selector, text)` | 在输入框（或该视图内的第一个输入框；`text:` 也匹配输入框的内容或占位文字）已有内容的末尾逐键输入：输入框先获得焦点，然后每个字符触发一次 `onKeyPress` 和一次 `onChange`，不超过 `maxLength`。单行输入框中的 `\n` 相当于回车键。 |
| `await app.submit(selector)` | 在输入框中按回车键，行为由它的 `submitBehavior` 决定：触发 `onSubmit`（单行输入框随后失去焦点），或者在多行输入框中换行。 |
| `await app.scroll(selector, distance)` | 沿滚动视图或列表（该视图、它外层的滚动视图，或它内部的第一个）的方向拖动 `distance` 点，每帧 10 点，不超出内容范围，前提是用户可以滚动它（`scrollable`）。负数表示往回滚。 |
| `await app.hover(selector)` | 把鼠标移到视图中央：鼠标离开的视图收到 `onHoverOut`，移入的视图收到 `onHoverIn` 并应用 `hover:` 样式，监听的视图收到带位置的 `onHoverMove`。用于桌面和任意宽度的 web，包括手机形态的浏览器（headless 时使用桌面或 `"web"` `platform`）；iOS 和 Android 手机没有鼠标，在那里会 reject。 |
| `await app.rightClick(selector)` | 在视图中央按下鼠标右键：该视图或其外层最近的监听视图收到 `onContextMenu`。用于桌面和 web（headless 时使用桌面 `platform`）；手机没有鼠标，在那里会 reject。 |
| `await app.paste(selector, { text?, files?, uris? })` | 像剪贴板上有这些内容时用户粘贴一样粘贴到输入框：输入框获得焦点并收到 `onPaste`（`files` 是文件路径，其字节以 `File` 交给它，`uris` 是 `file:` URL），然后按 `pasteBehavior` 插入文本。支持 headless、macOS 和 iOS；本机剪贴板保持不变。 |
| `app.menu()` | 应用显示的上下文菜单（`Menu.popup`）中的操作：`label`（子菜单中的项写在子菜单名之后，如 `"Share > Mail"`）、`disabled`，可勾选项还有 `checked`；没有打开的菜单时为 `null`。 |
| `await app.chooseMenuItem(label)` | 选择已打开上下文菜单中的操作，如同点击它：应用收到 `onMenu`（其 `onSelect` 运行），然后菜单关闭。该项被禁用或不存在时 reject。 |
| `await app.closeMenu()` | 关闭已打开的上下文菜单，不选择任何项，如同按下 Escape。 |
| `await app.keyboard.press(keys)` | 按下一个带修饰键的按键，写法同 `nsh/keymap`（`"mod+k"`、`"shift+/"`、`"escape"`；`mod` 是平台的命令键），如同硬件键盘，在所有平台上都可用（手机和平板也可以接硬件键盘）：由应用的对应快捷键接收（`keymap.bind`、`onKeyCommand`），否则由获得焦点的输入框接收字符、Backspace 或回车，否则 Escape 执行返回。 |
| `await app.drag(selector, { x, y })` | 手指落在视图中央，停留 100 ms，再移动 `x`、`y` 点（每帧 10 点）后抬起，由平台的输入系统处理：pan 跟随手指（`pan={{ x, y }}`、`onPanStart`，以及带松手速度的 `onPanEnd`），监听触摸的视图会收到触摸事件（`onTouchStart`、`PanResponder`），滚动视图随手指滚动，拉过顶部足够远时触发刷新（`onRefresh`），手指移开后其下的按压会被取消。在桌面和 web 上由鼠标完成。 |
| `await app.wait(ms)` | 让应用运行 `ms` 毫秒：定时器、动画、请求。在手动时钟上，把时钟推进 `ms`（`app.clock.runFor`）。 |
| `await app.waitFor(selector, options?)` | 有视图匹配时 resolve；传 `{ state: "gone" }` 时，等到没有视图匹配才 resolve；`timeout` 毫秒（5000）后 reject。 |
| `await app.waitUntil(condition, options?)` | 应用每发生一次变化就重新检查，`condition()` 返回 true 时 resolve：用于选择器表达不了的条件（`() => app.storage().note === "Milk"`）。 |
| `app.shows(selector)` | 当前是否有视图匹配。 |
| `app.count(selector)` | 当前匹配的视图个数。 |
| `app.enabled(selector)` | 视图是否接受输入：它本身和外层视图都没有被禁用，输入框还要求不是 `readonly`。 |
| `app.texts()` | 当前屏幕上的文字，按顺序排列。 |
| `app.value(selector)` | 输入框的内容，没有匹配时为 `null`。 |
| `app.spanStyle(selector)` | 在无界面测试中，返回匹配到的第一个字符的解析样式：`color`、可选的 `backgroundColor`、`fontSize`、`fontWeight`、`italic`、`underline` 和 `lineThrough`。颜色为 `#rrggbbaa`，字号单位为 pt。 |
| `app.storage()` | 应用存储当前保存的内容。 |
| `await app.back()` | 像用户那样返回（导航栏的返回按钮、下滑关闭弹出页）：最新的模态窗口里（没有模态窗口时就在整个屏幕上）最内层的导航栈弹出栈顶页面（`onDismiss`），栈顶页面设置了 `preventBack` 时改为询问它（`onBackRequest`）；没有可返回的栈时，最新的模态窗口请求关闭（`onRequestClose`）。没有可返回的内容时 reject。 |
| `app.onDialog(handler)` | 回答应用之后弹出的对话框（`Alert.alert`、操作表）：`handler` 接收对话框（`title`、`message`、`buttons`、`cancelable`、`sheet`），返回要按的按钮文字，返回 `null` 则不按按钮直接关闭。 |
| `app.dialogs()` | 应用弹出过的对话框，按顺序排列。 |
| `app.onPick(handler)` | 回答应用之后发起的选取（`Picker.pickImages`）：`handler` 接收这次选取的要求（`multiple`、`limit`、`maxDimension`、`quality`、`format`），返回用户选中的文件（`{ name, type?, data: Uint8Array }`，原样交给应用），返回 `null` 则取消。没有 handler 时选取都会被取消。仅限无界面运行。 |
| `app.picks()` | 应用发起过的选取，按顺序排列。 |
| `app.clipboard()` | 剪贴板当前的文字，没有时为 `null`。 |
| `app.requests()` | 应用发出的请求，按顺序排列：`method`、`url`、`headers`、`body`。 |
| `await app.host.send(name, data?)` | 以宿主应用的身份向应用发送事件（`host.on`），然后等待它空闲。见[扮演宿主应用](#扮演宿主应用)。 |
| `app.host.calls()`、`app.host.posts()` | `open` 的 `host.handlers` 收到的应用调用和投递，按顺序排列：`name`、`data`。 |
| `app.openedUrls()` | 应用打开的 URL（`openUrl`），按顺序排列：只记录，不打开。 |
| `await app.setViewport(width, height)` | 改变视口大小，就像旋转设备或调整窗口大小那样（`windowSize()`）。 |
| `await app.setColorScheme(scheme)` | 像用户那样把系统外观切换为 `"light"` 或 `"dark"`。 |
| `await app.screenshot(path?)` | 应用窗口的 PNG 截图（`Uint8Array`）；给出 `path` 时同时保存到本机的这个路径（相对当前目录）。只有真实平台会绘制应用：见[在真实平台上运行](#在真实平台上运行)。 |

步骤会等到应用连续 100 ms 没有渲染、并且没有正在运行的原生动画（对一直在渲染的应用最多等 2 s；在手动时钟上，同时最多等应用时间的 2 s）后才 resolve，所以下一行
代码运行时，这一步带来的变化已经在屏幕上；之后才出现的内容（响应、定时器）用 `waitFor` 等待。选择器没有匹配到任何视图
（错误信息会列出屏幕上的文字）、应用在此期间抛出了异常，或者应用请求了只有真实平台才能回答的内容时，步骤会 reject，
测试随之失败。

`app.spanStyle("id:guide")` 读取嵌套的 `<Text testID="guide">`；`text:word` 读取匹配文字的第一个字符。
用 `id:note >> text:word` 限定范围，用 `>> nth=0` 选择重复匹配中的一个。
没有匹配、匹配不唯一或 span 为空时会报错。更新 span 的 `testID` 会复用文本排版，保持 `onTextLayout` 的回调次数。

### 无界面运行替平台做了什么

无界面运行有真实的运行时，但没有平台。它只扮演 NSH 协议规定的平台角色，不模拟只有真实平台才能做的事：

- **原生动画会运行**，逐帧跑到结束：`start(callback)` 的回调会执行，等待动画结束的逻辑也会继续。
- **返回**会像平台那样弹出页面、关闭模态窗口（`app.back()`）。
- **对话框会被回答**：由测试的 `onDialog` 回答，否则按它的取消按钮，否则在可以关闭时直接关闭；只能用其他按钮回答的对话框，
  会让弹出它的步骤失败，直到测试指定要按哪个按钮。
- **剪贴板保存文字**：应用复制的内容，粘贴时可以读回来（用 `clipboard` 设定初始内容）。
- **页面的宿主应答 `nsh/host`**：应用的 `nsh.json` 在 `web.host` 中指定了宿主时（[页面的宿主](#页面的宿主)）。
- **应用在它的能力下运行**：`nsh.json` 的 `capabilities` 与设备上一样生效，没有声明的都会被拒绝。
- **URL 只被记录**：应用打开的 URL 以“已打开”回报，`app.openedUrls()` 列出它们。
- **选取会被回答**：用测试给的文件（`onPick`），否则视为取消，`Picker.pickImages` resolve 为 `[]`。
- **模态窗口立即出现**：弹出时就会触发 `onShow`。
- **图片不会加载**：不会有 `onLoad` 或 `onError`，`Image.getSize` 和 `Image.prefetch` 会 reject。
- **只有真实平台才能回答的请求会让步骤失败**：剪贴板里的图片或文件。

### 页面的宿主

发布到 Web 的应用从页面得到宿主：`nsh.json` 的 `web.host`，一个导出 `createHost(player)` 的模块
（[Web](./web.md#宿主的函数)）。无界面运行时，测试每打开一个应用，都会在应用启动前，在独立的 JavaScript 上下文中加载
这个模块（有定时器和 `console`，没有浏览器的 API，不能 import）：它的 `call` 应答应用的
[`host.call`](../modules/nsh-host.md)，它的 `player.hostEvent` 送到 `host.on`，`host.available()` 为 `true`。
`call` 抛出异常、Promise 被拒绝或返回值不是 JSON 时，应用的调用以它的消息被拒绝，与页面上一致；应用启动前发送的事件
会在应用启动后送到它顶层注册的监听器。`--web-host <module>` 指定另一个模块。应用调用的函数必须列在它的 `capabilities.host` 中，
与页面上一致。调用的超时和宿主自己的定时器都按应用的时间计算，手动时钟（`app.clock.runFor`）会推进它们。在浏览器中（`--target web`），开发页面像发布的页面一样为每个应用运行 `nsh.json` 的 `web.host`；在其他平台上（`--target`）应用没有宿主：`host.available()` 为 `false`。

```tsx
// nsh.json：{ "capabilities": { "host": ["echo"] }, "web": { "host": "./host.js" } }
import { open, test } from "nsh/test";

test("calls reach the page's host", async () => {
  const app = await open("./App.tsx");
  await app.press("label:call");
  await app.waitFor('text:{"n":1}');
});
```

`examples/host-echo` 有一个应用、它的宿主和它们的测试。

### 断言

`expect(value)` 按 JSON 的方式比较值（`undefined` 视为 `null`，数字按数值比较），每个检查不成立时都会抛出异常。
`.not` 把检查反过来：`expect(app.texts()).not.toContain("Error")`。

| 检查 | 成立条件 |
|---|---|
| `toBe(expected)`、`toEqual(expected)` | 值逐个成员地等于 `expected`。 |
| `toContain(item)` | 数组包含 `item`，或者字符串包含它。 |
| `toBeTruthy()`、`toBeFalsy()` | 按 JS 的规则，值为真 / 为假。 |
| `toMatch(pattern)` | 字符串包含 `pattern`（字符串），或者匹配它（`RegExp`）。 |
| `toHaveLength(n)` | 数组有 `n` 项，或者字符串有 `n` 个 UTF-16 单元。 |
| `toBeNull()` | 值为 `null`（或 `undefined`）。 |
| `toBeGreaterThan(n)`、`toBeGreaterThanOrEqual(n)`、`toBeLessThan(n)`、`toBeLessThanOrEqual(n)` | 数字与 `n` 满足相应的大小关系。 |
| `toThrow(message?)` | `expect(fn)`：调用 `fn` 会抛出异常；给了 `message` 时，异常消息要匹配它。 |
| `rejects.toThrow(message?)` | `expect(fn)`：`fn` 返回的 promise 会 reject：`await expect(() => app.press("Pay")).rejects.toThrow("is disabled")`。 |

### 在真实平台上运行

`nsh test --target macos`（或 `linux`、`windows`、`gpui`、`web`、`ios`、`android`）在平台的开发 host 上运行同样的测试，而不是 headless：每次 `open` 都在一个新窗口里启动应用，并使用全新的
数据目录；步骤用平台自己的输入作用在选择器指向的视图上，就像 Playwright 在浏览器里那样：

- 按压是在视图中心点击，长按是按住不放，`type` 先点击输入框再逐键输入，`scroll` 是在滚动视图上的触控板手势，`back` 是用户的操作（macOS 和 Linux 上按 Escape，Windows 和 GPUI 里按鼠标的后退键，web 上是浏览器的后退按钮，iOS 上是把 sheet 往下滑，菜单、弹出框或 `Sheet` 打开时是 VoiceOver 的退出手势，否则点标题栏的返回按钮，Android 上是返回键）；
- 不在屏幕上的视图会先被滚动到可见，每次一个手势；
- 选择器、等待和查询看到的应用模型与 headless 相同，由 host 绘制的内容建立，所以找到的是同样的视图；
- 对话框是平台自己的：`app.dialogs()` 读取它们，回答对话框（`onDialog`，或测试没有回答时按它的取消按钮）会按下对应的按钮；
- `app.screenshot(path)` 截取窗口。

```sh
nsh test --target macos                       # 在 macOS 窗口里运行应用的测试
nsh test --target linux                       # 在 GTK 窗口里运行（没有显示器的机器上用 xvfb-run -a …）
nsh test --target windows                     # 在 Win32 窗口里运行
nsh test --target ios                         # 在 iOS 模拟器里运行
nsh test --target android                     # 在 adb 列出的第一个 Android 设备或模拟器上运行
nsh test --target gpui                        # 在 GPUI 窗口里运行（macOS、Windows、Linux）
nsh test --target web                         # 在 headless 的 Chrome、Edge 或 Chromium 里运行
nsh test tests/form.test.tsx --target macos   # 只运行一个文件
```

窗口按视口大小打开（除非 `open` 指定，否则为 390 × 844），并且不会超出屏幕。手动 `clock` 和 headless 时一样：`app.clock.runFor`、
`fastForward` 和 `setSystemTime` 立即推进应用的时间（计时器、每隔一帧的 `requestAnimationFrame`、`Date`），`app.wait(ms)` 也会推进它；
平台每显示一帧，时钟前进一帧（1/60 秒），所以应用在动画时时间照常流逝。平台自身的动画和路由的 `delay` 按真实时间进行。应用的请求和 headless
时一样交给测试：由 `network` 路由应答，没有路由匹配的请求会失败，`"live"` 则放行到 host 的真实网络；`app.requests()` 列出全部请求。
`storage` 在应用启动时就已写入应用存储，`app.storage()` 从应用中读取。`locale`、`reducedMotion` 和 `safeArea` 不随平台上报的值变化；
应用的剪贴板调用由测试自己的剪贴板应答（`clipboard` 是它的初始文本，`app.clipboard()` 读取它），机器的剪贴板保持不变；文本输入框自身的复制和
粘贴使用系统剪贴板。`host.params` 会传给应用，`app.host.send` 发送事件，应用打开的 URL 被记录下来供 `app.openedUrls()` 读取，而不会真正打开。
`host.handlers` 只在 headless 运行：开发 host 不回答任何调用，在那里 `open` 会拒绝 handlers。带有自己 Rust crate 的应用运行在 NSH 为该平台用这些 crate 构建的开发 host 中；
Rust 应用的 host 运行它的 root，所以 `open(".")` 在那里启动它，和 headless 时一样。

在 web 上，应用运行在 headless 的 Chrome、Edge 或 Chromium 打开的开发 host 页面里：使用本机安装的浏览器，或
`--browser <PATH>` 指定的可执行文件（需要有浏览器：找不到时 `nsh test` 会列出它找过的位置）。整个运行共用一个浏览器，
每次 `open` 得到一个拥有独立存储的页面。输入是浏览器的可信输入，与用户的输入一样：鼠标点击、滚轮滚动和按键。

在 iOS 上，应用运行在 iOS 模拟器里的开发 host 中：使用已启动的模拟器，否则 `nsh test` 会启动最新的 iPhone。步骤是手指的触摸和软键盘的输入，
UIKit 收到它们的方式与在设备上相同。`setColorScheme` 切换模拟器的外观，`nsh test` 会在应用结束后把它恢复原样；屏幕是所模拟设备的尺寸。

在 Android 上，应用运行在 `adb devices` 列出的第一个设备或模拟器上的开发 host 中，并拥有独立的存储。步骤是手指的触摸和键盘的按键，
应用的视图收到它们的方式与在设备上相同；`back` 是系统的返回。`setColorScheme` 切换设备的深色主题，`nsh test` 会在应用结束后把它恢复原样。

### 从标准输入给出步骤

如果传入的是应用的入口而不是测试，`nsh test` 会在真实网络下打开应用，让它运行 1.2 s，然后执行标准输入给出的步骤，
其中 `app` 就是这个应用：

```sh
echo 'await app.press("text:+1"); expect(app.texts()).toContain("1");' | nsh test App.tsx
```

这 1.2 s 让引擎的空闲垃圾回收在第一步之前运行，这样，如果应用丢掉了它仍在使用的对象，问题就会暴露出来：它的处理函数
不再生效。

示例中有可以参考的测试：Rust 应用见 `examples/gallery-rs`（`cargo test`，每个演示一个模块，以及 `App.test.tsx`），带 Rust crate
的应用见 `examples/rust-exports`，TSX 应用见 `examples/counter` 和 `examples/gallery/tests`（存储、输入框、长列表、模拟请求、
深色模式、手动时钟）。

## 用 --trace 跟踪

`--trace` 会打印测试所打开应用的每个挂载批次，标注它所属的步骤，以及每次提交的耗时。在 Rust 中，测试也能打印同样的内容：
`observe` 把每个批次连同它的步骤交给测试，`EngineConfig::trace` 通过 `log` crate 记录 `perf` 行（target `nsh::perf`；在测试中
安装一个 logger，例如 `env_logger`）：

```rust
let mut config = EngineConfig::new(Root::of::<my_app::App>());
config.trace = true;
let mut app = Headless::start(config).unwrap();
app.observe(|step, batch| nsh_testing::print_batch(&mut std::io::stdout(), step, batch));
app.press("Add").unwrap();
```

`nsh test` 可以对测试文件使用 `--trace`，也可以对应用入口使用，并从标准输入给出步骤：

```sh
nsh test App.test.tsx --trace
nsh test App.tsx --trace                                   # 首帧，然后空闲 1.2 s
echo 'await app.press("Add")' | nsh test App.tsx --trace    # 再加一次点击
echo 'await app.press("Add")' | nsh test App.tsx --trace --target ios   # 在 iOS 模拟器中做同样的事
```

加上 `--target` 时，跟踪来自真实平台：host 应用的批次标注在带来它们的步骤下，并附带 host 自己在设备硬件上测得的每次 commit
和事件的耗时。

它的用途：

- 检查应用（或某个 demo）能否无错误地构建、执行和渲染；
- 准确查看一次改动创建、移动或更新了哪些原生视图，以及数量；
- 测量首帧、一次点击以及每一帧滚动的开销；
- 在 CI 中发现回归。

### 读懂输出

下面是计数器示例按一次按钮的输出（`echo 'await app.press("+1")' | nsh test examples/counter/App.tsx --trace`），
有删节：

```text
✓ bundled App.tsx (3255 B in 6.2 ms)
perf commit: 56 ops, 271µs (list js 5µs), 49 mount items, 21 nodes
perf first frame: eval 187µs, total 820µs
── open(App.tsx): 49 items
   LayoutDirection { rtl: false }
   Create { id: 2, kind: View }
   Create { id: 4, kind: Text }
   Insert { parent: 2, child: 4, before: None }
   ...
   Frame { id: 2, x: 0, y: 0, w: 390, h: 844 }
   Frame { id: 4, x: 24, y: 64, w: 342, h: 34 }
   ...
   Text { id: 4, text: "nsh counter", content: 342x34 @ 0,0 }
   Text { id: 14, text: "0", content: 36x77 @ 0,0 }
perf event Press on view 26
perf event js: 413µs
perf commit: 10 ops, 672µs (list js 7µs), 7 mount items, 24 nodes
── press(+1): 7 items
   Create { id: 42, kind: Text }
   Insert { parent: 32, child: 42, before: None }
   Frame { id: 32, x: 24, y: 366, w: 342, h: 43 }
   Frame { id: 42, x: 0, y: 23, w: 342, h: 20 }
   Text { id: 14, text: "1", content: 36x77 @ 0,0 }
   Text { id: 42, text: "• 1", content: 342x20 @ 0,0 }
   Text { id: 34, text: "Recent values: 1", content: 342x17 @ 0,0 }
✓ App.tsx › steps (1.4s)
```

#### 批次与 mount item

每个 `── step: N items` 块是一个 **mount 批次（mount batch）**，标注它所属的步骤：平台在一帧内应用到原生视图上的全部内容，一次性切换到
主线程完成。其中的每一行是一个 **mount item**：

| Item | 含义 |
|---|---|
| `Create { id, kind }` | 创建一个原生视图（`View`、`Text`、`Image`、`Scroll` 等）。 |
| `Insert { parent, child, before }` | 把视图放进父视图，位于某个兄弟视图之前（`None`：放在末尾）。 |
| `Remove` / `Delete` | 将视图从父视图中移除 / 释放视图。 |
| `ViewStyle { id, style }` | 视图的装饰：背景、边框、圆角、阴影、不透明度、变换等。 |
| `ViewProps { id, props }` | 触摸和无障碍设置、`testID`。 |
| `Events { id, events }` | 视图上报哪些事件（`EventMask(1)` 表示按压）。 |
| `Frame { id, x, y, w, h }` | 它在父视图中的位置和大小，单位为点。 |
| `Text { id, text, content }` | 文本视图排版后的文本。 |
| `Image { id, source, ... }` | 要加载的图片。 |

只发送发生变化的内容：一次只改变一个数字的点击只发送一个 `Text` item；视图不会收到默认样式，也不会收到空的事件掩码；
未变化的 frame 不会发送。一帧滚动如果没有露出新行，**根本不会产生批次**。

#### `perf` 日志行

| 行 | 含义 |
|---|---|
| `✓ bundled App.tsx (3255 B in 14.3 ms)` | 打包耗时和 bundle 大小（开发配置）。 |
| `commit: 56 ops, 395µs (list js 6µs), 49 mount items, 21 nodes` | 一次提交：JS 排队的操作数、核心花费的时间（渲染组件、布局、diff）、绑定列表行花费的 JS 时间、产生的 mount item 数，以及存活的节点数。 |
| `turn: 2640µs (timers and tasks 1964µs)` | 一次带提交的轮次：总时间，以及提交前 JS 定时器和 Rust 组件任务花费的时间（Rust 组件在提交中渲染）。 |
| `first frame: eval 271µs, total 1235µs` | 执行 bundle 的时间，以及从启动到第一个批次的时间。 |
| `event Press on view 20` / `event js: 196µs` | 分发了一个事件，以及它的处理函数（及其引起的一切）在 JS 中花费的时间。 |

> [!NOTE]
> 无界面模式下文本使用近似的文本引擎测量，因此文本尺寸与设备上（使用 CoreText 或 Android 的文本布局）略有差异。布局
> 逻辑、视图数量和操作数量则完全相同。

单次运行的耗时很大程度上取决于 CPU 的频率状态（刚从空闲中唤醒的机器会比较慢）。请在同一台机器上比较多次运行，取多次
运行中的最小值，并且更多地相信操作数和 item 数，而不是微秒数。

### 滚动

```rust
app.scroll("id:photos", px(3000.0)).unwrap();
```

```sh
echo 'await app.scroll("id:photos", 3000)' | nsh test examples/gallery/Bench.tsx --trace
```

`scroll` 以每秒 60 帧、每帧 10 点的速度滚动列表，并打印每一帧的批次：

```text
perf commit: 55 ops, 1667µs (list js 771µs), 46 mount items, 414 nodes
── scroll(id:photos, 3000): 46 items
   Create { id: 792, kind: View }
   Insert { parent: 94, child: 792, before: None }
   ...
```

对于[列表](./lists.md)，这能展示虚拟化的实际效果：哪些帧绑定了新行、一行需要多少操作，以及没有露出新行的帧不产生任何
内容。要得到有意义的耗时，请使用 release 构建（`cargo test --release`，或源码检出中的 `./target/release/nsh`）。

### 在 CI 中

无界面测试不需要设备或显示器，因此可以在 Linux runner 上运行：Rust 应用的测试用 `cargo test`，`nsh test` 则只需要 CLI。只要有测试
失败，两者都以非零退出码退出：测试本身失败、应用无法构建或什么都没渲染、应用在某一步中抛出异常，都算失败。

```yaml
# .github/workflows/test.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo test                            # Rust 应用的测试
      - run: nsh test --junit test-results.xml     # 它的 TypeScript 测试，或 TSX 应用的测试
```

（在 runner 上安装 `nsh` CLI 的方式与本地安装相同；参见[安装](./installation.md)。）

`--junit <FILE>` 还会把结果写成 JUnit XML 报告，CI 服务（GitHub Actions 的测试报告、GitLab、Jenkins、Azure Pipelines）
会按测试展示它：每个测试文件一个 `testsuite`，每个测试一个 `testcase`，并附上失败的内容、位置和屏幕上的文字。

要守住性能，可以记录几个交互的 item 数（`--trace` 输出中的 `── … : N items` 行以及 `ops` / `mount items` 的数字），在它们
增长时让 CI 失败。这些计数是确定的；共享 CI 机器上的耗时则不是。

> [!NOTE]
> 测试在应用 `nsh.json` 声明的 `capabilities` 下运行，与设备上一致：应用没有声明的，在测试中同样被拒绝。

## 用于 UI 测试的 `testID`

无界面测试检查的是运行时渲染出的内容，它们的 `id:` 选择器按测试 id 查找视图。如果要用平台的测试工具（XCUITest、Espresso / UI Automator、Appium、Maestro）
驱动真实的原生 UI，请给视图设置测试 id：Rust 中用 `.test_id(…)`，TSX 中用 `testID`：

```rust tabs
view()
    .test_id("add-to-cart")
    .p_3()
    .on_press(add)
    .child(text(move || format!("{} items", count.get())).test_id("cart-count"))
```

```tsx tabs
<View testID="add-to-cart" onPress={add} style={{ padding: 12 }}>
  <Text testID="cart-count">{`${count()} items`}</Text>
</View>
```

| 平台 | `testID` 对应到哪里 |
|---|---|
| iOS | 视图的 `accessibilityIdentifier`（在 XCUITest 中为 `app.otherElements["add-to-cart"]`）。 |
| Android | 无障碍节点的 view id 资源名（在 UI Automator 中为 `By.res("add-to-cart")`）。 |

在 Rust 中测试 id 是每个元素的方法；`testID` 是每个元素以及每个 Rust 组件（`SafeAreaView`、`KeyboardAvoidingView` 等）都有的 prop。它不会改变屏幕阅读器读出的内容；那应该用
`accessibilityLabel`（参见[无障碍](./accessibility.md)）。在 `--trace` 的输出中，它出现在视图的 `ViewProps` item 里，
形如 `test_id: Some("add-to-cart")`。

## 另请参阅

- [性能](./performance.md)：这些数字里该关注什么
- [开发服务器与调试](./dev-server-and-debugging.md)
- [架构](./architecture.md)：操作、提交和 mount 批次
