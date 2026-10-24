---
title: 导航
description: 用 createNavStack、NavStack 和 NavPage 构建原生导航栈，各平台的标题栏，用 popOnBack 把用户留在当前页面，对话框，以及 Android 返回键。
order: 41
group: ui
---

# 导航

`nsh_base`（TSX：`nsh/base`）提供原生的导航栈和原生的对话框。导航栈（Rust 中是 `nav_stack()`，TSX 中是 `NavStack`）在 iOS 上是 UINavigationController，带有它的标题栏、侧滑返回和大标题；在 Android 上是带工具栏、支持预测性返回的页面栈；在桌面和 Web 上，每个页面显示应用自己绘制的标题栏。路由保存在你的状态中；栈把每个路由渲染为一个页面，只要路由还在栈里，页面就保持挂载，状态也随之保留。

在 Rust 中，在 prelude 旁按名字导入这些构建函数（`use nsh_base::{dialog, nav_page, nav_stack};`；系统提示框是 `nsh_base::alert_dialog()`）。路由是一个 signal，栈的子元素就是它的页面，每个路由一个，按 key 保持（`each`）：放入页面即压入，移出即弹出。在 TSX 中，`createNavStack` 保存路由，`NavStack` 渲染它们。

```rust tabs
use nsh_base::{nav_page, nav_stack};
use nsh_core::ui::prelude::*;

#[derive(Debug, Clone, PartialEq)]
enum Route {
    Inbox,
    Message(u32),
}

/// 桌面和 Web 上页面的标题栏；iOS 和 Android 显示系统标题栏，取自 `title`。
fn header(routes: Signal<Vec<Route>>, title: &'static str) -> impl IntoElement {
    view()
        .h(px(48.0))
        .flex_row()
        .items_center()
        .gap_3()
        .border_b_1()
        .border_color(rgb(0xe5e7eb))
        .px_4()
        .child(when(
            move || routes.with(|r| r.len() > 1),
            move || {
                text("Back")
                    .role(AccessibilityRole::Button)
                    .on_press(move || routes.update(|r| { r.pop(); }))
                    .text_color(rgb(0x2563eb))
                    .active(|s| s.opacity(0.6))
            },
        ))
        .child(text(title).text_size(px(17.0)).font_weight(FontWeight::SEMIBOLD))
}

fn inbox(routes: Signal<Vec<Route>>) -> Screen {
    nav_page()
        .title("Inbox")
        .header(header(routes, "Inbox"))
        .child(scroll().flex_1().children((1..=5).map(move |id| {
            view()
                .on_press(move || routes.update(|r| r.push(Route::Message(id))))
                .p_4()
                .active(|s| s.bg(rgb(0xf3f4f6)))
                .child(text(format!("Message {id}")))
        })))
}

fn message(routes: Signal<Vec<Route>>, id: u32) -> Screen {
    nav_page()
        .title(format!("Message {id}"))
        .header(header(routes, "Message"))
        .child(view().flex_1().p(px(16.0)).child(text(format!("The body of message {id}."))))
}

#[component]
pub fn App() -> impl IntoElement {
    let routes = signal(vec![Route::Inbox]);
    nav_stack().flex_1().child(each(
        move || routes.get(),
        |route: &Route| format!("{route:?}"),
        move |route, index| {
            let page = match route.get_untracked() {
                Route::Inbox => inbox(routes),
                Route::Message(id) => message(routes, id),
            };
            // 用户以原生方式返回：移除这个路由（以及它上面的路由）。
            page.on_dismiss(move || routes.update(|r| r.truncate(index.get_untracked())))
        },
    ))
}
```

