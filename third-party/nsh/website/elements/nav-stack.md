---
title: NavStack
description: "Native navigation stacks: NavStack, NavPage and createNavStack, pushing and popping pages, header slots, leaving a page and how each platform shows a stack."
group: base
demo: ui-navigation
---

# NavStack

A navigation stack shows one page at a time and keeps the pages below it: `UINavigationController` on iOS and Mac
Catalyst, with the system header and swipe back, and a stack of pages with a toolbar and predictive back on Android.
On the desktops (macOS, Windows, Linux, GPUI) and the web, each page shows the app's own header at its top, and the
back keys and the browser's back button pop the page. `NavStack` is the stack, `NavPage` one of its pages.

The stack owns the navigation behavior (transitions, the back gestures and buttons, the pages' state while they are
covered); the pages' content and the desktop header are the app's own.

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

On iOS and Android the page shows the system header with `title` and a back button; on the desktops and the web it
shows `header`. An app that targets only phones leaves `header` out; one that targets only desktops leaves out the
system header's options. The [Navigation guide](../docs/navigation.md) walks through a whole app's navigation: the
stack's state, dialogs, the Android back button and tabs.

## How a stack works

- The stack's pages are **routes**: values of your choosing, from the bottom of the stack to the top. A route usually
  names the page and carries its parameters.
- In TSX the routes live in the state `createNavStack` makes. `NavStack` calls its child function once for each push
  and shows the result as a page. It keeps that page while its route is in the stack, so a page keeps its state
  (signals, scroll position, inputs) while other pages cover it.
- In Rust the stack's children are its pages: a `nav_page()` put into `nav_stack()` is pushed, and one left out is
  popped. Keep the routes in a signal and render the pages with `each(..)`, keyed by route, so that the pages below keep
  their state.
