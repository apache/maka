---
title: Navigation
description: Native navigation stacks with createNavStack, NavStack and NavPage, headers on every platform, keeping the user on a page with popOnBack, dialogs, and the Android back button.
order: 41
group: ui
---

# Navigation

`nsh_base` (TSX: `nsh/base`) provides a native navigation stack and native dialogs. A navigation stack (`nav_stack()` in Rust, `NavStack` in TSX) is a UINavigationController on iOS, with its header, swipe back and large titles, and a stack with a toolbar and predictive back on Android; on the desktops and the web, each page shows the header your app draws. You keep the routes in your state; the stack renders each route as a page and keeps it mounted, with its state, while it is in the stack.

In Rust, import the builders by name next to the prelude (`use nsh_base::{dialog, nav_page, nav_stack};`; system alerts are `nsh_base::alert_dialog()`). The routes are a signal and the stack's children are its pages, one per route, kept by key (`each`): a page goes in to push it and out to pop it. In TSX, `createNavStack` holds the routes and `NavStack` renders them.

```rust tabs
use nsh_base::{nav_page, nav_stack};
use nsh_core::prelude::*;

#[derive(Debug, Clone, PartialEq)]
enum Route {
    Inbox,
    Message(u32),
}

/// The page's header on the desktops and the web; iOS and Android show the system's, from `title`.
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
            // The user went back natively: drop the route (and those above it).
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

// The page's header on the desktops and the web; iOS and Android show the system's, from `title`.
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

## The stack's state

In Rust, the routes are your own signal (`signal(vec![..])`, or `global::<Routes>()` for one the whole app reaches), and you push, pop and replace by updating it: `routes.update(|r| r.push(route))`, `r.pop()`, `r.truncate(1)`, `routes.set(..)`. Each page's key (here the route's `Debug` text) tells the stack which page is which, so pages whose route stays keep their state; give routes that may repeat a unique key. Handle each page's `on_dismiss`: the user went back natively, and the route (with those above it) leaves your signal.

In TSX, `createNavStack(routes)` creates the stack's state from an array of routes, bottom to top. A route is any value you like (a string, an object, a discriminated union as above), and each push is a page of its own, the same route pushed twice included. Create the state once, at module level or in your root component, and import it wherever pages navigate.

| Member | Description |
|---|---|
| `routes()` | The routes, bottom to top (reactive). |
| `push(route)` | Pushes a page. |
| `pop(count?)` | Pops `count` pages (default 1); at least one stays. |
| `popToRoot()` | Pops back to the first page. |
| `replace(route)` | Replaces the top page. |
| `setRoutes(routes)` | Replaces the pages, e.g. after signing in; a route that stays (the same value) keeps its page and its state. |
| `remove(route)` | Removes the topmost page of `route`, wherever it is. |

To start several pages deep, pass more routes: `createNavStack<Route>([{ name: "inbox" }, { name: "message", id: 3 }])`.

When the user leaves a page natively (the back button in the header, a swipe back on iOS, Android's back button or gesture, the desktops' back keys and mouse button, the browser's back button), the TSX stack removes that route from its state for you, so `routes()` always matches what is on screen; a Rust page reports it with `on_dismiss`, as above.

A route carries what the page needs. The gallery apps push routes that hold what makes the page, which keeps the route type small when there are many pages:

```rust tabs
use std::rc::Rc;

use nsh_core::prelude::*;

/// A pushed page: its key (unique in the stack) and what makes it.
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

/// The pushed pages, bottom to top: one signal for the whole app.
#[derive(Default, Clone)]
pub struct Routes(pub Vec<Route>);

pub fn routes() -> Signal<Routes> {
    global::<Routes>()
}

// Elsewhere: routes().update(|r| r.0.push(Route { key: "settings".into(), page: Rc::new(settings) }));
```

```ts tabs
import { type JSX } from "nsh";
import { createNavStack } from "nsh/base";