```tsx tabs
import { mount, Scroll, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

type Route = { name: "inbox" } | { name: "message"; id: number };

const nav = createNavStack<Route>([{ name: "inbox" }]);

// 桌面和 Web 上页面的标题栏；iOS 和 Android 显示系统标题栏，取自 `title`。
function Header(props: { title: string }) {
  return (
    <View class="h-12 flex-row items-center gap-3 border-b border-gray-200 px-4">
      <If when={nav.routes().length > 1}>
        <Text role="button" onPress={() => nav.pop()} class="text-blue-600 active:opacity-60">
          Back
        </Text>
      </If>
      <Text style={{ fontSize: 17, fontWeight: "600" }}>{props.title}</Text>
    </View>
  );
}

function Inbox() {
  return (
    <NavPage title="Inbox" header={<Header title="Inbox" />}>
      <Scroll style={{ flex: 1 }}>
        <Each of={[1, 2, 3, 4, 5]}>
          {(id) => (
            <View onPress={() => nav.push({ name: "message", id: id() })} class="p-4 active:bg-gray-100">
              <Text>Message {id()}</Text>
            </View>
          )}
        </Each>
      </Scroll>
    </NavPage>
  );
}

function Message(props: { id: number }) {
  return (
    <NavPage title={`Message ${props.id}`} header={<Header title={`Message ${props.id}`} />}>
      <View style={{ flex: 1, padding: 16 }}>
        <Text>The body of message {props.id}.</Text>
      </View>
    </NavPage>
  );
}

function App() {
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => {
        switch (route.name) {
          case "inbox":
            return <Inbox />;
          case "message":
            return <Message id={route.id} />;
        }
      }}
    </NavStack>
  );
}

mount(App);
```

<a id="the-stacks-state"></a>

## 栈的状态

在 Rust 中，路由就是你自己的 signal（`signal(vec![..])`，或整个应用都能访问的 `global::<Routes>()`），压入、弹出和替换就是更新它：`routes.update(|r| r.push(route))`、`r.pop()`、`r.truncate(1)`、`routes.set(..)`。每个页面的 key（这里是路由的 `Debug` 文本）告诉栈哪个页面是哪个，所以路由保留的页面会保留状态；可能重复的路由要给一个唯一的 key。处理每个页面的 `on_dismiss`：用户以原生方式返回了，这个路由（连同它上面的路由）要从你的 signal 中移除。

在 TSX 中，`createNavStack(routes)` 用一个从底到顶的路由数组创建栈的状态。路由可以是任何值（字符串、对象，或者像上面那样的可辨识联合类型），每次 push 都是一个独立的页面，同一个路由 push 两次也一样。状态只创建一次，放在模块顶层或根组件中，在需要导航的页面里导入它。

| 成员 | 说明 |
|---|---|
| `routes()` | 从底到顶的路由（响应式）。 |
| `push(route)` | 压入一个页面。 |
| `pop(count?)` | 弹出 `count` 个页面（默认 1）；至少保留一个。 |
| `popToRoot()` | 回到第一个页面。 |
| `replace(route)` | 替换栈顶页面。 |
| `setRoutes(routes)` | 替换页面，例如登录之后；保留下来的路由（同一个值）保留它的页面和状态。 |
| `remove(route)` | 移除 `route` 最上面的那个页面，无论它在哪个位置。 |

要一开始就处在多层深处，多传几个路由：`createNavStack<Route>([{ name: "inbox" }, { name: "message", id: 3 }])`。

当用户以原生方式离开页面时（标题栏的返回按钮、iOS 侧滑返回、Android 返回键或返回手势、桌面的返回键和鼠标返回键、浏览器的返回按钮），TSX 的栈会自动从状态中移除对应路由，所以 `routes()` 总是与屏幕上的内容一致；Rust 的页面像上面那样用 `on_dismiss` 报告。

路由携带页面需要的数据。gallery 示例应用推送的路由直接保存创建页面的函数，页面很多时路由类型依然很小：

```rust tabs
use std::rc::Rc;

use nsh_core::ui::prelude::*;

/// 一个压入的页面：它的 key（在栈中唯一）和创建它的函数。
#[derive(Clone)]
pub struct Route {
    pub key: SharedString,
    pub page: Rc<dyn Fn() -> Screen>,
}

impl PartialEq for Route {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

/// 压入的页面，从底到顶：整个应用共用一个 signal。
#[derive(Default, Clone)]
pub struct Routes(pub Vec<Route>);

pub fn routes() -> Signal<Routes> {
    global::<Routes>()
}

// 在别处： routes().update(|r| r.0.push(Route { key: "settings".into(), page: Rc::new(settings) }));
```

