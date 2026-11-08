# Building UI in Rust with nsh_base

Read [rust.md](rust.md) first. This page goes family by family: the real constructor, the props and events that matter,
one snippet, and what trips people up. Full prop tables and Rust examples are at
`https://nsh.dev/elements/{name}.md` (`website/elements/` in an NSH checkout).
Check the project’s resolved crate source when its version differs from the site.

Host elements come from `nsh_core::prelude`: `view`, `text`, `scroll`, `image`, `svg`, `virtual_list`, `canvas`,
`video`, `web_view`. Everything else comes from `nsh_base`, including `input`, which the prelude does **not** export.

## Rules for all of nsh_base

- **It has no look.** Each base component provides behavior: focus, keyboard, placement, what screen readers hear. A
  `button()` with no styles is an invisible box the size of its child. Wrap each one once in your own `ui/` module.
- **Parts draw nothing until styled.** A part is reached by a `*_style(|s| ..)` or `*_class("..")` prop, not by the
  element's own methods. The element's own `.bg(..)`, `.px_4()` style its root only. A `switch()` with no `track_style`
  and `thumb_style` shows only its label. A `tabs()` indicator with no `indicator_style` does not exist visually. A
  `menu_separator()` with no height and background is zero points tall. A `select()` popup with no `popup_style` has no
  background, so rows float over the page.
- **Popups and sheets paint nothing behind their content.** The popup is yours: give it `.bg`, `.rounded`, `.shadow_*`.
- **`*_style` closures get a `StyleRefinement`**, so `.checked(|s| ..)`, `.selected(..)`, `.active(..)` work inside them.
  Use state styles there, not a signal.
- **Some states are reachable only by class** on parts the app does not build: `.item_class("focus:bg-accent
  selected:font-medium disabled:opacity-50")`. That is the case for writing a class string in Rust.
- **Controlled or not.** `open`, `value` and `checked` are the owner's when set, so follow the event or nothing appears to
  happen. `open: Prop<Option<bool>>`: leave it out and the component keeps its own, or use `.default_open(true)`.
- **Setter types follow the field.** A `Prop<Option<T>>` takes `T` for text (`.placeholder("x")`), but a closure must
  return the `Option`: `.value(move || Some(tags.get()))`. A `Prop<SelectValue>` takes `Option<SharedString>` through
  `SelectValue`'s `From`.

## Buttons and links

`button()`: `disabled`, `selected`, `selected_style`, `accessibility_label`, `role`, `hit_slop`; `on_press`,
`on_press_down`, `on_press_up`. `link()`: `href`, `open_with`, `disabled`, `current`, `accessibility_label`, `hit_slop`;
`on_open(&SharedString)`, `on_press`.

```rust
use nsh_base::{button, link, theme};
use nsh_core::prelude::*;

/// The app's button: wrap once, use everywhere.
pub fn primary(label: impl IntoReactive<SharedString>, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .h_9()
        .px_4()
        .items_center()
        .justify_center()
        .rounded(move || theme().radius)
        .bg(move || theme().primary)
        .active(|s| s.opacity(0.85))
        .focus(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .disabled_style(|s| s.opacity(0.5))
        .child(text(label).text_sm().text_color(move || theme().primary_foreground))
}

pub fn docs() -> impl IntoElement {
    link()
        .href("https://nsh.dev/docs")
        .text_color(move || theme().primary)
        .underline()
        .hover(|s| s.opacity(0.8))
        .child(text("Read the docs"))
}
```

- Use `button()`, not `view().on_press(..)`, for anything a keyboard or screen reader must reach. `view().on_press` has
  no role or focus until you add them.
- No built-in press feedback on any platform. Without `.active(..)`, a press looks like nothing happened.
- Keep touch targets 44 points on phones. `.hit_slop(EdgeInsets::all(px(10.0)))` grows a small icon's target.
- An icon-only button needs `.accessibility_label("Close")`. Tests can then use it as a selector as well.
- A link with `href` opens it itself and reports `on_open`. Do not also call `open_url` from `on_press`.

## Inputs, forms and keyboard

`input()` setters: `value`, `default_value`, `placeholder`, `placeholder_color`, `caret_color`, `selection_color`,
`masked`, `multiline`, `readonly`, `max_length`, `keyboard_type`, `return_key_type`, `submit_behavior`, `auto_capitalize`,
`auto_correct`, `auto_fill`, `auto_focus`, `selected_range`. Listeners: `on_change(&str)`, `on_submit(&str)`, `on_focus`,
`on_blur`, `on_key_press(&str)`, `on_selection_change`, `on_composition_change`, `on_paste`.

