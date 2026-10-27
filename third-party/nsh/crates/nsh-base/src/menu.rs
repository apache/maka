//! Menus: `Menu` (opened by a trigger), `ContextMenu` (by a secondary
//! click or a held finger), their `MenuItem`s, `MenuSeparator`s and
//! `Submenu`s.
//!
//! One structure for every device, presented as it suits (`popup.rs`): on
//! the desktops a popup at the trigger (or the pointer) whose submenus
//! cascade beside the item that opens them, on hover or press; on phones
//! and tablets a sheet at the bottom of the screen, over a backdrop, whose
//! submenus replace its items (a submenu's `back` row, and Escape or the
//! back button, return to the items above). The items reach their menu
//! through context, so the app arranges them freely (groups, labels,
//! conditions).

use std::{rc::Rc, time::Duration};

use nsh_core::{ContextMenuEvent, TouchEvent, TouchPhase, element::Style, prelude::*};

use crate::popup::{OpenChangeReason, OpenState, SheetMotion, lifecycle};

/// How long a finger stays on a context menu's trigger before it opens
/// (less than the platforms' long press, so it opens while the finger is
/// still down), and how far it may move meanwhile.
const HOLD: Duration = Duration::from_millis(400);
const SLOP: f32 = 10.0;

/// What a menu's items reach through context.
#[derive(Clone)]
struct MenuContext {
    /// Closes the whole menu.
    close: Rc<dyn Fn(OpenChangeReason)>,
    /// Presented as a sheet (touch screens).
    sheet: bool,
    /// Sheet: the submenus shown, innermost last.
    path: Signal<Vec<u32>>,
    /// The submenu the items under this context are in (0: the menu).
    level: u32,
    /// Desktops: the submenu of this level that is open.
    open_sub: Signal<Option<u32>>,
    /// The next submenu's id.
    next: Stored<u32>,
    /// The popup part, for the submenus' popups.
    popup_class: Prop<Option<SharedString>>,
    popup_style: Prop<Style>,
}

impl MenuContext {
    /// Sheet: the items of this level are the ones shown.
    fn shown(&self) -> bool {
        let level = self.level;
        self.path.with(|p| p.last().copied().unwrap_or(0) == level)
    }
}

/// The parts and placement both kinds of menus take.
#[derive(Clone, Copy)]
struct Surface {
    placement: Prop<Placement>,
    align: Prop<Align>,
    offset: Prop<Points>,
    margin: Prop<Points>,
    popup_class: Prop<Option<SharedString>>,
    popup_style: Prop<Style>,
    backdrop_class: Prop<Option<SharedString>>,
    backdrop_style: Prop<Style>,
}

/// Where a menu's popup goes on the desktops.
#[derive(Clone)]
enum At {
    Trigger(ElementRef),
    Pointer(Signal<Point<Points>>),
}

/// The menu while it is open: its popup or sheet, with the context its
/// items read. `change` asks to open or close it.
fn surface(
    open: OpenState,
    change: Rc<dyn Fn(bool, OpenChangeReason)>,
    emit: Rc<dyn Fn(MenuEvent)>,
    at: At,
    parts: Surface,
    children: Prop<Children>,
) -> AnyElement {
    let sheet = !is_desktop();
    let path = signal(Vec::<u32>::new());
    let open_sub = signal(None::<u32>);
    let close = {
        let change = change.clone();
        Rc::new(move |reason: OpenChangeReason| change(false, reason))
    };
    provide_context(MenuContext {
        close,
        sheet,
        path,
        level: 0,
        open_sub,
        next: stored(1),
        popup_class: parts.popup_class,
        popup_style: parts.popup_style,
    });
    // An attempt to close it: reported, then it closes.
    let dismiss = {
        let (change, emit) = (change.clone(), emit.clone());
        Rc::new(move |reason: OpenChangeReason| {
            emit(MenuEvent::Cancel);
            change(false, reason);
        })
    };
    // Escape and back leave the innermost submenu of a sheet first.
    let cancel = {
        let dismiss = dismiss.clone();
        move || {
            if !path.with_untracked(|p| p.is_empty()) {
                path.update(|p| {
                    p.pop();
                });
            } else {
                dismiss(OpenChangeReason::Cancel);
            }
        }
    };
    // A sheet comes in and goes with its motion; a popup at once.
    let motion = SheetMotion::new(move || sheet && open.get(), || Placement::Bottom);
    {
        let (opened, closed) = (emit.clone(), emit.clone());
        lifecycle(
            move || if sheet { motion.there() } else { open.get() },
            move || opened(MenuEvent::Open),
            move || closed(MenuEvent::Close),
        );
    }
    when(
        move || {
            if sheet {
                motion.shown.get()
            } else {
                open.get()
            }
        },
        move || {
            // Each opening starts at the top.
            path.set(Vec::new());
            open_sub.set(None);
            if sheet {
                let dismiss = dismiss.clone();
                let backdrop = overlay()
                    .inset_0()
                    .bind_opacity(&motion.fade)
                    .focusable(false)
                    .app_class(parts.backdrop_class)
                    .inline_style(parts.backdrop_style)
                    .on_press(move || dismiss(OpenChangeReason::BackdropPress));
                let panel = overlay()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .role(AccessibilityRole::Menu)
                    .app_class(parts.popup_class)
                    .inline_style(parts.popup_style)
                    .bind_translate_y(&motion.y)
                    .on_layout(move |frame: &Bounds<Points>| motion.laid_out(frame.size))
                    .on_cancel(cancel.clone())
                    .child(children);
                return vec![backdrop.into_element(), panel.into_element()];
            }
            let popup = match &at {
                At::Trigger(anchor) => overlay().anchor_content(anchor),
                At::Pointer(point) => {
                    let point = *point;
                    overlay().anchor_point(move || point.get())
                }
            };
            let dismiss = dismiss.clone();
            let popup = popup
                .placement(parts.placement)
                .align(parts.align)
                .offset(parts.offset)
                .margin(parts.margin)
                .role(AccessibilityRole::Menu)
                .app_class(parts.popup_class)
                .inline_style(parts.popup_style)
                .on_press_outside(move |_: &Point<Points>| dismiss(OpenChangeReason::PressOutside))
                .on_cancel(cancel.clone())
                .child(children);
            vec![popup.into_element()]
        },
    )
    .into_element()
}

