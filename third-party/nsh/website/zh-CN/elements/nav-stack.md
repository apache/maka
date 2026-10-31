---
title: NavStack
description: 原生导航栈：NavStack、NavPage 与 createNavStack，页面的推入与弹出、标题栏插槽、离开页面，以及各平台如何呈现导航栈。
group: base
demo: ui-navigation
---

# NavStack

导航栈一次显示一个页面，并保留它下面的页面：在 iOS 和 Mac Catalyst 上是 `UINavigationController`，带系统标题栏和侧滑返回；在 Android 上是带工具栏和预测性返回的页面栈。在桌面平台（macOS、Windows、Linux、GPUI）和 Web 上，每个页面在顶部显示应用自己的标题栏，返回键和浏览器的后退按钮会弹出页面。`NavStack` 是栈，`NavPage` 是栈中的一个页面。

导航栈负责导航行为（转场、返回手势和返回按钮、页面被覆盖时保留的状态）；页面的内容和桌面标题栏属于应用自己。

```rust tabs
use nsh_base::{button, nav_page, nav_stack};
use nsh_core::prelude::*;

/// A button with the app's look.
fn action(title: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .rounded_lg()
        .bg(rgb(0x2563eb))
        .px_4()
        .py_3()
        .child(text(title).text_color(white()).font_weight(FontWeight::SEMIBOLD))
}

/// The header on the desktops and the web, with a back button over the first page.
fn bar(title: impl Into<SharedString>, routes: Signal<Vec<u32>>) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .px_4()
        .py_3()
        .border_b_1()
        .border_color(rgb(0xe5e5e5))
        .child(when(
            move || !routes.with(Vec::is_empty),
            move || {
                action("Back", move || {
                    routes.update(|r| {
                        r.pop();
                    })
                })
            },
        ))
        .child(text(title.into()).text_lg().font_weight(FontWeight::SEMIBOLD))
}

fn app() -> impl IntoElement {
    // The messages pushed over the inbox, bottom to top.
    let routes = signal(Vec::<u32>::new());
    nav_stack()
        .flex_1()
        .child(
            nav_page()
                .title("Inbox")
                .header(bar("Inbox", routes))
                .child(view().flex_1().p_4().child(action("Open message 1", move || {
                    routes.update(|r| r.push(1))
                }))),
        )
        .child(each(
            move || routes.get(),
            |id: &u32| *id,
            move |id, depth| {
                let title: SharedString = format!("Message {}", id.get_untracked()).into();
                nav_page()
                    .title(title.clone())
                    .header(bar(title, routes))
                    // The user went back natively: this page and those above it are gone.
                    .on_dismiss(move || routes.update(|r| r.truncate(depth.get_untracked())))
                    .child(view().flex_1().p_4().child(text("The message.")))
            },
        ))
}
```

```tsx tabs
import { mount, Text, View } from "nsh";
import { Button, createNavStack, NavPage, NavStack } from "nsh/base";

type Route = { name: "home" } | { name: "detail"; id: number };

const nav = createNavStack<Route>([{ name: "home" }]);

function Action(props: { title: string; onPress: () => void }) {
  return (
    <Button onPress={props.onPress} class="rounded-lg bg-blue-600 px-4 py-3 active:bg-blue-700">
      <Text class="text-center text-base font-semibold text-white">{props.title}</Text>
    </Button>
  );
}

function Bar(props: { title: string }) {
  return (
    <View class="flex-row items-center gap-3 border-b border-neutral-200 px-4 py-3">
      {nav.routes().length > 1 && <Action title="Back" onPress={() => nav.pop()} />}
      <Text class="text-lg font-semibold">{props.title}</Text>
    </View>
  );
}

function Home() {
  return (
    <NavPage title="Inbox" header={<Bar title="Inbox" />}>
      <View style={{ flex: 1, padding: 16 }}>
        <Action title="Open message 1" onPress={() => nav.push({ name: "detail", id: 1 })} />
      </View>
    </NavPage>
  );
}

function Detail(props: { id: number }) {
  const title = `Message ${props.id}`;
  return (
    <NavPage title={title} header={<Bar title={title} />}>
      <View style={{ flex: 1, padding: 16 }}>
        <Text>The message.</Text>
      </View>
    </NavPage>
  );
}

function App() {
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (route.name === "home" ? <Home /> : <Detail id={route.id} />)}
    </NavStack>
  );
}

mount(App);
```

在 iOS 和 Android 上，页面显示带 `title` 和返回按钮的系统标题栏；在桌面平台和 Web 上，它显示 `header`。只面向手机的应用可以省略 `header`；只面向桌面的应用可以省略系统标题栏的选项。[导航指南](../docs/navigation.md)讲解一个完整应用的导航：栈的状态、对话框、Android 返回键和标签页。