```rust
use nsh_base::{input, theme};
use nsh_core::{element::AutoFill, prelude::*};

/// The app's text field.
fn field(placeholder: &'static str, value: Signal<String>) -> Input {
    input()
        .value(move || value.get())
        .on_change(move |text: &str| value.set(text.to_owned()))
        .placeholder(placeholder)
        .placeholder_color(|| color(theme().muted_foreground))
        .caret_color(|| color(theme().primary))
        .h_9()
        .px_3()
        .text_sm()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().input)
        .focus(|s| s.border_color(move || theme().ring))
}

#[component]
pub fn SignIn() -> impl IntoElement {
    let email = signal(String::new());
    let password = signal(String::new());
    let password_field = element_ref();
    let can_submit = computed(move || email.with(|e| e.contains('@')) && password.with(|p| !p.is_empty()));
    let submit = move || {
        if can_submit.get_untracked() {
            dismiss_keyboard();
            log::info!("sign in {}", email.get_untracked());
        }
    };
    // The form scrolls, so the focused input is kept above the keyboard natively.
    scroll()
        .flex_1()
        .keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)
        .keyboard_taps(KeyboardTaps::Handled)
        .child(
            view()
                .p_4()
                .gap_3()
                .child(
                    field("E-mail", email)
                        .keyboard_type(KeyboardType::Email)
                        .auto_capitalize(AutoCapitalize::None)
                        .auto_fill(AutoFill::Email)
                        .return_key_type(ReturnKeyType::Next)
                        .submit_behavior(SubmitBehavior::Submit)
                        .on_submit(move |_: &str| password_field.focus()),
                )
                .child(
                    field("Password", password)
                        .element_ref(&password_field)
                        .masked(true)
                        .return_key_type(ReturnKeyType::Go)
                        .on_submit(move |_: &str| submit()),
                )
                .child(view().on_press(submit).child(text("Sign in"))),
        )
}

/// A key of the app. Goes with the owner, as any listener does.
fn shortcuts(find: Signal<bool>) {
    on_key("mod+k", move |_| find.set(true));
}
```

- Controlled input: `.value` and `.on_change` together. Without `.on_change` writing the signal, typing is thrown back.
  For a value the app never reads while typing, `.default_value` is simpler and avoids a round trip per key.
- Do not transform text on a CJK composition. While `on_composition_change` reports composing, do not search or rewrite
  `value`: it breaks pinyin. See `website/docs/forms-and-keyboard.md`, "Controlled and uncontrolled inputs".
- `placeholder_color`, `caret_color` and `selection_color` take a resolved `Hsla`, not `AdaptiveColor`. Wrap the token in
  `color(..)` inside a closure, so that it follows the appearance.
- A single-line input's return is `SubmitBehavior::BlurAndSubmit` by default: it loses focus. Use `Submit` to stay focused
  while moving to the next field.
- In a `scroll`, the keyboard inset is handled natively. For a bar pinned under a list (a chat), use `.pb_keyboard()` on
  the screen's root; do not read `keyboard_height()` per frame.
- `on_key` takes keystrokes such as `"mod+k"` (`mod` is Command on Apple platforms, Control elsewhere), `"shift+mod+l"`,
  `"escape"`, `"f5"`. A keystroke that is not one, or one the platform keeps (Command+Q), **panics**. Desktop platforms fire
  them; elsewhere no key does, so never make one the only way to reach an action. `key_label(..)` gives the label to show.
- `checkbox()`, `switch()`, `radio_group()`, `slider()`, `number_input()`, `otp_input()`, `time_field()`, `date_picker()`
  follow the same controlled pattern: `.checked(signal).on_change(move |v: &bool| signal.set(*v))`. `switch()` needs
  `track_style` and `thumb_style` and `checkbox()` needs `indicator_style`, or nothing is drawn. See
  `website/elements/switch.md`.

## Select and combobox

`select()` picks one; `combobox()` types to filter and may pick many. Items are data: `SelectItem::new(value, title)`,
with `.disabled(bool)`.