/// The props of [`Menu`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuProps {
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the menu keeps its own state.
    pub open: Prop<Option<bool>>,
    /// Open at first, while `open` is not set.
    #[prop(default)]
    pub default_open: Prop<bool>,
    /// Desktops: the side of the trigger it goes on (default `"bottom"`);
    /// the other side when only that one has room.
    #[prop(default)]
    pub placement: Prop<Placement>,
    /// Desktops: how it lines up with the trigger (default `"start"`).
    #[prop(default = Align::Start)]
    pub align: Prop<Align>,
    /// Desktops: the gap between the trigger and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// Desktops: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup the items are in (desktops), or of the
    /// sheet (touch screens); its submenus' popups take them too.
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// Touch screens: the classes of the backdrop behind the sheet
    /// (pressing it closes the menu).
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// What opens it when pressed.
    pub trigger: Prop<Option<Slot>>,
    /// The items (`MenuItem`, `MenuSeparator`, `Submenu`, anything else),
    /// made on each opening.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// The events of a menu.
#[derive(Debug, Clone, PartialEq, Event)]
pub enum MenuEvent {
    /// It opened or closed (by the trigger, a press outside or on the
    /// backdrop, Escape or back, an item chosen), with why: set `open` to
    /// follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// It is shown (a sheet once it came in).
    Open,
    /// It is gone (a sheet once it went; also when the app closed it).
    Close,
    /// The user tried to close it without choosing (Escape or back, a press
    /// outside or on the backdrop).
    Cancel,
}

/// A menu its trigger opens: a popup at the trigger on the desktops, a
/// sheet at the bottom of the screen on phones and tablets (over a
/// backdrop), whose items are `MenuItem`s, `MenuSeparator`s and `Submenu`s
/// (cascading popups on the desktops, the sheet's next items on touch
/// screens). Choosing an item, a press outside, Escape and the Android back
/// button close it. It looks like nothing: style the popup or sheet with
/// `popupClass` / `popupStyle`, the backdrop with `backdropClass` /
/// `backdropStyle`, and the items.
#[component]
pub fn Menu(props: MenuProps, cx: Scope<MenuEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let change: Rc<dyn Fn(bool, OpenChangeReason)> = Rc::new(move |next, reason| {
        if open.request(next) {
            cx.emit(MenuEvent::OpenChange(next, reason));
        }
    });
    let anchor = element_ref();
    let parts = Surface {
        placement: props.placement,
        align: props.align,
        offset: props.offset,
        margin: props.margin,
        popup_class: props.popup_class,
        popup_style: props.popup_style,
        backdrop_class: props.backdrop_class,
        backdrop_style: props.backdrop_style,
    };
    let toggle = change.clone();
    view()
        .child(props.trigger.place(move |trigger| {
            let toggle = toggle.clone();
            trigger
                .element_ref(&anchor)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(open.get()),
                    ..AccessibilityState::default()
                })
                .on_press(move || toggle(!open.get_untracked(), OpenChangeReason::TriggerPress))
        }))
        .child(surface(
            open,
            change,
            Rc::new(move |e| cx.emit(e)),
            At::Trigger(anchor),
            parts,
            props.children,
        ))
}