export type Route = { name: "home" } | { name: "page"; page: () => JSX.Element };
export const nav = createNavStack<Route>([{ name: "home" }]);

// Elsewhere: nav.push({ name: "page", page: Settings });
```

## NavStack

In Rust, `nav_stack()` is a view whose children are its pages, bottom to top; style it as any view (`.flex_1()`). In TSX:

| Prop | Type | Description |
|---|---|---|
| `state` | `NavStackState<R>` | The routes to show. |
| `children` | `(route: R, index: Accessor<number>) => JSX.Element` | Renders a route; return a `<NavPage>` for its header. |
| `style`, `class` | | The stack's own style (usually `flex: 1`). |

The render function runs once per route, when it is pushed; `route` is the plain value, `index()` its current position. What it returns becomes the page's content. Return a `<NavPage>` to set the header; anything else is wrapped in a page with default options.

Pages stay mounted while their route is in the stack: going back shows the previous page exactly as it was left, with its scroll position, inputs and signals. A page's [`cleanup`](./reactivity.md) handlers run when its route leaves the stack.

## NavPage and the header

A page (`nav_page()` in Rust, `NavPage` in TSX) wraps a page's content and carries its header. iOS and Android show their system header, set up by the title and the header options. The desktops and the web show the page's header slot (`.header(..)`, TSX `header`), your own views, at the top of the page: as wide as the page, as tall as it lays out, with the content below it. Give a page both, as the example above does, and it looks at home everywhere. All options are reactive: change a signal and the header follows.

In Rust, each prop below is a method of `nav_page()` in snake case: `.title(..)`, `.header(..)`, `.header_visible(..)`, `.header_transparent(..)`, `.header_style_with(..)`, `.header_style(..)`, `.header_back_visible(..)`, `.header_left(..)`, `.header_right(..)`, `.header_title(..)`, `.header_large_title(..)`, `.header_back_title(..)`, `.animation(ScreenAnimation::Fade)`, `.status_bar(..)`, `.pop_on_swipe(..)`, `.pop_on_back(..)`, `.on_back_press(..)`, `.on_dismiss(..)`; its children are its content.

| Prop | Type | Default | Description |
|---|---|---|---|
| `header` | `JSX.Element` | | The desktops and the web: the page's header, drawn by the app (a title, a back button, toolbar buttons). |
| `title` | `string` | | iOS and Android: the system header's title. |
| `headerVisible` | `boolean` | `true` | iOS and Android: the system header shows. |
| `headerTransparent` | `boolean` | `false` | iOS and Android: the content extends under the header. |
| `headerStyle` | `{ backgroundColor?, color?, tintColor? }` | | iOS and Android: the header's background, the title's color (`color`) and the buttons' (`tintColor`). |
| `headerClass` | `string` | | The same as classes: `bg-*`, `text-*` for the title, `tint-*` for the buttons; `headerStyle` wins over them. |
| `headerBackVisible` | `boolean` | `true` | iOS and Android: the back button shows. |
| `headerLeft` | `JSX.Element` | | iOS and Android: views at the start of the header (they replace the back button). |
| `headerRight` | `JSX.Element` | | iOS and Android: views at the end of the header. |
| `ios={{ headerRightSystemItem }}` | `"add" \| "done" \| "close" \| "edit" \| "compose" \| "search" \| "share" \| "trash" \| "save" \| "cancel"` | | iOS: UIKit's own bar button at the end of the header, with the system's look, symbol or label, in place of `headerRight`'s views; a press on it is a press on the first pressable view of `headerRight`, so keep one there. Android shows `headerRight` as it is. |
| `headerTitle` | `JSX.Element` | | iOS and Android: views replacing the title. |
| `headerLargeTitle` | `boolean` | `false` | iOS: a large title that shrinks into the bar as the content scrolls. |
| `headerBackTitle` | `string` | | The label of the back button that leads back to this page (iOS; Android's up arrow says it to screen readers). |
| `animation` | `"default" \| "slide" \| "fade" \| "none"` | `"default"` | How the page enters and leaves. |
| `statusBar` | `{ foreground?, hidden?, animated? }` | | iOS and Android: the status bar while the page is on top ([Status bar](../modules/nsh-base.md#status-bar)). |
| `popOnSwipe` | `boolean` | `true` | The interactive back gesture (iOS swipe back, Android predictive back) pops. The back buttons pop either way. |
| `popOnBack` | `boolean` | `true` | Every way back pops the page: the back buttons, Android's back, the desktops' back keys, the browser's back button and the swipe. |
| `onBackPress` | `() => void` | | The user pressed back on the page, whether or not `popOnBack` let it pop. |
| `onDismiss` | `() => void` | | The user popped the page; its route is already removed. |
| `style`, `class` | | | The page's content view. |

Header items are ordinary views, so they can be pressable and reactive:

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

A colored system header (in Rust, `header_style_with` takes typed styles: `bg`, `text_color` and `tint_color`, the color of the header's buttons; theme colors follow the appearance):

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

A page that shows no header still has the system bars around it; pad its content by the [safe area](../elements/safe-area.md) insets:

```rust tabs
use nsh_base::nav_page;