<a id="how-a-stack-works"></a>

## 栈的工作方式

- 栈中的页面对应**路由**：由你选择的值，从栈底到栈顶排列。路由通常指明页面并携带它的参数。
- 在 TSX 中，路由保存在 `createNavStack` 创建的状态里。`NavStack` 每次推入时调用一次子函数，并把结果显示为一个页面。只要路由还在栈中，它就保留这个页面，所以页面被其他页面覆盖时也会保留自己的状态（信号、滚动位置、输入内容）。
- 在 Rust 中，栈的子元素就是它的页面：放入 `nav_stack()` 的 `nav_page()` 被推入，移除的被弹出。把路由保存在一个信号里，用按路由设置 key 的 `each(..)` 渲染页面，下面的页面就会保留各自的状态。
- 每次推入都是一个独立的页面，同一个路由值推入两次也是如此。
- 用户以原生方式离开页面时（返回按钮、侧滑返回、Android 返回键、桌面平台的返回键、浏览器的后退），页面随之离开。在 TSX 中，栈会从状态里移除它的路由，所以 `nav.routes()` 始终与用户看到的一致。在 Rust 中，页面会报告 `on_dismiss`，你在其中移除它的路由（以及它上面的路由）。
- 在 TSX 中，子函数返回的不是 `<NavPage>` 时，会得到一个使用默认选项的页面。返回 `<NavPage>` 即可设置它的标题栏和其他选项。

<a id="createnavstack"></a>

## createNavStack

```ts
function createNavStack<R>(routes: R[]): NavStackState<R>
```

创建一个栈的状态，初始路由为 `routes`，从栈底到栈顶。只创建一次，比如在模块顶层，然后传给 `<NavStack state>`。任何代码都可以导入它来导航。

| 成员 | 说明 |
|---|---|
| `routes: Accessor<readonly R[]>` | 路由，从栈底到栈顶。响应式。 |
| `push(route: R): void` | 推入一个页面。 |
| `pop(count?: number): void` | 弹出 `count` 个页面（默认 1）。始终至少保留一个页面。 |
| `popToRoot(): void` | 弹回第一个页面。 |
| `replace(route: R): void` | 替换顶部页面。 |
| `setRoutes(routes: R[]): void` | 替换所有页面；保留下来的路由（同一个值）保留它的页面和状态。 |
| `remove(route: R): void` | 移除 `route` 最上面的那个页面（用 `===` 比较），无论它在栈中的哪个位置。 |

在 Rust 中，同样的操作就是修改你的路由信号：`routes.update(|r| r.push(route))` 推入，`r.pop()` 弹出，`r.truncate(1)` 弹回你保留的第一个页面，`routes.set(..)` 替换所有页面。

```rust tabs
routes.update(|r| r.push(7));
routes.update(|r| r.truncate(r.len().saturating_sub(2)));
routes.set(vec![1, 2]);
let depth = move || routes.with(Vec::len);
```

```tsx tabs
nav.push({ name: "detail", id: 7 });
nav.pop(2);
nav.setRoutes([{ name: "home" }, { name: "detail", id: 1 }]);
const depth = () => nav.routes().length;
```

<a id="navstack-props"></a>

## NavStack 属性

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `state` | 页面即它的子元素 | `NavStackState<R>` | 保存路由的状态（`createNavStack`）。必填。 |
| `children` | `.child(..)` | `(route: R, index: Accessor<number>) => JSX.Element` | 渲染一个路由。返回 `<NavPage>` 以设置它的选项。必填。 |
| `style`、`class` | 样式方法 | | 栈的样式；通常为 `flex: 1`。 |
| `testID` | `.test_id(..)` | `string` | 在测试和 `nsh test --trace` 中找到这个栈。 |

TSX 的子函数接收路由值本身，以及一个表示它在栈中位置的 accessor。

<a id="navpage-props"></a>

## NavPage 属性