/// The props of [`ContextMenu`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ContextMenuProps {
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the menu keeps its own state.
    pub open: Prop<Option<bool>>,
    /// No menu: the secondary button and held fingers do nothing.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Desktops: the gap between the pointer and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// Desktops: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup (desktops) or of the sheet (touch
    /// screens).
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// Touch screens: the classes of the backdrop behind the sheet.
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// What it is about: the secondary button on it (desktops) or a finger
    /// held on it (touch screens) opens the menu.
    pub trigger: Prop<Option<Slot>>,
    /// The items, made on each opening.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// A menu about its trigger: the secondary button (a right click, a
/// two-finger click) opens it where the pointer is on the desktops; a
/// finger held on the trigger opens it as a sheet at the bottom of the
/// screen on phones and tablets. Its items are those of `Menu`, and so is
/// how it closes and how it is styled.
#[component]
pub fn ContextMenu(props: ContextMenuProps, cx: Scope<MenuEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, Prop::from(false));
    let change: Rc<dyn Fn(bool, OpenChangeReason)> = Rc::new(move |next, reason| {
        if next && props.disabled.get_untracked() {
            return;
        }
        if open.request(next) {
            cx.emit(MenuEvent::OpenChange(next, reason));
        }
    });
    let point = signal(Point::<Points>::default());
    let parts = Surface {
        placement: Prop::from(Placement::Bottom),
        align: Prop::from(Align::Start),
        offset: props.offset,
        margin: props.margin,
        popup_class: props.popup_class,
        popup_style: props.popup_style,
        backdrop_class: props.backdrop_class,
        backdrop_style: props.backdrop_style,
    };
    let hold = stored(None::<(Spawned<()>, Point<Points>)>);
    let opener = change.clone();
    view()
        .child(props.trigger.place(move |trigger| {
            let on_menu = opener.clone();
            let on_hold = opener.clone();
            trigger
                .on_context_menu(move |e: &ContextMenuEvent| {
                    point.set(e.page_position);
                    on_menu(true, OpenChangeReason::ContextMenu);
                })
                // Observed, never claimed: the trigger's presses and the
                // scroll views around it go on.
                .on_touch(move |e: &TouchEvent| {
                    if is_desktop() {
                        return;
                    }
                    let at = e.points.first().map(|p| p.page);
                    match e.phase {
                        TouchPhase::Start if e.points.len() == 1 => {
                            let on_hold = on_hold.clone();
                            let page = at.unwrap_or_default();
                            let task = set_timeout(HOLD, move || {
                                hold.replace(None);
                                point.set(page);
                                on_hold(true, OpenChangeReason::LongPress);
                            });
                            if let Some((old, _)) = hold.replace(Some((task, page))) {
                                old.cancel();
                            }
                        }
                        TouchPhase::Move => {
                            let moved = hold.with(|h| {
                                h.as_ref().zip(at).is_some_and(|((_, from), to)| {
                                    let (dx, dy) = (to.x.0 - from.x.0, to.y.0 - from.y.0);
                                    dx * dx + dy * dy > SLOP * SLOP
                                })
                            });
                            if moved && let Some((old, _)) = hold.replace(None) {
                                old.cancel();
                            }
                        }
                        _ => {
                            if let Some((old, _)) = hold.replace(None) {
                                old.cancel();
                            }
                        }
                    }
                })
        }))
        .child(surface(
            open,
            change,
            Rc::new(move |e| cx.emit(e)),
            At::Pointer(point),
            parts,
            props.children,
        ))
}

/// The props of [`MenuItem`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuItemProps {
    /// Not chosen: no presses, `disabled:` styles apply, screen readers say
    /// it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Choosing it closes the menu (default true).
    #[prop(default = true)]
    pub close_on_select: Prop<bool>,
    /// What screen readers say, when its content is not enough.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content.
    pub children: Prop<Children>,
}

/// The events of a [`MenuItem`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum MenuItemEvent {
    /// It was chosen.
    Select,
}