| | `select()` | `combobox()` |
|---|---|---|
| Value | `.value(move \|\| chosen.get())`, an `Option<SharedString>` | `.value(move \|\| Some(chosen.get()))`, a `Vec<SharedString>` |
| Listener | `on_change(&Option<SharedString>)` | `on_change(&Vec<SharedString>)`, `on_query_change(&SharedString)` |
| The closed control | `.trigger(element)`, a slot you draw | Styles on the element itself, `.input_style(..)`, `.trigger_button(..)` |
| Search | `.searchable(true)` | Always |

```rust
use nsh_base::{SelectEntry, SelectEvent, SelectItem, select, theme};
use nsh_core::prelude::*;

fn fruit_select() -> impl IntoElement {
    let fruit = signal(None::<SharedString>);
    let items = vec![SelectItem::new("apple", "Apple"), SelectItem::new("kiwi", "Kiwi").disabled(true)];
    select()
        .items(items)
        .value(move || fruit.get())
        .on_change(move |next: &Option<SharedString>| fruit.set(next.clone()))
        .on_open_change(|e: &SelectEvent| {
            if let SelectEvent::OpenChange(open, reason) = e {
                log::debug!("{open} {reason:?}");
            }
        })
        .accessibility_label("Fruit")
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_1()
                .rounded_lg()
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().popover)
                .shadow_md()
        })
        .item_class("rounded-md focus:bg-accent selected:font-medium disabled:opacity-50")
        .render_item(|item: &SelectEntry| view().px_2().py_1p5().child(text(item.title.clone()).text_sm()))
        .trigger(
            view()
                .h_9()
                .px_3()
                .justify_center()
                .rounded_md()
                .border_1()
                .border_color(move || theme().input)
                .child(text(move || fruit.get().unwrap_or("Pick a fruit".into()))),
        )
}
```

- Without `.trigger(..)` there is nothing to press. The trigger's text is yours to bind to the value.
- `.render_item` runs once per item, like a cell: use `group-selected:`-style states for the look, not a signal read.
- On phones and tablets it presents as a sheet, and on desktops as a popup over the trigger. Test with `popup_style`
  on both, and do not set a width that assumes one of them.
- `popup_style` and `item_class` are the only way to reach those parts; `.bg(..)` on `select()` does nothing to the popup.
- On a `combobox()`, `.placeholder(closure)` is how the closed text follows the selection; there is no trigger slot.
- For a command palette, use `command()` (`website/elements/command.md`); do not stretch `combobox`.

## Dialogs, sheets, popovers, menus, toasts

| Need | Use | Mount |
|---|---|---|
| Native confirm or action sheet | `alert_dialog()..show().await` | A task; no element |
| Full native modal (own window layer) | `dialog()` | In `when(open, ..)`; leaving it out dismisses |
| Panel sliding from an edge | `sheet()` | Always in the tree, `.open(..)` |
| Anchored content | `popover()` | `.trigger(..)`, `.child(..)` |
| Commands on a trigger, or on right-click | `menu()`, `context_menu()` | `.trigger(..)`, `menu_item()` children |
| Hint on hover | `tooltip()` | Wraps the anchor (`website/elements/tooltip.md`) |
| Transient message | `toast_stack()`, `toast()`, `ToastManager` | Mounted once, app-level |