```ts tabs
import { type JSX } from "nsh";
import { createNavStack } from "nsh/base";

export type Route = { name: "home" } | { name: "page"; page: () => JSX.Element };
export const nav = createNavStack<Route>([{ name: "home" }]);

// 在别处： nav.push({ name: "page", page: Settings });
```

## NavStack

在 Rust 中，`nav_stack()` 是一个视图，它的子元素就是它的页面，从底到顶；像任何视图一样设置样式（`.flex_1()`）。在 TSX 中：

| 属性 | 类型 | 说明 |
|---|---|---|
| `state` | `NavStackState<R>` | 要显示的路由。 |
| `children` | `(route: R, index: Accessor<number>) => JSX.Element` | 渲染一个路由；返回 `<NavPage>` 以设置它的标题栏。 |
| `style`、`class` | | 栈自身的样式（通常是 `flex: 1`）。 |

渲染函数在每个路由被压入时运行一次；`route` 是原始值，`index()` 是它当前的位置。返回值成为页面内容。返回 `<NavPage>` 可以设置标题栏；返回其他内容时会自动包在一个使用默认选项的页面里。

只要路由还在栈中，页面就保持挂载：返回时，上一个页面与离开时完全相同，包括滚动位置、输入框和 signal。路由离开栈时，页面的 [`cleanup`](./reactivity.md) 处理函数会运行。

<a id="navpage-and-the-header"></a>

## NavPage 与标题栏

页面（Rust 中是 `nav_page()`，TSX 中是 `NavPage`）包裹页面内容并携带它的标题栏。iOS 和 Android 显示系统标题栏，由标题和标题栏选项设置。桌面和 Web 显示页面的标题栏插槽（`.header(..)`，TSX 的 `header`），即应用自己的视图，放在页面顶部：与页面同宽，高度由它自己的布局决定，内容位于它下方。像上面的例子那样两者都给，页面在每个平台上都显得自然。所有选项都是响应式的：改变 signal，标题栏随之更新。