/// An item of a `Menu`, `ContextMenu` or `Submenu`: pressing it chooses it
/// (`onSelect`) and closes the menu. Its look is the app's: `class`,
/// `style` and the `active:`, `hover:`, `disabled:` states.
#[component]
pub fn MenuItem(props: MenuItemProps, cx: Scope<MenuItemEvent>) -> impl IntoElement {
    let menu = use_context::<MenuContext>();
    let hover = menu.clone();
    let chosen = menu.clone();
    let sheet = menu.filter(|m| m.sheet);
    let content = match sheet.clone() {
        // Only the items of the level shown are there (for screen readers
        // and tests too).
        Some(m) => when(move || m.shown(), move || props.children).into_element(),
        None => props.children.into_element(),
    };
    view()
        .role(AccessibilityRole::Menuitem)
        .disabled(props.disabled)
        .optional_label(props.accessibility_label)
        .when_some(sheet, |v, m| {
            v.style_when(move || !m.shown(), |s| s.hidden())
        })
        // Over another item, a submenu of its level closes.
        .on_hover_in(move || {
            if let Some(m) = &hover {
                m.open_sub.set(None);
            }
        })
        .on_press(move || {
            cx.emit(MenuItemEvent::Select);
            if props.close_on_select.get_untracked()
                && let Some(m) = &chosen
            {
                (m.close)(OpenChangeReason::Select);
            }
        })
        .child(content)
}

/// The props of [`MenuSeparator`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuSeparatorProps {}

/// A line between groups of a menu's items: a view the app styles (`class`,
/// `style`), shown with its level's items.
#[component]
pub fn MenuSeparator(_props: MenuSeparatorProps, cx: Scope<NoEvent>) -> impl IntoElement {
    let _ = cx;
    let menu = use_context::<MenuContext>();
    view()
        .focusable(false)
        .when_some(menu.filter(|m| m.sheet), |v, m| {
            v.style_when(move || !m.shown(), |s| s.hidden())
        })
}

/// The props of [`Submenu`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SubmenuProps {
    /// It does not open.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The item that opens it, among its menu's items.
    pub trigger: Prop<Option<Slot>>,
    /// Touch screens: the row above its items that returns to the items
    /// it is among (Escape and back do too).
    pub back: Prop<Option<Slot>>,
    /// Its items.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// A menu inside a menu: on the desktops its items are a popup beside its
/// trigger, opened as the pointer comes over the trigger or presses it; on
/// touch screens pressing the trigger shows its items in the sheet instead
/// of the ones around it, with its `back` row first. Its popups take the
/// menu's `popupClass` / `popupStyle`.
#[component]
pub fn Submenu(props: SubmenuProps, cx: Scope<NoEvent>) -> impl IntoElement {
    let _ = cx;
    let Some(menu) = use_context::<MenuContext>() else {
        // Outside a menu: nothing to open.
        return view().child(props.trigger.place(|t| t)).into_element();
    };
    let id = menu.next.with(|n| {
        *n += 1;
        *n
    });
    let inner = MenuContext {
        level: id,
        open_sub: signal(None),
        ..menu.clone()
    };
    provide_context(inner.clone());
    let (path, open_sub) = (menu.path, menu.open_sub);
    if menu.sheet {
        let shown = menu.clone();
        let into = move || {
            if !props.disabled.get_untracked() {
                path.update(|p| p.push(id));
            }
        };
        let back = move || {
            path.update(|p| {
                p.pop();
            });
        };
        return view()
            .child(when(
                move || shown.shown(),
                move || {
                    props
                        .trigger
                        .place(move |t| t.role(AccessibilityRole::Menuitem).on_press(into))
                },
            ))
            .child(when(
                // While it is on the path: a submenu inside it shows its
                // own items in place of these, which hide themselves.
                move || path.with(|p| p.contains(&id)),
                move || {
                    vec![
                        when(
                            move || path.with(|p| p.last() == Some(&id)),
                            move || props.back.place(move |b| b.on_press(back)),
                        )
                        .into_element(),
                        props.children.into_element(),
                    ]
                },
            ))
            .into_element();
    }
    let anchor = element_ref();
    let open = move || {
        if !props.disabled.get_untracked() {
            open_sub.set(Some(id));
        }
    };
    view()
        .child(props.trigger.place(move |t| {
            t.element_ref(&anchor)
                .role(AccessibilityRole::Menuitem)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(open_sub.get() == Some(id)),
                    ..AccessibilityState::default()
                })
                .on_hover_in(open)
                .on_press(open)
        }))
        .child(when(
            move || open_sub.get() == Some(id),
            move || {
                overlay()
                    .anchor(&anchor)
                    .placement(Placement::Right)
                    .align(Align::Start)
                    .role(AccessibilityRole::Menu)
                    .app_class(inner.popup_class)
                    .inline_style(inner.popup_style)
                    .on_cancel(move || open_sub.set(None))
                    .child(props.children)
            },
        ))
        .into_element()
}