```rust
use nsh_base::{
    OpenChangeReason, PopoverEvent, SheetEvent, alert_dialog, dialog, menu, menu_item, menu_separator, popover, sheet,
    theme,
};
use nsh_core::prelude::*;

/// A native confirm. Do this in a task, never by blocking.
fn confirm_delete(deleted: Signal<bool>) {
    spawn(async move {
        let answer = alert_dialog()
            .title("Delete the photo?")
            .description("This cannot be undone.")
            .cancel("cancel", "Cancel")
            .destructive("delete", "Delete")
            .show()
            .await;
        if matches!(answer, Ok(r) if r.action.as_deref() == Some("delete")) {
            deleted.set(true);
        }
    });
}

/// A dialog: in the view while open.
fn compose(open: Signal<bool>) -> impl IntoElement {
    when(open, move || {
        dialog()
            .presentation(ModalPresentation::PageSheet)
            .on_cancel(move || open.set(false))
            .flex_1()
            .bg(move || theme().background)
            .child(view().flex_1().p_safe_area().child(text("Compose")))
    })
}

/// A sheet: always in the tree, its content made while open.
fn filters(open: Signal<bool>) -> impl IntoElement {
    sheet()
        .open(move || Some(open.get()))
        .on_open_change(move |e: &SheetEvent| {
            if let SheetEvent::OpenChange(next, _) = e {
                open.set(*next);
            }
        })
        .child(view().p_6().rounded_t(px(16.0)).bg(move || theme().card).child(text("Filters")))
}

fn details() -> impl IntoElement {
    popover()
        .offset(px(6.0))
        .margin(px(8.0))
        .trigger(view().px_3().py_2().child(text("Details")))
        .on_open_change(|e: &PopoverEvent| {
            if let PopoverEvent::OpenChange(_, OpenChangeReason::PressOutside) = e {
                log::debug!("dismissed");
            }
        })
        .child(view().w(px(240.0)).p_3().rounded_lg().bg(move || theme().popover).shadow_lg().child(text("Shipped")))
}

fn file_menu() -> impl IntoElement {
    let item = |label: &'static str| {
        menu_item()
            .on_select(move || log::info!("{label}"))
            .px_3()
            .py_2()
            .rounded_md()
            .hover(|s| s.bg(move || theme().accent))
            .child(text(label))
    };
    menu()
        .offset(px(4.0))
        .popup_style(|s| s.p_1().rounded_lg().bg(move || theme().popover).shadow_md())
        .trigger(view().px_3().py_2().child(text("File")))
        .child(item("New"))
        .child(menu_separator().h(px(1.0)).my_1().bg(move || theme().border))
        .child(item("Open"))
}
```

- A `dialog()` has no look or size of its own. Give it `.flex_1()` and a background, and use the safe area inside. Its
  `on_cancel` fires on Escape, Android back, a backdrop press and a swipe down; if you do not set `open` false, it stays.
- A dialog is a native layer over everything else, the stack's header included. Nothing outside it can draw above it.
- `alert_dialog()` uses native buttons, by id. The result's `action` is the id, or `None` when dismissed. Do not write a
  custom dialog for a yes-or-no.
- A `sheet()`'s children are lazy: a `#[component]` placed in it is made on each opening and disposed after, so state
  that must survive closing belongs to the parent. Without `.bg` on the child, the sheet is see-through.
- A `popover()` or `menu()` opens from its `.trigger` by itself; do not add an `on_press` to open it. Use `.open(..)` only
  when something else must open it, and then follow `on_open_change`.
- Inside a menu, `menu_item().on_select` closes the menu after running. `.close_on_select(false)` keeps it for toggles,
  with `.checked(..)` and `.indicator(..)`.
- Toasts have no one-call API in `nsh_base`. `ToastManager` is headless storage, and `toast_stack` and `toast` draw them.
  Build one `toast("Copied")`-style helper around them in your `ui/`, as `website/elements/toast.md` shows. Advance the
  manager on an interval and pass `state.is_expanded()` so a hover pauses the timeouts.

## Navigation: stacks and pages

`nav_stack()`'s children are its `nav_page()`s, bottom to top. **Put a page in to push it, and leave it out to pop.** The
stack is state you own: a signal of routes, rendered with `each`.

```rust
use nsh_base::{nav_page, nav_stack, theme};
use nsh_core::prelude::*;

#[derive(Debug, Clone, PartialEq)]
enum Route {
    Inbox,
    Message(u32),
}

/// The pages' header on the desktops and the web; iOS and Android draw their own from `title`.
fn header(routes: Signal<Vec<Route>>, title: impl IntoReactive<SharedString>) -> impl IntoElement {
    view()
        .h(px(48.0))
        .flex_row()
        .items_center()
        .gap_3()
        .px_4()
        .border_b_1()
        .border_color(move || theme().border)
        .child(when(
            move || routes.with(|r| r.len() > 1),
            move || {
                text("Back").role(AccessibilityRole::Button).on_press(move || {
                    routes.update(|r| {
                        r.pop();
                    })
                })
            },
        ))
        .child(text(title).font_weight(FontWeight::SEMIBOLD))
}

fn inbox(routes: Signal<Vec<Route>>) -> Screen {
    nav_page().title("Inbox").header(header(routes, "Inbox")).child(
        scroll().flex_1().children((1..=5).map(move |id| {
            view()
                .p_4()
                .on_press(move || routes.update(|r| r.push(Route::Message(id))))
                .child(text(format!("Message {id}")))
        })),
    )
}

fn message(routes: Signal<Vec<Route>>, id: u32) -> Screen {
    let title = format!("Message {id}");
    nav_page()
        .title(title.clone())
        .header(header(routes, title))
        .child(view().flex_1().p_4().child(text("The body.")))
}

#[component]
pub fn App() -> impl IntoElement {
    let routes = signal(vec![Route::Inbox]);
    nav_stack().flex_1().child(each(
        routes,
        |route: &Route| format!("{route:?}"), // the key: stable per route
        move |route, index| {
            let page = match route.get_untracked() {
                Route::Inbox => inbox(routes),
                Route::Message(id) => message(routes, id),
            };
            // The user went back natively: drop this route and those above it.
            page.on_dismiss(move || routes.update(|r| r.truncate(index.get_untracked())))
        },
    ))
}
```