在 Rust 中，下表的每个属性都是 `nav_page()` 上蛇形命名的方法：`.title(..)`、`.header(..)`、`.header_visible(..)`、`.header_transparent(..)`、`.header_style_with(..)`、`.header_style(..)`、`.header_back_visible(..)`、`.header_left(..)`、`.header_right(..)`、`.header_title(..)`、`.header_large_title(..)`、`.header_back_title(..)`、`.animation(ScreenAnimation::Fade)`、`.status_bar(..)`、`.pop_on_swipe(..)`、`.pop_on_back(..)`、`.on_back_press(..)`、`.on_dismiss(..)`；它的子元素就是页面内容。

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `header` | `JSX.Element` | | 桌面和 Web：页面的标题栏，由应用绘制（标题、返回按钮、工具栏按钮）。 |
| `title` | `string` | | iOS 和 Android：系统标题栏的标题。 |
| `headerVisible` | `boolean` | `true` | iOS 和 Android：显示系统标题栏。 |
| `headerTransparent` | `boolean` | `false` | iOS 和 Android：内容延伸到标题栏下方。 |
| `headerStyle` | `{ backgroundColor?, color?, tintColor? }` | | iOS 和 Android：标题栏背景色、标题颜色（`color`）和按钮颜色（`tintColor`）。 |
| `headerClass` | `string` | | 用类名设置同样的颜色：`bg-*`、标题用 `text-*`、按钮用 `tint-*`；`headerStyle` 优先。 |
| `headerBackVisible` | `boolean` | `true` | iOS 和 Android：显示返回按钮。 |
| `headerLeft` | `JSX.Element` | | iOS 和 Android：标题栏开头的视图（替换返回按钮）。 |
| `headerRight` | `JSX.Element` | | iOS 和 Android：标题栏末尾的视图。 |
| `ios={{ headerRightSystemItem }}` | `"add" \| "done" \| "close" \| "edit" \| "compose" \| "search" \| "share" \| "trash" \| "save" \| "cancel"` | | iOS：在标题栏末尾显示 UIKit 自带的按钮（系统的外观、图标或文字），代替 `headerRight` 的视图；按下它就是按下 `headerRight` 里第一个可按的视图，所以那里要放一个。Android 照常显示 `headerRight`。 |
| `headerTitle` | `JSX.Element` | | iOS 和 Android：替换标题的视图。 |
| `headerLargeTitle` | `boolean` | `false` | iOS：大标题，内容滚动时缩进标题栏。 |
| `headerBackTitle` | `string` | | 返回到本页面的返回按钮上的文字（iOS；Android 的向上箭头把它读给屏幕阅读器）。 |
| `animation` | `"default" \| "slide" \| "fade" \| "none"` | `"default"` | 页面进入和离开的方式。 |
| `statusBar` | `{ foreground?, hidden?, animated? }` | | iOS 和 Android：页面在最上层时的状态栏（[状态栏](../modules/nsh-base.md#status-bar)）。 |
| `popOnSwipe` | `boolean` | `true` | 交互式返回手势（iOS 侧滑返回、Android 预测性返回）会返回。返回按钮无论如何都会返回。 |
| `popOnBack` | `boolean` | `true` | 每一种返回方式都会弹出页面：返回按钮、Android 返回键、桌面的返回键、浏览器的返回按钮和侧滑。 |
| `onBackPress` | `() => void` | | 用户在页面上按了返回，无论 `popOnBack` 是否让它弹出。 |
| `onDismiss` | `() => void` | | 用户弹出了页面；路由已被移除。 |
| `style`、`class` | | | 页面的内容视图。 |

标题栏中的项目就是普通视图，所以可以按压，也是响应式的：

```rust tabs
fn compose(routes: Signal<Vec<Route>>) -> Screen {
    let draft = signal(String::new());
    let cancel = move || {
        text("Cancel")
            .on_press(move || routes.update(|r| { r.pop(); }))
            .text_size(px(17.0))
            .text_color(rgb(0x0969da))
    };
    let send_button = move || {
        text("Send")
            .on_press(move || send(draft.get()))
            .text_size(px(17.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(move || if draft.with(String::is_empty) { rgb(0x8c959f) } else { rgb(0x0969da) })
    };
    nav_page()
        .title("New message")
        .header_left(cancel())
        .header_right(send_button())
        .header(
            view()
                .h(px(48.0))
                .flex_row()
                .items_center()
                .justify_between()
                .px_4()
                .child(cancel())
                .child(text("New message").text_size(px(17.0)).font_weight(FontWeight::SEMIBOLD))
                .child(send_button()),
        )
        .child(
            input()
                .multiline(true)
                .value(move || draft.get())
                .on_change(move |t: &str| draft.set(t.to_owned()))
                .flex_1()
                .p(px(16.0))
                .text_size(px(17.0)),
        )
}
```

```tsx tabs
function Compose() {
  const text = signal("");
  const cancel = () => (
    <Text onPress={() => nav.pop()} style={{ fontSize: 17, color: "#0969da" }}>
      Cancel
    </Text>
  );
  const sendButton = () => (
    <Text
      onPress={() => send(text())}
      style={{ fontSize: 17, fontWeight: "600", color: text() ? "#0969da" : "#8c959f" }}
    >
      Send
    </Text>
  );
  return (
    <NavPage
      title="New message"
      headerLeft={cancel()}
      headerRight={sendButton()}
      header={
        <View class="h-12 flex-row items-center justify-between px-4">
          {cancel()}
          <Text style={{ fontSize: 17, fontWeight: "600" }}>New message</Text>
          {sendButton()}
        </View>
      }
    >
      <Input multiline value={text()} onChange={(t) => text.set(t)} style={{ flex: 1, padding: 16, fontSize: 17 }} />
    </NavPage>
  );
}
```

彩色系统标题栏（在 Rust 中，`header_style_with` 接收类型化的样式：`bg`、`text_color` 和标题栏按钮颜色 `tint_color`；主题颜色随外观切换）：

```rust tabs
nav_page()
    .title("Profile")
    .header_style_with(|s| s.bg(rgb(0x1a7f37)).text_color(rgb(0xffffff)).tint_color(rgb(0xffffff)))
```

```tsx tabs
<NavPage title="Profile" headerStyle={{ backgroundColor: "#1a7f37", color: "#ffffff", tintColor: "#ffffff" }}>
  …
</NavPage>
```

不显示标题栏的页面四周仍有系统栏；用 [`SafeAreaView`](../modules/nsh-base.md#safeareaview) 给内容留出边距：

```rust tabs
use nsh_base::{nav_page, safe_area_view};

nav_page()
    .header_visible(false)
    .child(safe_area_view().flex_1().p(px(16.0)) /* … */)
```

```tsx tabs
<NavPage headerVisible={false}>
  <SafeAreaView style={{ flex: 1, padding: 16 }}>…</SafeAreaView>
</NavPage>
```

### 标题栏下的安全区域

在页面内部，`SafeAreaView` 和页面的 inset（Rust 中是 `Scope::insets`，TSX 中是 `safeAreaInsets()`）是系统标题栏下方、页面之内的 inset。使用透明标题栏时，内容从页面顶部开始，顶部 inset 等于标题栏高度，因此 `SafeAreaView` 能让文字避开标题栏，同时背景图铺满整个页面。使用大标题时，把滚动视图直接放在页面里，标题才能随滚动收起。在桌面和 Web 上，内容从页面的标题栏插槽下方开始。

<a id="keeping-the-user-on-a-page-poponback"></a>

## 把用户留在当前页面：popOnBack

要在丢弃未保存的修改前先询问用户，就在有内容可能丢失时把 `pop_on_back`（TSX 的 `popOnBack`）设为 false，处理返回事件（`.on_back_press(..)`，TSX 的 `onBackPress`），并在用户同意后再返回：

```rust tabs
use nsh_base::{alert_dialog, nav_page};
use nsh_core::ui::prelude::*;

fn edit_note(routes: Signal<Vec<Route>>) -> Screen {
    let draft = signal(String::new());
    let confirm = move || {
        spawn(async move {
            let choice = alert_dialog()
                .title("Discard your changes?")
                .cancel("Keep editing")
                .destructive("Discard")
                .show()
                .await;
            if choice == Ok(Some("Discard".into())) {
                routes.update(|r| { r.pop(); });
            }
        });
    };
    nav_page()
        .title("Edit")
        .pop_on_back(move || draft.with(String::is_empty))
        .on_back_press(move || {
            if !draft.with(String::is_empty) {
                confirm();
            }
        })
        .child(
            input()
                .value(move || draft.get())
                .on_change(move |t: &str| draft.set(t.to_owned()))
                .placeholder("A note")
                .m(px(16.0))
                .text_size(px(17.0)),
        )
}
```

```tsx tabs
import { Input, signal } from "nsh";
import { AlertDialog, NavPage } from "nsh/base";

function EditNote() {
  const text = signal("");
  const dirty = () => text().length > 0;
  const confirm = async () => {
    const choice = await AlertDialog.show({
      title: "Discard your changes?",
      actions: [
        { label: "Keep editing", role: "cancel" },
        { label: "Discard", role: "destructive", id: "discard" },
      ],
    });
    if (choice === "discard") nav.pop();
  };
  return (
    <NavPage title="Edit" popOnBack={!dirty()} onBackPress={() => dirty() && confirm()}>
      <Input value={text()} onChange={(t) => text.set(t)} placeholder="A note" style={{ margin: 16, fontSize: 17 }} />
    </NavPage>
  );
}
```

`pop_on_back(false)`（`popOnBack={false}`）时，每一种返回方式（返回按钮、Android 返回键和返回手势、桌面的返回键、浏览器的返回按钮、侧滑）都会让页面留下，返回事件告诉你用户试图返回。从代码返回（移除路由、`nav.pop()`）照常生效。

> [!IMPORTANT]
> `pop_on_back` / `popOnBack` 是一个属性，而不是返回 true 或 false 的回调，因为主线程从不等待应用代码。用户开始侧滑或按下返回时，系统会立即询问页面能否离开，NSH 根据已有的属性在原生端直接回答。所以要在有内容可能丢失时就设置它（像上面那样根据文本决定），赶在用户试图离开之前。

`pop_on_swipe(false)`（`popOnSwipe={false}`）是较轻的选择：它只关闭交互式手势（iOS 侧滑返回、Android 预测性返回动画），返回按钮仍会返回。

<a id="dialogs"></a>

## 对话框

对话框（Rust 中是 `nsh_base` 的 `dialog()`，TSX 中是 `Dialog`）在其他所有内容之上呈现内容，处于独立的原生窗口层：iOS 上是被 present 的视图控制器，Android 上是一个对话框窗口，桌面和 Web 上是覆盖整个窗口的一层。它的外观由你决定。在 Rust 中，对话框在视图中时（放在 `when` 里）就会呈现，它的子元素铺满它：把背景（backdrop）和弹出层（popup）画成视图。在 TSX 中，`class` 和 `style` 设置容纳子元素的弹出层，`backdropClass` 或 `backdropStyle` 在它后面加一层背景，用 `open` 控制它：

```rust tabs
use nsh_base::dialog;
use nsh_core::ui::prelude::*;

pub fn files() -> impl IntoElement {
    let open = signal(false);
    view()
        .flex_1()
        .child(view().on_press(move || open.set(true)).p(px(16.0)).child(text("Delete the file")))
        .child(when(
            move || open.get(),
            move || {
                dialog()
                    .animation(ModalAnimation::Fade)
                    // Escape、Android 返回键、在表单上下滑。
                    .on_cancel(move || open.set(false))
                    .child(
                        // 背景和弹出层都是应用自己的视图。
                        view()
                            .flex_1()
                            .bg(rgba(0x00000066))
                            .items_center()
                            .justify_center()
                            .on_press(move || open.set(false))
                            .child(
                                view()
                                    .w(px(320.0))
                                    .gap_3()
                                    .rounded_2xl()
                                    .bg(white())
                                    .p_5()
                                    .on_press(|| {})
                                    .child(text("Delete the file?").text_size(px(20.0)).font_weight(FontWeight::BOLD))
                                    .child(
                                        view()
                                            .on_press(move || open.set(false))
                                            .child(text("Delete").text_color(rgb(0xcf222e))),
                                    ),
                            ),
                    )
            },
        ))
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";

function Files() {
  const open = signal(false);
  return (
    <View style={{ flex: 1 }}>
      <View onPress={() => open.set(true)} style={{ padding: 16 }}>
        <Text>Delete the file</Text>
      </View>
      <Dialog
        open={open()}
        animation="fade"
        onOpenChange={(next) => open.set(next)}
        backdropClass="bg-black/40"
        class="m-auto w-80 gap-3 rounded-2xl bg-white p-5"
      >
        <Text style={{ fontSize: 20, fontWeight: "700" }}>Delete the file?</Text>
        <View onPress={() => open.set(false)}>
          <Text style={{ color: "#cf222e" }}>Delete</Text>
        </View>
      </Dialog>
    </View>
  );
}
```

Escape、Android 返回键、点击背景（TSX 的背景，Rust 中是原生表单的背景）和在表单上下滑都会以原生方式关闭它（`close_on_escape`、`close_on_backdrop_press` 和 `close_on_swipe`，TSX 的 `closeOnEscape`、`closeOnBackdropPress` 和 `closeOnSwipe`，默认都是 true）。在 Rust 中，`on_cancel` 报告每一次尝试，`on_close` 报告关闭，所以在那里把对话框移出视图；应用自己画的背景用它自己的按压处理关闭对话框，如上所示。在 TSX 中，`onOpenChange(false, reason)` 通知你，所以在那里把 `open` 设为 `false`。要先确认，就把对应开关设为 false 并处理取消事件（`on_cancel`、`onCancel`，它报告每一次尝试），然后自己关闭对话框。在 iOS 上，`.presentation(ModalPresentation::PageSheet)` 或 `FormSheet`（`presentation="pageSheet"` 或 `"formSheet"`）呈现一个保留后面内容可见的表单。

全部属性见 [Dialog](../elements/dialog.md)。在对话框内部，`SafeAreaView` 和 inset 都是对话框自己的。系统对话框（带操作的提示框、操作表）请用 `nsh_base`（TSX：`nsh/base`）的 [`AlertDialog`](../modules/nsh-base.md#alertdialog)。

## Android 返回键

在 Android 上，返回键（或返回手势）按以下顺序处理：

1. 最上层的对话框：报告取消（`on_cancel`、`onCancel`），`close_on_escape` / `closeOnEscape` 为 true（默认）时关闭。
2. 你的返回监听器（Rust 中是 `on_back_press`，TSX 中是 `nsh/android` 的 `BackHandler`），最近添加的最先执行。
3. 最上层的栈：栈顶页面报告返回事件，`pop_on_back` / `popOnBack` 为 true 时弹出。
4. 都没有处理：应用退出。

监听器处理了按键时返回 `true`，栈就不会弹出。注册了监听器时，Android 的返回手势不会预览弹出效果（手势结束后应用才给出答复），所以只在监听器可能处理按键时才注册它：

```rust tabs
use nsh_core::ui::prelude::*;

pub fn editor() -> impl IntoElement {
    let selecting = signal(false);
    // 只在选择时监听：其他时候由栈返回，并带有手势的预览。
    effect(move || {
        if selecting.get() {
            on_back_press(move || {
                selecting.set(false);
                true
            });
        }
    });
    // …
    view()
}
```

```tsx tabs
import { effect, signal } from "nsh";
import { BackHandler } from "nsh/android";

function Editor() {
  const selecting = signal(false);
  // 只在选择时监听：其他时候由栈返回，并带有手势的预览。
  effect(() => {
    if (selecting()) {
      BackHandler.onBackPress(() => {
        selecting.set(false);
        return true;
      });
    }
  });
  // …
}
```

在 effect 中创建的监听器一直有效，直到 effect 再次运行或它的组件消失；在 TSX 中，调用 `BackHandler.onBackPress` 返回的函数也会停止它。在 TSX 中，`BackHandler.exitApp()` 退出应用；在 iOS 上也可以导入 `nsh/android`，它的调用什么都不做，所以同一份代码可以在两个平台上运行。见[平台特定代码](./platform-specific.md)。

## 标签页与其他布局

标签栏是应用自己的界面，用基础元素绘制：一排可按压的视图加一个保存当前标签的 signal；用 [`when` / `<If>`](../elements/control-flow.md)（或 TSX 中的函数子元素）渲染选中标签的内容。要在切换时保留每个标签的状态，给每个标签一个独立的栈和路由，并让它们都保持挂载，用 `display: none` 隐藏未选中的标签。

## 相关内容

- [`nsh/base`](../modules/nsh-base.md)：`nav_stack`、`nav_page`、`dialog`、`createNavStack`、`NavStack`、`NavPage`、`Dialog` 和 `SafeAreaView` 参考。
- 页面和对话框的[状态栏](../modules/nsh-base.md#status-bar)。
- [`AlertDialog`](../modules/nsh-base.md#alertdialog)。
- [`nsh/android`](../modules/nsh-android.md)：`BackHandler`。