nav_page()
    .header_visible(false)
    .child(view().flex_1().p_safe_area() /* … */)
```

```tsx tabs
<NavPage headerVisible={false}>
  <View class="flex-1 pt-[calc(env(safe-area-inset-top)+16px)] pb-[calc(env(safe-area-inset-bottom)+16px)] px-4">…</View>
</NavPage>
```

### Safe areas under the header

Inside a page, the `env(safe-area-inset-*)` variables and the page's insets (`Scope::insets` in Rust, `safeAreaInsets()` in TSX) are those below the system header, within the page. With a transparent header, the content starts at the top of the page and the top inset is the header's height, so padding by `env(safe-area-inset-top)` keeps text clear of it while a background image fills the whole page. With a large title, put a scroll view directly in the page so the title can collapse as it scrolls. On the desktops and the web, the content starts below the page's header slot.

## Keeping the user on a page: popOnBack

To ask before discarding unsaved changes, set `pop_on_back` (TSX `popOnBack`) to false while there is something to lose, handle the back press (`.on_back_press(..)`, TSX `onBackPress`), and pop once the user agrees:

```rust tabs
use nsh_base::{alert_dialog, nav_page};
use nsh_core::prelude::*;

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
import { signal } from "nsh";
import { AlertDialog, NavPage, Input } from "nsh/base";

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