- To push from anywhere, keep routes that make their own page in a `global`, as `examples/gallery-rs/native/src/nav.rs`
  and `shell.rs` (`pushed`) do.
- **`.on_dismiss` is required.** A native back or swipe pops the page natively. Without it, your signal still holds the
  route, and the stack and your state disagree.
- Two routes with one key are one page. A key must identify the page, and the gallery's `nav::push_route` refuses a
  duplicate, which also stops a double tap from pushing twice (`examples/gallery-rs/native/src/nav.rs`).
- `.header(..)` is what desktops and the web show; `.title` and `.header_right(..)`, `.header_left(..)`,
  `.header_title(..)` configure the system header on iOS and Android. Set both when you want the same action everywhere.
  `examples/gallery-rs/native/src/ui/parts.rs` (`with_header`) wraps this.
- A page's content reads its insets with `cx.insets()` from `Scope`, not `safe_area()`: the page has a header above it.
- To ask before leaving: `.pop_on_back(false)` with `.on_back_press(..)`. Set it before the user acts, since it is decided
  natively when the system asks. Android's back button outside a stack: `on_back_press(|| { ..; true })`.
- `.header_large_title(true)` is an iOS look; gate it with `os() == Os::Ios` (`demos/navigation.rs`, `large_title`).
- `presentation`-style modal stacks are dialogs: see `demos/navigation.rs` in the gallery for every kind.
- Tabs and other layouts are ordinary composition; a stack inside each tab is fine. Reading `when(desktop, ..)` over the
  whole shell remakes it, so keep what is open in signals outside (`shell.rs`).

## Tabs

`tabs()` is the row, with arrow keys and a roving focus; `tab()` is one button in it. **Tabs do not hold the selection or
the panels.** You own which is selected, and you show the panel.

```rust
use nsh_base::{tab, tabs, theme};
use nsh_core::prelude::*;

fn sections() -> impl IntoElement {
    let section = signal("overview");
    let item = move |value: &'static str, label: &'static str| {
        let selected = move || section.get() == value;
        tab()
            .selected(selected)
            .on_press(move |_: &()| section.set(value))
            .px_3()
            .py_2()
            .child(text(label).text_sm().text_color(move || {
                if selected() { theme().foreground } else { theme().muted_foreground }
            }))
    };
    view()
        .gap_4()
        .child(
            tabs()
                .flex_row()
                .self_start()
                .gap_1()
                .p_1()
                .rounded(move || theme().radius)
                .bg(move || theme().muted)
                .indicator_style(|s| s.top_1().bottom_1().rounded_md().bg(move || theme().background))
                .child(item("overview", "Overview"))
                .child(item("activity", "Activity")),
        )
        .child(when(move || section.get() == "overview", || text("This week")).otherwise(|| text("Deploys")))
}
```

- The indicator is drawn behind the tabs, and it follows the selected tab natively. It has no size across the row until
  `indicator_style` gives it `top`, `bottom` and a background.
- Panels in `when` are disposed when switched away, so their scroll offset and drafts are lost. To keep them, keep each
  panel mounted and use `.style_when(not_selected, |s| s.hidden())`.
- A bottom tab bar is your own UI too: NSH has no native tab bar element.

## Lists and virtualized data

Use `virtual_list(count, |at| row)` for anything that can grow. The list is native: cells are recycled, and only the rows
near the viewport exist.

**A cell's closure runs once per cell, not once per row.** A cell shows other rows as it is reused. `at` is a `Position`,
and `at.index()` read in a binding is what makes the cell follow.