`NavPage` 是栈中的一个页面。它包含页面的内容、它在桌面平台和 Web 上的 `header`，以及 iOS 和 Android 上系统标题栏的选项。在 Rust 中，`nav_page()` 返回这个页面，它的构建方法就是属性名的蛇形写法。

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `header` | `.header(..)` | `JSX.Element` | 无 | 桌面平台和 Web：页面的标题栏，放在页面顶部，与页面同宽，高度由它的布局决定，内容位于其下方。 |
| `title` | `.title(..)` | `string` | 无 | iOS 和 Android：系统标题栏的标题。 |
| `headerVisible` | `.header_visible(..)` | `boolean` | `true` | iOS 和 Android：显示系统标题栏。 |
| `headerTransparent` | `.header_transparent(..)` | `boolean` | `false` | iOS 和 Android：内容延伸到透明的系统标题栏之下。 |
| `headerLargeTitle` | `.header_large_title(..)` | `boolean` | `false` | iOS：大标题，随内容滚动收进标题栏；内容在标题栏之下滚动。 |
| `headerBackTitle` | `.header_back_title(..)` | `string` | 无 | iOS 和 Android：返回到这个页面的返回按钮的文字（在 Android 上是它给屏幕阅读器的描述）。 |
| `headerBackVisible` | `.header_back_visible(..)` | `boolean` | `true` | iOS 和 Android：显示返回按钮。 |
| `headerLeft` | `.header_left(..)` | `JSX.Element` | 无 | iOS 和 Android：系统标题栏前端的内容，替代返回按钮。 |
| `headerRight` | `.header_right(..)` | `JSX.Element` | 无 | iOS 和 Android：系统标题栏末端的内容。 |
| `headerTitle` | `.header_title(..)` | `JSX.Element` | 无 | iOS 和 Android：替代标题的内容。 |
| `headerStyle` | `.header_style(..)` | `{ backgroundColor?, color?, tintColor? }` | 平台默认 | iOS 和 Android：系统标题栏的颜色：背景、标题的颜色（`color`）和按钮的颜色（`tintColor`）。 |
| `headerClass` | `.header_style_with(\|s\| ..)` | `string` | 无 | 以类表示的同样的颜色：`bg-*`，标题用 `text-*`，按钮用 `tint-*`（Rust 中为 `.bg(..)`、`.text_color(..)`、`.tint_color(..)`，主题颜色随外观切换）。`headerStyle` 优先于它们。 |
| `popOnBack` | `.pop_on_back(..)` | `boolean` | `true` | 返回按钮和侧滑返回会弹出页面。见[离开页面](#leaving-a-page)。 |
| `popOnSwipe` | `.pop_on_swipe(..)` | `boolean` | `true` | 交互式返回手势会弹出页面：iOS 的侧滑返回、Android 跟随手指的预测性返回。返回按钮在任何情况下都会弹出页面。 |
| `animation` | `.animation(..)` | `"default" \| "slide" \| "fade" \| "none"` | `"default"` | 页面进入和离开的方式。 |
| `statusBar` | `.status_bar(..)` | `{ foreground?, hidden?, animated? }` | 无 | iOS 和 Android：页面位于顶部时的状态栏。见[状态栏](../modules/nsh-base.md#status-bar)。 |
| `style`、`class` | 样式方法 | | 无 | 页面的样式。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到这个页面。 |

<a id="navpage-events"></a>

## NavPage 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onBackPress` | `.on_back_press(..)` | 用户在页面上按了返回（标题栏的返回按钮、Android 返回键、桌面平台上的 Escape、Alt+左方向键或鼠标的后退键、浏览器的后退），无论 `popOnBack` 是否让它弹出。 |
| `onDismiss` | `.on_dismiss(..)` | 用户弹出了页面（返回按钮、侧滑）；在 TSX 中它的路由已被移除，在 Rust 中在这里移除它。 |

<a id="header-slots"></a>

## 标题栏插槽

`header`、`headerLeft`、`headerRight` 和 `headerTitle` 是插槽：普通的元素，可以读取信号、处理按压，并在页面显示期间更新。`header` 是应用在桌面平台和 Web 上的整个标题栏；其余三个放进 iOS 和 Android 的系统标题栏。

```rust tabs
use nsh_base::nav_page;
use nsh_core::prelude::*;

fn profile(edit: impl Fn() + 'static) -> Screen {
    nav_page()
        .title("Profile")
        .header(profile_bar())
        .header_style_with(|s| s.bg(rgb(0x1a7f37)).text_color(white()).tint_color(white()))
        .header_right(text("Edit").text_color(white()).on_press(move || edit()))
        .child(scroll().flex_1())
}
```

```tsx tabs
<NavPage
  title="Profile"
  header={<ProfileBar />}
  headerStyle={{ backgroundColor: "#1a7f37", color: "#ffffff", tintColor: "#ffffff" }}
  headerRight={<Text onPress={edit} style={{ color: "#ffffff", fontSize: 17 }}>Edit</Text>}
>
  <Scroll style={{ flex: 1 }}>…</Scroll>
</NavPage>
```

页面的内容从标题栏下方开始：在 iOS 和 Android 上位于不透明的系统标题栏之下，在桌面平台和 Web 上位于 `header` 之下。使用 `headerTransparent`、`headerLargeTitle` 或 `headerVisible={false}` 时，在 iOS 和 Android 上内容从页面顶部开始；用 [`env(safe-area-inset-top)`](./safe-area.md) 或 `safeAreaInsets()` 让它避开标题栏和状态栏。

在 iOS 上，设置 `headerVisible={false}` 的页面在 `popOnSwipe` 和 `popOnBack` 为 true 时仍支持侧滑返回。
允许的交互式返回手势在转场开始时结束当前输入，键盘在拖动过程中收起。取消转场时，若其他控件没有取得焦点，
会恢复原输入框的焦点。

```rust tabs
nav_page()
    .title("Large title")
    .header_large_title(true)
    .child(scroll().flex_1())
```

```tsx tabs
<NavPage title="Large title" headerLargeTitle>
  <Scroll style={{ flex: 1 }}>…</Scroll>
</NavPage>
```

<a id="leaving-a-page"></a>

## 离开页面

`popOnBack={false}` 把用户留在页面上，比如表单有未保存的更改时。它为 false 期间，侧滑返回关闭，返回按钮和返回键调用 `onBackPress` 而不弹出页面。先询问用户，再自己弹出页面：

```rust tabs
use nsh_base::{alert_dialog, nav_page};
use nsh_core::prelude::*;

fn edit_note(routes: Signal<Vec<u32>>) -> Screen {
    let note = signal(String::new());
    let confirm = move || {
        spawn(async move {
            let choice = alert_dialog()
                .title("Discard your changes?")
                .cancel("keep", "Keep editing")
                .destructive("discard", "Discard")
                .show()
                .await;
            if choice.is_ok_and(|r| r.action.as_deref() == Some("discard")) {
                routes.update(|r| {
                    r.pop();
                });
            }
        });
    };
    nav_page()
        .title("Edit")
        .pop_on_back(move || note.with(String::is_empty))
        .on_back_press(move || {
            if !note.with(String::is_empty) {
                confirm();
            }
        })
        .child(
            input()
                .value(note)
                .on_change(move |v: &str| note.set(v.to_owned()))
                .placeholder("A note"),
        )
}
```

```tsx tabs
import { signal } from "nsh";
import { AlertDialog, NavPage, Input } from "nsh/base";

function EditNote() {
  const text = signal("");
  const confirm = async () => {
    const { action } = await AlertDialog.show({
      title: "Discard your changes?",
      actions: [
        { label: "Keep editing", role: "cancel", id: "keep" },
        { label: "Discard", role: "destructive", id: "discard" },
      ],
    });
    if (action === "discard") nav.pop();
  };
  return (
    <NavPage title="Edit" popOnBack={text().length === 0} onBackPress={() => text().length > 0 && confirm()}>
      <Input value={text()} onChange={({ value }) => text.set(value)} placeholder="A note" />
    </NavPage>
  );
}
```

> [!IMPORTANT]
> 系统在用户操作的那一刻、在主线程上询问用户能否返回，而主线程从不等待 JS 或你的 Rust 代码。所以 NSH 根据已经挂载的 `popOnBack` 值作答。一旦有可能丢失的内容，就在用户返回之前设置 `popOnBack={false}`。

每次按返回都会调用 `onBackPress`，页面弹出时也会，所以它也能告诉你用户返回了。只想关闭侧滑手势、保留返回按钮时，使用 `popOnSwipe={false}`。确认本身是一个 [AlertDialog](./alert-dialog.md)。

<a id="platform-notes"></a>

## 平台说明

- **iOS**：`UINavigationController`，带系统标题栏、返回按钮和侧滑返回；`headerLargeTitle` 是 UIKit 的大标题。转场进行期间到达的栈变化会在转场结束时应用。
- **Android**：带工具栏的页面栈。系统返回键弹出顶部页面，在支持的 Android 版本上带预测性返回；向上箭头给屏幕阅读器的描述是下面那个页面的 `headerBackTitle`，否则为系统的描述。要自己处理返回键，见 [`BackHandler`](../modules/nsh-mobile.md#backhandler) 中的 `BackHandler`。
- **Mac Catalyst**：与 iOS 相同。
- **桌面平台（macOS、Windows、Linux、GPUI）和 Web**：每个页面在顶部显示它的 `header`，内容位于其下方。桌面平台上 Escape、Alt+左方向键和鼠标的后退键返回，Web 上是浏览器的后退按钮。

要在栈及其标题栏之上显示内容，比如 sheet 或全屏流程，使用 [Dialog](./dialog.md)。