With `pop_on_back(false)` (`popOnBack={false}`), the page stays on every way back (the back buttons, Android's back button and gesture, the desktops' back keys, the browser's back button, the swipe), and the back press event tells you the user tried. Popping from code (removing the route, `nav.pop()`) pops as always.

> [!IMPORTANT]
> `pop_on_back` / `popOnBack` is a prop, not a callback that returns true or false, because the main thread never waits for app code. When the user starts a swipe or presses back, the system asks right away whether the page may go, and NSH answers natively from the props it already has. Set it as soon as there is something to lose (as above, from the text), before the user tries to leave.

`pop_on_swipe(false)` (`popOnSwipe={false}`) is the lighter option: it turns off only the interactive gesture (iOS swipe back, Android's predictive back animation), and the back buttons still pop.

## Dialogs

A dialog (`dialog()` of `nsh_base` in Rust, `Dialog` in TSX) presents content over everything else, in its own native window layer: a presented view controller on iOS, a dialog window on Android, a layer over the whole window on the desktops and the web. Its look is yours. In Rust, the dialog is presented while it is in the view (inside a `when`) and its children fill it: draw the backdrop and the popup as views. In TSX, `class` and `style` style the popup that holds its children, `backdropClass` or `backdropStyle` add a backdrop behind it, and `open` controls it:

```rust tabs
use nsh_base::dialog;
use nsh_core::prelude::*;

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
                    // Escape, Android's back button, a swipe down on a sheet.
                    .on_cancel(move || open.set(false))
                    .child(
                        // The backdrop and the popup are the app's views.
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

Escape, Android's back button, a press on the backdrop (TSX's backdrop, a native sheet's in Rust) and a swipe down on a sheet close it natively (`close_on_escape`, `close_on_backdrop_press` and `close_on_swipe`, TSX `closeOnEscape`, `closeOnBackdropPress` and `closeOnSwipe`, each true by default). In Rust, `on_cancel` reports every attempt and `on_close` the close, so leave the dialog out of the view there; a backdrop your app draws closes it with its own press handler, as above. In TSX, `onOpenChange(false, reason)` tells you, so set `open` to `false` there. To confirm first, set a flag to false and handle the cancel event (`on_cancel`, `onCancel`), which reports every attempt, then close the dialog yourself. On iOS, `.presentation(ModalPresentation::PageSheet)` or `FormSheet` (`presentation="pageSheet"` or `"formSheet"`) presents a sheet that keeps what is behind visible.

See [Dialog](../elements/dialog.md) for every prop. Inside a dialog, the `env(safe-area-inset-*)` variables and the insets are the dialog's own. For system dialogs (an alert with actions, an action sheet) use [`AlertDialog`](../modules/nsh-base.md#alertdialog) from `nsh_base` (TSX: `nsh/base`).

## The Android back button

On Android, the back button (or gesture) is handled in this order:

1. The top dialog: it reports the cancel (`on_cancel`, `onCancel`), and closes while `close_on_escape` / `closeOnEscape` is true (the default).
2. Your back listeners (`on_back_press` in Rust, `BackHandler` from `nsh/mobile` in TSX), most recently added first.
3. The top stack: its top page reports the back press, and pops while `pop_on_back` / `popOnBack` is true.
4. Nothing handled it: the app exits.

A listener returns `true` when it handled the press, which keeps the stack from popping. While a listener is registered,
Android's back gesture does not preview the pop (the app answers only once the gesture ends), so add listeners only
while they may take the press:

```rust tabs
use nsh_core::prelude::*;

pub fn editor() -> impl IntoElement {
    let selecting = signal(false);
    // Listening only while selecting: otherwise the stack pops, with the gesture's preview.
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
import { BackHandler } from "nsh/mobile";

function Editor() {
  const selecting = signal(false);
  // Listening only while selecting: otherwise the stack pops, with the gesture's preview.
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

A listener made in an effect lasts until the effect runs again or its component goes; in TSX, the function
`BackHandler.onBackPress` returns also stops it. In TSX, `BackHandler.exitApp()` leaves the app; `nsh/mobile` can be imported on iOS too, where `BackHandler`'s calls return at once, so the same code runs on both platforms. See [Platform-specific code](./platform-specific.md).

## Tabs and other layouts

A tab bar is your own UI, drawn from primitives: a row of pressable views and a signal holding the selected tab; render the selected tab's content with [`when` / `<If>`](../elements/control-flow.md) (or a function child in TSX). To keep each tab's state while switching, give each tab its own stack and routes and keep all of them mounted, hiding the inactive ones with `display: none`.

## Related

- [`nsh/base`](../modules/nsh-base.md): the `nav_stack`, `nav_page`, `dialog`, `createNavStack`, `NavStack`, `NavPage` and `Dialog` reference; [Safe area](../elements/safe-area.md) for the insets.
- [The status bar](../modules/nsh-base.md#status-bar) of pages and dialogs.
- [`AlertDialog`](../modules/nsh-base.md#alertdialog).
- [`BackHandler`](../modules/nsh-mobile.md#backhandler): `BackHandler`.