```rust
use std::collections::HashSet;

use nsh_base::theme;
use nsh_core::prelude::*;

#[derive(Clone, PartialEq)]
struct Post {
    id: u32,
    title: SharedString,
}

#[component]
fn Feed() -> impl IntoElement {
    let posts = signal((0..1000).map(|id| Post { id, title: format!("Post {id}").into() }).collect::<Vec<_>>());
    // Per-item state lives in data, by id. Not in a signal in the row.
    let liked = signal(HashSet::<u32>::new());
    let list = element_ref();
    virtual_list(move || posts.with(Vec::len), move |at| {
        // The current row's post. A memo, so bindings run only when it changes.
        let post = computed(move || posts.with(|p| p.get(at.index()).cloned()));
        let id = move || post.with(|p| p.as_ref().map_or(0, |p| p.id));
        view()
            .flex_row()
            .items_center()
            .p_4()
            .child(text(move || post.with(|p| p.as_ref().map(|p| p.title.clone()).unwrap_or_default())).flex_1())
            .child(
                text(move || if liked.with(|s| s.contains(&id())) { "♥" } else { "♡" }).on_press(move || {
                    liked.update(|s| {
                        if !s.remove(&id()) {
                            s.insert(id());
                        }
                    })
                }),
            )
    })
    // Identities: required when rows come and go other than at the end.
    .keys(move || posts.with(|p| p.iter().map(|p| p.id).collect::<Vec<_>>()))
    .estimated_item_size(px(52.0))
    .separator(|| view().h(px(1.0)).bg(move || theme().border))
    .header(text("Latest").p_4())
    .empty(text("Nothing yet").p_4())
    .on_load_more(move || log::info!("next page"))
    .flex_1()
    .element_ref(&list)
}
```

Wrong, and looks right on the first screen:

```rust
use nsh_core::prelude::*;

fn wrong(titles: Signal<Vec<SharedString>>) -> impl IntoElement {
    virtual_list(move || titles.with(Vec::len), move |at| {
        // Read once: this cell shows the first row it was given, forever.
        let title = titles.with(|t| t[at.index()].clone());
        // A signal in a cell travels with the cell to the next row.
        let expanded = signal(false);
        view().on_press(move || expanded.set(true)).child(text(title))
    })
}
```

- `.estimated_item_size(..)` should be close to the typical row (default 50): it drives the scroll indicator and jumps.
- A list needs a bounded height. `.flex_1()` in a parent that has height, or it collapses.
- Rows differ in height freely; they are measured. Use one element shape per cell, and a binding to vary it. For rows of
  different kinds, `when` inside the cell works, at a cost on each reuse.
- Index with care during a removal. A binding can run while the count changes, so use `p.get(i)` with a fallback, as above,
  when rows can be removed.
- Layout methods come from `ListLayout`: `.columns(n)`, `.horizontal()`, `.inverted()`, `.alignment(ListAlignment::Bottom)` (chat), `.content_padding(..)`,
  `.row_gap(..)`, `.column_gap(..)`, `.viewport(ListViewport::Parent)` (a list inside a page's `scroll`, without nesting
  scrollers).
- Also on the list: `.sticky_header_indices(..)`, `.initial_scroll_index(..)`, `.on_load_more_at_start(..)`,
  `.viewability(..)` with `.on_viewable_items_change(..)`. From a ref: `list.scroll_to_index(i, percentage(0.5), px(0.0),
  true)`, `list.scroll_to_end(true)`.
- `.columns` changed by a signal: wrap the list in `dynamic` with a keyed list, so nothing of the old layout stays.
- `each` in a `scroll` makes every row and keeps it. Fine for tens of rows, not for thousands.

`examples/gallery-rs/native/src/demos/lists.rs` has grids, sticky contacts, an inverted chat and pull to refresh.

## Scrolling and the safe area

`scroll()`, with `Scrollable` methods: `.horizontal()`, `.paging(..)`, `.snap_interval(..)`, `.bounces(..)`, `.scrollbar(..)`,
`.keyboard_dismiss_mode(..)`, `.keyboard_taps(..)`, `.refreshing(..)`, `.on_refresh(..)`, `.on_scroll(..)`,
`.scroll_value(&animated)`.