- Each push is a page of its own, the same route value pushed twice included.
- When the user leaves a page natively (the back button, swipe back, Android back, the desktops' back keys, the
  browser's back), the page goes. In TSX the stack removes its route from the state, so `nav.routes()` always matches
  what the user sees. In Rust the page reports `on_dismiss`, where you drop its route (and the routes above it).
- In TSX, a child function that returns something other than a `<NavPage>` gets a page with default options. Return
  a `<NavPage>` to set its header and other options.

## createNavStack

```ts
function createNavStack<R>(routes: R[]): NavStackState<R>
```

Creates the state of a stack that starts with `routes`, bottom to top. Create it once, for example at module level,
and pass it to `<NavStack state>`. Any code can import it to navigate.

| Member | Description |
|---|---|
| `routes: Accessor<readonly R[]>` | The routes, bottom to top. Reactive. |
| `push(route: R): void` | Pushes a page. |
| `pop(count?: number): void` | Pops `count` pages (default 1). At least one page always stays. |
| `popToRoot(): void` | Pops back to the first page. |
| `replace(route: R): void` | Replaces the top page. |
| `setRoutes(routes: R[]): void` | Replaces the pages; a route that stays (the same value) keeps its page and its state. |
| `remove(route: R): void` | Removes the topmost page of `route` (compared with `===`), wherever it is in the stack. |

In Rust the same operations are changes of your routes signal: `routes.update(|r| r.push(route))` pushes,
`r.pop()` pops, `r.truncate(1)` pops back to the first page you keep in it, and `routes.set(..)` replaces the pages.

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

## NavStack props

| Prop | Rust | Type | Description |
|---|---|---|---|
| `state` | the pages are its children | `NavStackState<R>` | The state that holds the routes (`createNavStack`). Required. |
| `children` | `.child(..)` | `(route: R, index: Accessor<number>) => JSX.Element` | Renders a route. Return a `<NavPage>` for its options. Required. |
| `style`, `class` | style methods | | The stack's style; usually `flex: 1`. |
| `testID` | `.test_id(..)` | `string` | Finds the stack in tests and `nsh test --trace`. |

The TSX child function receives the route value itself and an accessor of its position in the stack.

## NavPage props

`NavPage` is one page of a stack. It holds the page's content, its `header` on the desktops and the web, and the
options of the system header on iOS and Android. In Rust, `nav_page()` returns the page and its builder methods are
the props' snake-case names.

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `header` | `.header(..)` | `JSX.Element` | none | Desktops and the web: the page's header, placed at the top of the page, as wide as the page and as tall as it lays out, with the content below it. |
| `title` | `.title(..)` | `string` | none | iOS and Android: the system header's title. |
| `headerVisible` | `.header_visible(..)` | `boolean` | `true` | iOS and Android: the system header shows. |
| `headerTransparent` | `.header_transparent(..)` | `boolean` | `false` | iOS and Android: the content extends under a transparent system header. |
| `hidesBottomBarWhenPushed` | `.hides_bottom_bar_when_pushed(..)` | `boolean` | `false` | iOS: the system tab bar leaves while this page is on top, moving in the transition — the same animation as the page, and the bar is never rebuilt; it comes back when the page pops. |
| `headerLargeTitle` | `.header_large_title(..)` | `boolean` | `false` | iOS: a large title that shrinks into the bar as the content scrolls; the content scrolls under the header. |
| `headerBackTitle` | `.header_back_title(..)` | `string` | none | iOS and Android: the label of the back button that leads back to this page (on Android, its description for screen readers). |
| `headerBackVisible` | `.header_back_visible(..)` | `boolean` | `true` | iOS and Android: the back button shows. |
| `headerLeft` | `.header_left(..)` | `JSX.Element` | none | iOS and Android: content at the leading edge of the system header, in place of the back button. |
| `headerRight` | `.header_right(..)` | `JSX.Element` | none | iOS and Android: content at the trailing edge of the system header. |
| `headerTitle` | `.header_title(..)` | `JSX.Element` | none | iOS and Android: content that replaces the title. |
| `headerStyle` | `.header_style(..)` | `{ backgroundColor?, color?, tintColor? }` | platform | iOS and Android: the system header's colors: its background, the title's (`color`) and the buttons' (`tintColor`). |
| `headerClass` | `.header_style_with(\|s\| ..)` | `string` | none | The same colors as classes: `bg-*`, `text-*` for the title, `tint-*` for the buttons (in Rust `.bg(..)`, `.text_color(..)`, `.tint_color(..)`, theme colors following the appearance). `headerStyle` wins over them. |
| `popOnBack` | `.pop_on_back(..)` | `boolean` | `true` | The back buttons and the swipe back pop the page. See [Leaving a page](#leaving-a-page). |
| `popOnSwipe` | `.pop_on_swipe(..)` | `boolean` | `true` | The interactive back gesture pops the page: iOS swipe back, Android predictive back that follows the finger. The back buttons pop either way. |
| `animation` | `.animation(..)` | `"default" \| "slide" \| "fade" \| "none"` | `"default"` | How the page enters and leaves. |
| `statusBar` | `.status_bar(..)` | `{ foreground?, hidden?, animated? }` | none | iOS and Android: the status bar while the page is on top. See [Status bar](../modules/nsh-base.md#status-bar). |
| `style`, `class` | style methods | | none | The page's style. |
| `children` | `.child(..)` | `JSX.Element` | none | The content. |
| `testID` | `.test_id(..)` | `string` | none | Finds the page in tests and `nsh test --trace`. |

## NavPage events

| Event | Rust | Description |
|---|---|---|
| `onBackPress` | `.on_back_press(..)` | The user pressed back on the page (the header's back button, Android back, Escape, Alt+Left or a mouse's back button on the desktops, the browser's back), whether or not `popOnBack` let it pop. |
| `onDismiss` | `.on_dismiss(..)` | The user popped the page (back button, swipe); its route is gone in TSX, and Rust drops it here. |

## Header slots

`header`, `headerLeft`, `headerRight` and `headerTitle` are slots: ordinary elements that read signals, handle presses
and update while the page is shown. `header` is the app's whole header on the desktops and the web; the other three
go into the system header on iOS and Android.

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

The page's content starts below the header: below an opaque system header on iOS and Android, below `header` on the
desktops and the web. With `headerTransparent`, `headerLargeTitle` or `headerVisible={false}`, it starts at the top of
the page on iOS and Android; use [`env(safe-area-inset-top)`](./safe-area.md) or `safeAreaInsets()` to keep it clear of the
header and the status bar.

On iOS, `headerVisible={false}` keeps swipe back enabled while `popOnSwipe` and `popOnBack` are true.
An accepted interactive back gesture ends editing as the transition starts, so the keyboard dismisses during the
drag. Cancelling the transition restores the same editor's focus when another control has not taken it.

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

## Leaving a page

`popOnBack={false}` keeps the user on a page, for example while a form has unsaved changes. While it is false, swipe
back is off and the back buttons and keys call `onBackPress` without popping. Ask the user, then pop yourself:

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
> The system asks whether the user may go back on the main thread, at the moment the user acts, and the main thread
> never waits for JS or for your Rust code. So NSH answers from the `popOnBack` value already mounted. Set
> `popOnBack={false}` as soon as there is something to lose, before the user goes back.

`onBackPress` is called on every back press, also when the page pops, so it also tells you that the user went back.
To turn off only the swipe gesture and keep the back buttons, use `popOnSwipe={false}`. The confirmation itself is an
[AlertDialog](./alert-dialog.md).

## Platform notes

- **iOS**: `UINavigationController` with the system header, back button and swipe back; `headerLargeTitle` is UIKit's
  large title. Stack changes that arrive during a running transition are applied when it ends.
- **Android**: a stack with a toolbar. The system back button pops the top page, with predictive back on Android
  versions that have it; the up arrow's description for screen readers is the lower page's `headerBackTitle`, or the
  system's. See `BackHandler` in [`BackHandler`](../modules/nsh-mobile.md#backhandler) to handle the back button yourself.
- **Mac Catalyst**: as on iOS.
- **Desktops (macOS, Windows, Linux, GPUI) and the web**: each page shows its `header` at the top and its content
  below it. Escape, Alt+Left and a mouse's back button go back on the desktops, the browser's back button on the web.

For content shown over the stack and its header, such as a sheet or a full-screen flow, use a
[Dialog](./dialog.md).