```rust
use nsh_base::theme;
use nsh_core::prelude::*;

fn page() -> impl IntoElement {
    let refreshing = signal(false);
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(
            scroll()
                .flex_1()
                .refreshing(refreshing)
                .on_refresh(move || refreshing.set(true))
                .child(view().p_4().pb_safe_area_plus(px(16.0)).gap_3().child(text("Content"))),
        )
        .child(view().px_4().pb_safe_area().child(text("A bar under the scroll")))
}
```

- `.flex_1()` on the scroll is nearly always needed. Without a bounded height, it grows with its content and never scrolls.
- Style padding and gaps on a child view, as above, not on the scroll: the child is the content.
- Do not nest a list in a same-axis `scroll`. Use `.viewport(ListViewport::Parent)`.
- Safe area: `.p_safe_area()`, `.px_safe_area()`, `.pt_safe_area()`, `.pb_safe_area()`, `.pt_safe_area_plus(px(20.0))`,
  `.pb_safe_area_plus(..)`, as native styles with no binding. `safe_area()` reads the raw insets, and subscribes. Inside a
  page or modal use `cx.insets()`.
- Let the background extend under the bars: the root paints, and the padded child holds the content.
- A `refreshing` signal must be set false by you when the work ends, or the spinner stays.
- `.on_scroll` is an event per frame into Rust. To drive a visual from the offset, use `.scroll_value(&animated)` with
  `bind_*`, which stays on the UI thread (`demos/scrolling.rs`).

## Tables

`table()` for a small static table with a table's semantics; `data_table()` for any number of rows and columns.

```rust
use nsh_base::{
    DataTableClasses, DataTableColumn, DataTablePress, DataTableRows, DataTableSort, data_table, table, table_body, table_cell, table_head, table_header,
    table_row, theme,
};
use nsh_core::prelude::*;

fn invoices() -> impl IntoElement {
    let cell = |label: &'static str| table_cell().w(px(120.0)).px_3().py_2().child(text(label));
    table()
        .accessibility_label("Recent invoices")
        .child(table_header().child(table_row().child(table_head().w(px(120.0)).px_3().child(text("Invoice")))))
        .child(table_body().child(table_row().child(cell("INV001"))))
}

fn column(key: &'static str, title: &'static str, width: f32) -> DataTableColumn {
    let mut column = DataTableColumn::default();
    column.key = key.into();
    column.title = Some(title.into());
    column.width = Some(px(width));
    column.sortable = true;
    column
}

fn quotes() -> impl IntoElement {
    let rows = DataTableRows::new(2).texts("symbol", ["AAPL", "MSFT"]).numbers("change", [1.2, -0.4]);
    data_table()
        .columns(vec![column("symbol", "Symbol", 120.0), column("change", "Change", 90.0)])
        .data(rows)
        .row_height(px(32.0))
        .stripe(true)
        .classes({
            let mut classes = DataTableClasses::default();
            classes.header = Some("border-b border-border".into());
            classes
        })
        .on_row_press(|_: &DataTablePress| log::debug!("row"))
        .on_sort_change(|sort: &Option<DataTableSort>| log::debug!("{}", sort.is_some()))
        .h(px(320.0))
        .border_1()
        .border_color(move || theme().border)
}
```

- `DataTableColumn` and similar are `#[non_exhaustive]`: build with `default()` and assign fields, not a struct literal.
- `data_table` fills the box it is given. Give `.flex_1()` or a height, or it has nothing to lay out in.
- `DataTableRows` is by column, each of one type. `key` joins a column to its field; a wrong key is an empty column.
- Sorting is yours. `on_sort_change` reports the request; sort your data and set `.sort(..)` and `.data(..)`.
- Lines, colors and selection feedback come from `.classes(..)` and `.styles(..)`; with none, the table has no dividers.
- A table's own width: `table_cell` and `table_head` take the widths. A static table does not virtualize or scroll by
  itself; put it in a `scroll().horizontal()` when it can overflow.
- `.render_cell(|cell: &DataTableCell| ..)` runs per visible cell. Keep it light.

## Editor

`editor()` (feature `editor`, on by default) is a code editor with highlighting, folding, search and diagnostics.

```rust
use nsh_base::{Editor, EditorApi, editor};
use nsh_core::prelude::*;

fn code() -> impl IntoElement {
    let source = signal(SharedString::from("fn main() {}\n"));
    let handle = component_ref::<Editor>();
    view()
        .flex_1()
        .child(text("Insert date").on_press(move || {
            // The ref's methods: focus, value, set_value, insert, selections, run, ...
            if let Some(api) = handle.api::<EditorApi>() {
                api.insert("2026-11-05".to_owned());
            }
        }))
        .child(
            editor()
                .value(move || Some(source.get()))
                .language("rust")
                .on_change(move |value: &SharedString| source.set(value.clone()))
                .read_only(false)
                .soft_wrap(true)
                .font_size(px(13.0))
                .component_ref(&handle)
                .flex_1(),
        )
}
```

- `.value` takes an `Option`, so its closure returns `Some(..)`. Each keystroke sends the whole text through `on_change`.
  For a large file, use `.default_value(..)` and read the text only when saving.
- Give it `.flex_1()` or a height. It scrolls itself, so do not put it in a `scroll`.
- `font_size`, `line_height` and `font_family` are props, not styles, because the editor measures text itself.
- Part colors come from `.classes(..)` and `.styles(..)` (`EditorClasses`, `EditorStyles`).
- `language` takes a name, alias, extension or file name (`"rust"`, `"rs"`). See `website/elements/editor.md`. For a
  read-only diff, use `diff_view()`.
- `rich_editor` is a separate module (feature `rich-editor`): `website/elements/rich-editor.md`.

## Text view

`text_view()` renders Markdown, HTML or a document natively. Use `text()` for labels; use this for content.

```rust
use nsh_base::{MarkdownOptions, TextViewCodeAction, TextViewLinkPressEvent, text_view, theme};
use nsh_core::prelude::*;

fn reply(markdown: Signal<SharedString>, streaming: Signal<bool>) -> impl IntoElement {
    text_view()
        .markdown(move || Some(markdown.get()))
        .options(move || MarkdownOptions { streaming: streaming.get(), ..MarkdownOptions::default() })
        .selectable(true)
        .code_block_actions(vec![TextViewCodeAction::new("copy").with_label("Copy code")])
        .on_link_press(|event: &TextViewLinkPressEvent| log::info!("{}", event.url))
        .gap_3()
        .text_size(px(15.0))
        .line_height(px(22.0))
        .text_color(move || theme().foreground)
}
```

- It does not scroll. Put it in a `scroll` or a list row. It has no spacing of its own: `.gap_3()` separates blocks.
- `.text_size` and `.text_color` on the element are the base; headings and code come from `.classes(..)` and `.styles(..)`
  by part (`TextViewClasses`, `TextViewStyles`, or `provide_context` of `TextViewParts`, as
  `examples/gallery-rs/native/src/demos/chat/markdown.rs` does).
- Set `MarkdownOptions { streaming: true, .. }` while text is arriving (`.streaming_caret(..)` places a caret), and false
  once it ends, as `demos/chat/markdown.rs` does.
- `.selectable(true)` is off by default. Links are only reported (`on_link_press`) unless `.links(TextViewLinks::Open)`.
- Formulas need feature `math`; without it they show as TeX or through your `render_math`.
- `.render_code_block(..)`, `.render_custom(..)` draw parts yourself; they are kept per key while the value stays equal.

## Images

`image(src)`, where `src` is an asset, a URL, or a signal of either. `svg(src)` for vectors.

```rust
use nsh_core::prelude::*;

const LOGO: ImageAsset = asset!("logo.png");

fn avatar(url: Signal<String>) -> impl IntoElement {
    let failed = signal(false);
    view()
        .flex_row()
        .gap_3()
        .child(image(LOGO).size(px(32.0)))
        .child(
            image(move || url.get())
                .placeholder(LOGO)
                .object_fit(ResizeMode::Cover)
                .size(px(64.0))
                .rounded_full()
                .label("Profile picture")
                .on_error(move |_: &str| failed.set(true)),
        )
}
```

- `asset!("logo.png")` is relative to the crate's `assets/` directory, checked at compile time. Register the assets with
  `registry.assets(assets!())` in `#[native_module]` (`examples/gallery-rs/native/src/lib.rs`, `assets.rs`).
- Give an image a size: `.size(..)`, or `.w(..)` with an aspect ratio. An unsized remote image has no size until loaded,
  so the layout jumps.
- `.object_fit(ResizeMode::Cover)` and `.rounded_*` work together; the corner clip is native.
- A screenshot test cannot show images in headless runs: they are not loaded there. See
  [rust-testing.md](rust-testing.md).
- Remote URLs fall under `capabilities.network`. `prefetch_image` and `image_size` are for pre-loading and measuring.
