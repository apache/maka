//! A `DockArea`'s tab groups (`gpui-base`'s `TabGroup`): the tab bar, the
//! tabs the area wraps around the app's `renderTab`, the content frame
//! where every panel of the group is placed and the displayed one shown;
//! the drop indicator; and the drag of a tab, which runs in the core.
//!
//! For assistive technologies the bar is a tab list and the content frame
//! the tab panel, which every tab of the bar names as the element it
//! controls: the frame shows the selected tab's panel, the others hidden.
//!
//! # A drag
//!
//! A tab claims the touches of a gesture with the core's responder
//! (`claim_touches(on_move)`) once it has moved [`DRAG_SLOP`] from where
//! it went down, when the press armed it: a pointer's press (a mouse, a
//! trackpad, a pen: what hovered the tab before pressing it, as a finger
//! never does) and any press on the desktops arm it at once, a finger's
//! only after a long press, so a swipe over the tabs is no drag. The core's
//! touches do not say which input made them, so hovering tells. It keeps them
//! (`keep_touches`) against the scroll views around it. The grant starts
//! the drag ([`AreaCx::start_drag`]): every registered group's tab bar,
//! tabs and content frame are measured in the root view's coordinates (the
//! touches' `page`), in one task whose answers come with the next commit.
//! Each move resolves the target from those bounds
//! ([`AreaCx::drag_to`]): over a tab bar, the slot between the tabs the
//! pointer is past (counted without the dragged tab, which is where
//! [`super::PaneTree::move_panel`] puts it after taking it out); over a
//! content frame, its middle merges and its edges split
//! (`split_placement_at`), except back onto its own group when that would
//! change nothing. The drop indicator part, an overlay above the area,
//! covers what the panel would take in the group the target names
//! ([`super::DropPlaceholderBounds::for_placement`]); over a tab bar an
//! insertion line between the tabs shows the slot instead ([`drop_line`]).
//! The release applies
//! one move ([`AreaCx::drop_at`]); a gesture the system takes away drops
//! nothing.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::{
    AccessibilityState, RevealOptions, ScrollAlignment,
    element::{LayoutAnimation, LayoutCurve, LayoutTransition, Renderer},
    geometry::{Bounds, Point, Points, Size},
    prelude::*,
};

use super::{
    area::Group,
    dock_area::{AreaCx, DockDropIndicator, DockPanel, DockTab, DropAt, GroupRefs, TabDrag, Zone},
    drag::{DropPlaceholderBounds, split_placement_at},
    layout::{InsertTarget, NodeId, PanelId},
};

/// How far the pointer moves on a tab before it drags it.
pub(crate) const DRAG_SLOP: Points = px(4.0);

/// The panel group `group` shows: its displayed one when visible, else
/// its first visible one (tracked).
pub(crate) fn shown_of(a: AreaCx, group: &Group) -> Option<PanelId> {
    match group.active() {
        Some(panel) if a.visible(panel) => Some(panel.clone()),
        _ => group.panels.iter().find(|p| a.visible(p)).cloned(),
    }
}

/// What `renderTab` gets for panel `panel` (tracked).
pub(crate) fn tab_value(a: AreaCx, panel: &PanelId) -> Option<DockTab> {
    let group = a.area.with(|area| {
        let node = area.group_of_panel(panel.as_str())?;
        area.group(node)
    })?;
    let index = group
        .panels
        .iter()
        .filter(|p| a.visible(p))
        .position(|p| p == panel)
        .unwrap_or(0);
    Some(DockTab {
        panel: panel.clone(),
        group: group.node.as_u64(),
        index,
        active: shown_of(a, &group).as_ref() == Some(panel),
        closable: a.closable(panel),
        zoomed: a.zoomed.get() == Some(group.node),
    })
}

/// The toolbar at the end of the tab bar of `group`: what `renderToolbar`
/// draws for its displayed tab, nothing without the prop or a shown panel.
pub(crate) fn toolbar(a: AreaCx, group: Memo<Option<Group>>) -> AnyElement {
    bar_part(a, group, |a| a.props.render_toolbar.get())
}

/// The content at the start of the tab bar of `group`, before its tabs:
/// what `renderTabBarPrefix` draws for its displayed tab, nothing without
/// the prop or a shown panel.
pub(crate) fn prefix(a: AreaCx, group: Memo<Option<Group>>) -> AnyElement {
    bar_part(a, group, |a| a.props.render_tab_bar_prefix.get())
}

fn bar_part(
    a: AreaCx,
    group: Memo<Option<Group>>,
    renderer: impl Fn(AreaCx) -> Option<Renderer<DockTab>> + 'static,
) -> AnyElement {
    let value = computed(move || {
        let shown = group.with(|g| g.as_ref().and_then(|g| shown_of(a, g)))?;
        tab_value(a, &shown)
    });
    dynamic(move || {
        let render = renderer(a)?;
        let value = value.get()?;
        Some(render.render(value.panel.to_string(), value))
    })
}

/// The tabs of a tab bar: `tabs` in a row in a horizontal scroll view, so
/// tabs that do not fit scroll instead of running past the bar's end. The
/// scroll view is as wide as its tabs and shrinks to the room the bar
/// leaves it.
pub(crate) fn tab_strip(tabs: impl IntoElement) -> AnyElement {
    scroll()
        .horizontal()
        .scrollbar(false)
        .flex_shrink(1.0)
        .min_w(px(0.0))
        .child(view().flex_row().child(tabs))
        .into_element()
}

/// Tab group `node`: its frame, tab bar and content frame.
pub(crate) fn tab_group(a: AreaCx, node: NodeId) -> AnyElement {
    let group = computed(move || a.area.with(|area| area.group(node)));
    let panels =
        computed(move || group.with(|g| g.as_ref().map(|g| g.panels.clone()).unwrap_or_default()));
    let tabs = computed(move || {
        panels
            .get()
            .into_iter()
            .filter(|p| a.visible(p))
            .collect::<Vec<_>>()
    });
    let shown = computed(move || group.with(|g| g.as_ref().and_then(|g| shown_of(a, g))));
    let refs = GroupRefs {
        group: Some(node),
        bar: element_ref(),
        content: Some(element_ref()),
        tabs: Rc::default(),
    };
    a.register(refs.clone());
    let tab_refs = refs.tabs.clone();
    let content = refs.content.expect("a group's content");
    view()
        .flex_1()
        .flex_col()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .app_class(a.props.group_class)
        .inline_style(a.props.group_style)
        .child(
            view()
                .role(AccessibilityRole::Tablist)
                .element_ref(&refs.bar)
                .app_class(a.props.tab_bar_class)
                .inline_style(a.props.tab_bar_style)
                .child(prefix(a, group))
                .child(tab_strip(each(
                    move || tabs.get(),
                    |panel: &PanelId| panel.clone(),
                    move |panel, _| {
                        let id = panel.get_untracked();
                        let value = {
                            let id = id.clone();
                            computed(move || tab_value(a, &id))
                        };
                        tab(a, id, Some(node), value, content, tab_refs.clone())
                    },
                )))
                .child(toolbar(a, group)),
        )
        .child(
            view()
                .role(AccessibilityRole::TabPanel)
                .relative()
                .flex_1()
                .min_h(px(0.0))
                .overflow_hidden()
                .element_ref(&content)
                .app_class(a.props.content_class)
                .inline_style(a.props.content_style)
                .child(each(
                    move || panels.get(),
                    |panel: &PanelId| panel.clone(),
                    move |panel, _| {
                        let id = panel.get_untracked();
                        let me = id.clone();
                        panel_slot(a, id, move || shown.with(|s| s.as_ref() == Some(&me)))
                    },
                )),
        )
        .into_element()
}

/// Where panel `id` is placed: over its content frame, hidden while
/// `shown` does not hold (so its content keeps its state), its content the
/// app's `renderPanel`. The placeholder is a grid of one cell, so what JS
/// renders into it fills it.
pub(crate) fn panel_slot(a: AreaCx, id: PanelId, shown: impl Fn() -> bool + 'static) -> View {
    view()
        .absolute()
        .inset_0()
        .style_when(move || !shown(), |s| s.hidden())
        .child(dynamic(move || {
            a.props.render_panel.get().map(|r| {
                r.render(id.key().clone(), DockPanel { id: id.clone() })
                    .flex_1()
                    .grid()
                    .grid_cols(1)
                    .grid_rows(1)
            })
        }))
}

/// How long the drop indicator takes to move to another place or to fade
/// in or out, in milliseconds.
const INDICATOR_MOTION_MS: f32 = 160.0;

/// Animates the next commit's layout changes for the drop indicator: its
/// frame eases to the new place, and it fades in as it appears and out as
/// it goes. During a drag nothing else changes its frame there (the drag
/// preview moves by a transform), so only the indicator moves. Nothing
/// when the user asked for less motion.
fn animate_indicator(fade: bool) {
    if untracked(reduce_motion) {
        return;
    }
    let transition = LayoutTransition::new(LayoutCurve::EaseOut, INDICATOR_MOTION_MS);
    animate_layout(LayoutAnimation {
        create: fade.then_some(transition),
        update: Some(transition),
        delete: fade.then_some(transition),
    });
}

/// The alpha of the accent band under a terminal's drop indicator: as
/// faint as the terminal's bands go.
const DROP_WASH: f32 = 0.12;

/// The drop indicator: while a drag would land on a group's content
/// frame, over the part of it the panel would take (all of it to merge, a
/// half to split). It is an overlay in the root view, under the drag preview
/// (mounted again after it, `dock_area.rs` `drag_preview`), placed with
/// the frame the drag measured, so it is drawn above everything in the
/// area: the handles' lines, which lie over the edges of the groups beside
/// them, never cover its edges, and no frame clips it. It moves from place to
/// place, across groups too. The compact presentation has none, and a drag
/// over a tab bar shows the insertion line ([`drop_line`]) instead: it is
/// not drawn, nor `renderDropIndicator` called, for a tab bar's slot.
///
/// In a terminal it is the region's outline, one Cell in the accent (the
/// hue of the focus ring) around it, over a faint band of the accent: a
/// mark laid over what the region shows, whose text stays readable under
/// it, not a surface. None of the app's parts are drawn, and it jumps from
/// Cell to Cell.
pub(crate) fn drop_indicator(a: AreaCx) -> AnyElement {
    let terminal = crate::terminal::is_terminal();
    let target = computed(move || {
        if a.compact.get() {
            return None;
        }
        a.drag.with(|drag| {
            drag.as_ref()
                .and_then(|d| d.target)
                .filter(|t| t.line.is_none())
        })
    });
    when(
        move || target.with(Option::is_some),
        move || {
            let place = move || {
                target.get().map(|t| {
                    let p = DropPlaceholderBounds::for_placement(t.content, t.side);
                    Bounds {
                        origin: t.content.origin + p.origin(),
                        size: p.size(),
                    }
                })
            };
            indicator_overlay(a, place)
                .map(|v| match terminal {
                    true => v
                        .border(px(1.0))
                        .border_color(crate::terminal::ACCENT)
                        .bg(crate::terminal::ACCENT.alpha(DROP_WASH))
                        .rounded(px(4.0)),
                    false => v
                        .app_class(a.props.drop_indicator_class)
                        .inline_style(a.props.drop_indicator_style),
                })
                .child(dynamic(move || {
                    if terminal {
                        return None;
                    }
                    let target = target.get()?;
                    let value = DockDropIndicator {
                        group: target.group.as_u64(),
                        side: target.side,
                        index: target.index,
                    };
                    a.props
                        .render_drop_indicator
                        .get()
                        .map(|r| r.render(target.group.as_u64().to_string(), value).flex_1())
                }))
        },
    )
    .into_element()
}

/// How thick the insertion line is: two points (one Cell in a terminal,
/// `resolve_bar`).
const LINE_THICKNESS: Points = px(2.0);

/// The insertion line: while a drag would land on a slot of a tab bar
/// (the compact strip's too), a thin line across the bar at the boundary
/// between the tabs before and after the slot ([`slot_line`]), as the
/// editors draw it; the content frame is not tinted then. An overlay as the
/// drop indicator is, with its ordering under the drag preview and its
/// motion, in the theme's focus-ring color (the accent in a terminal,
/// where it jumps from Cell to Cell).
pub(crate) fn drop_line(a: AreaCx) -> AnyElement {
    let terminal = crate::terminal::is_terminal();
    let line = computed(move || {
        a.drag
            .with(|drag| drag.as_ref().and_then(|d| d.target).and_then(|t| t.line))
    });
    when(
        move || line.with(Option::is_some),
        move || {
            indicator_overlay(a, move || line.get()).map(|v| match terminal {
                // A terminal draws no fills: the line is a Cell's border
                // in the accent, `│` across a row of tabs (`─` down a
                // column of them).
                true => match line.with(|l| l.is_some_and(|l| l.size.width > l.size.height)) {
                    true => v.border_t(px(1.0)),
                    false => v.border_l(px(1.0)),
                }
                .border_color(crate::terminal::ACCENT),
                false => v
                    .bg(move || crate::theme::theme().ring)
                    .rounded(LINE_THICKNESS * 0.5),
            })
        },
    )
    .into_element()
}

/// The overlay of the drop indicator or the insertion line, at `place`:
/// it takes no touches, eases from place to place (fading in as it
/// appears) outside a terminal, and once laid out bumps
/// [`AreaCx::indicator_shown`], so the drag preview is mounted again above
/// it.
fn indicator_overlay(
    a: AreaCx,
    place: impl Fn() -> Option<Bounds<Points>> + Copy + 'static,
) -> Overlay {
    let terminal = crate::terminal::is_terminal();
    // The first place is where it appears; a later one, where it moves to.
    let shown = Cell::new(None);
    effect(move || {
        let now = place();
        let before = shown.replace(now);
        if before != now && !terminal {
            animate_indicator(before.is_none());
        }
    });
    // Once its overlay is shown (laid out, so opened in a commit before):
    // the drag preview is mounted again, in a later commit, above it.
    let opened = Cell::new(false);
    overlay()
        .on_layout(move |_: &Bounds<Points>| {
            if !opened.replace(true) {
                a.indicator_shown.update(|n| *n = n.wrapping_add(1));
            }
        })
        .pointer_events(PointerEvents::None)
        .focusable(false)
        .style_with(move |s| match place() {
            Some(p) => s
                .left(p.origin.x)
                .top(p.origin.y)
                .w(p.size.width)
                .h(p.size.height),
            None => s,
        })
}

/// The tab of panel `panel` (in group `source`; `None`: the compact
/// strip): the app's `renderTab` inside, the tab role and its selected
/// state, the tab panel `content` as what it controls, a press that
/// selects it and a drag that moves it. It registers its view in `tabs`
/// for the drags to measure.
pub(crate) fn tab(
    a: AreaCx,
    panel: PanelId,
    source: Option<NodeId>,
    value: Memo<Option<DockTab>>,
    content: ElementRef,
    tabs: Rc<RefCell<Vec<(PanelId, ElementRef)>>>,
) -> View {
    let me = element_ref();
    tabs.borrow_mut().push((panel.clone(), me));
    {
        let panel = panel.clone();
        cleanup(move || {
            tabs.borrow_mut()
                .retain(|(p, r)| !(*p == panel && *r == me));
        });
    }
    // A terminal's pointer is a mouse: it has no fingers.
    let desktop = is_desktop() || crate::terminal::is_terminal();
    // A pointer (a mouse, a trackpad, a pen over the screen) hovers the
    // tab before it presses it, and a finger never does: a press of a
    // hovering pointer, or any press on the desktops, arms the drag at
    // once; a finger's needs a long press first.
    let hovered = stored(false);
    let armed = stored(false);
    let can_drag = move || {
        untracked(|| match source {
            Some(node) => a.draggable(node),
            None => !a.props.locked.get(),
        })
    };
    let selected = move || value.with(|v| v.as_ref().is_some_and(|v| v.active));
    // The tab that becomes the displayed one (a press in another group,
    // the ref's `selectPanel`, a panel added) comes into view in its bar's
    // scroll view, by as little as shows it.
    effect(move || {
        if selected() {
            me.reveal(RevealOptions::default().vertical(ScrollAlignment::Nearest));
        }
    });
    let pressed = panel.clone();
    let dragged = panel.clone();
    view()
        .role(AccessibilityRole::Tab)
        .accessibility_state(move || AccessibilityState {
            selected: selected(),
            ..AccessibilityState::default()
        })
        .accessibility_controls(Some(content))
        .app_class(a.props.tab_class)
        .inline_style(a.props.tab_style)
        .element_ref(&me)
        .on_press(move || a.select(&pressed))
        .on_mouse_enter(move |_: &MouseEvent| {
            hovered.replace(true);
        })
        .on_mouse_leave(move |_: &MouseEvent| {
            hovered.replace(false);
        })
        .on_press_down(move || {
            armed.replace(false);
        })
        .on_long_press(move || {
            armed.replace(true);
        })
        .claim_touches(TouchClaim::on_move().ask(move |request: &ClaimRequest| {
            // The desktops' rule is decided here, from the touches alone:
            // a platform may report no press for a gesture its responder
            // takes.
            if !(desktop || hovered.get() || armed.get()) || !can_drag() {
                return;
            }
            let moved = request.event.gesture.delta;
            if moved.x.0.hypot(moved.y.0) >= DRAG_SLOP.0 {
                request.claim();
            }
        }))
        // A terminal's pointer scrolls a scroll view by dragging it, and
        // would take the tabs' before the claim above is answered: there
        // the platform itself recognizes the tab's drag, as a pan.
        .when(crate::terminal::is_terminal(), |tab| {
            tab.claim_touches(TouchClaim::on_pan(PanActivation::default()).ask(
                move |request: &ClaimRequest| {
                    if can_drag() {
                        request.claim();
                    }
                },
            ))
        })
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| a.start_drag(dragged.clone(), source, e.page))
        .on_responder_move(move |e: &ResponderEvent| a.drag_to(e.page))
        .on_responder_release(move |e: &ResponderEvent| a.drop_at(e.page))
        .on_responder_terminate(move |_: &ResponderEvent| a.cancel_drag())
        .child(dynamic(move || {
            let value = value.get()?;
            Some(match a.props.render_tab.get() {
                Some(r) => r.render(value.panel.key().clone(), value).into_element(),
                None => text(value.panel.key().clone()).into_element(),
            })
        }))
}

/// A measured view's bounds in the root view's coordinates.
fn page_bounds(m: nsh_core::Measurement) -> Bounds<Points> {
    Bounds {
        origin: m.page,
        size: m.frame.size,
    }
}

/// Whether tab bar `bar` lists its tabs top to bottom: it is taller than
/// wide.
fn is_vertical(bar: Bounds<Points>) -> bool {
    bar.size.height > bar.size.width
}

/// The slot among `tabs` (left to right, or top to bottom when `bar` is
/// taller than wide) that `at` is past, `panel` left out, and the others
/// in that order.
fn slot_at<'t>(
    bar: Bounds<Points>,
    tabs: &'t [(PanelId, Bounds<Points>)],
    panel: &PanelId,
    at: Point<Points>,
) -> (usize, Vec<&'t (PanelId, Bounds<Points>)>) {
    let across = is_vertical(bar);
    let mut others: Vec<&(PanelId, Bounds<Points>)> =
        tabs.iter().filter(|(p, _)| p != panel).collect();
    let key = |b: &Bounds<Points>| if across { b.center().y } else { b.center().x };
    crate::sort::sort_by(&mut others, |x, y| key(&x.1).0.total_cmp(&key(&y.1).0));
    let pointer = if across { at.y } else { at.x };
    let index = others.iter().filter(|(_, b)| key(b) < pointer).count();
    (index, others)
}

/// The insertion line at slot `index` of tab bar `bar` whose tabs (the
/// dragged one left out) are `others`, in the order [`slot_at`] gives:
/// `thickness` across, the bar's height (its width for a vertical bar)
/// long, centered on the boundary between the tab before the slot and the
/// one after it (the first tab's start for the first slot, the last one's
/// end for the last; the bar's start with no tabs), kept inside the bar.
fn slot_line(
    bar: Bounds<Points>,
    others: &[Bounds<Points>],
    index: usize,
    thickness: Points,
) -> Bounds<Points> {
    let vertical = is_vertical(bar);
    // A frame's start and end along the bar.
    let span = |b: &Bounds<Points>| match vertical {
        true => (b.origin.y, b.origin.y + b.size.height),
        false => (b.origin.x, b.origin.x + b.size.width),
    };
    let (bar_start, bar_end) = span(&bar);
    let before = index
        .checked_sub(1)
        .and_then(|i| others.get(i))
        .map(|b| span(b).1);
    let after = others.get(index).map(|b| span(b).0);
    let boundary = match (before, after) {
        (Some(end), Some(start)) => (end + start) * 0.5,
        (Some(end), None) => end,
        (None, Some(start)) => start,
        (None, None) => bar_start,
    };
    let along = (boundary - thickness * 0.5)
        .max(bar_start)
        .min(bar_end - thickness);
    match vertical {
        true => Bounds {
            origin: Point {
                x: bar.origin.x,
                y: along,
            },
            size: Size {
                width: bar.size.width,
                height: thickness,
            },
        },
        false => Bounds {
            origin: Point {
                x: along,
                y: bar.origin.y,
            },
            size: Size {
                width: thickness,
                height: bar.size.height,
            },
        },
    }
}

impl AreaCx {
    /// Registers the views of a group for drags to measure, while the view
    /// making them lives.
    pub(crate) fn register(self, refs: GroupRefs) {
        let mine = refs.tabs.clone();
        self.refs.with(|all| all.push(refs));
        cleanup(move || {
            self.refs
                .with(|all| all.retain(|r| !Rc::ptr_eq(&r.tabs, &mine)));
        });
    }

    /// Whether panels may be dropped (tracked).
    fn droppable(self) -> bool {
        !self.props.locked.get() && self.zoomed.get().is_none()
    }

    /// A tab's drag began at `pointer`: the groups are measured.
    pub(crate) fn start_drag(self, panel: PanelId, source: Option<NodeId>, pointer: Point<Points>) {
        self.drag.set(Some(TabDrag {
            panel,
            source,
            pointer,
            target: None,
        }));
        self.zones.replace(Vec::new());
        let compact = self.compact.get_untracked();
        let refs: Vec<GroupRefs> = self.refs.with(|all| {
            all.iter()
                .filter(|r| r.group.is_none() == compact)
                .cloned()
                .collect()
        });
        spawn(async move {
            let pending: Vec<_> = refs
                .iter()
                .map(|r| {
                    let tabs: Vec<_> = r
                        .tabs
                        .borrow()
                        .iter()
                        .map(|(p, e)| (p.clone(), e.measure()))
                        .collect();
                    (
                        r.group,
                        r.bar.measure(),
                        r.content.map(|c| c.measure()),
                        tabs,
                    )
                })
                .collect();
            let mut zones = Vec::with_capacity(pending.len());
            for (group, bar, content, tabs) in pending {
                let bar = bar.await.map(page_bounds);
                let content = match content {
                    Some(content) => content.await.map(page_bounds),
                    None => None,
                };
                let mut measured = Vec::with_capacity(tabs.len());
                for (panel, tab) in tabs {
                    if let Some(m) = tab.await {
                        measured.push((panel, page_bounds(m)));
                    }
                }
                zones.push(Zone {
                    group,
                    bar,
                    content,
                    tabs: measured,
                });
            }
            self.zones.replace(zones);
            let pointer = self.drag.with_untracked(|d| d.as_ref().map(|d| d.pointer));
            if let Some(pointer) = pointer {
                self.drag_to(pointer);
            }
        });
    }

    /// The pointer moved to `pointer`: where the drag would land.
    pub(crate) fn drag_to(self, pointer: Point<Points>) {
        let Some(drag) = self.drag.get_untracked() else {
            return;
        };
        let target = untracked(|| self.resolve(&drag, pointer));
        self.drag.set(Some(TabDrag {
            pointer,
            target,
            ..drag
        }));
    }

    /// The pointer lifted at `pointer`: the panel moves where it lands.
    pub(crate) fn drop_at(self, pointer: Point<Points>) {
        self.drag_to(pointer);
        let Some(drag) = self.drag.get_untracked() else {
            return;
        };
        self.cancel_drag();
        let Some(at) = drag.target else {
            return;
        };
        let target = match at.side {
            Some(placement) => InsertTarget::Split {
                node: at.group,
                placement,
                size: None,
            },
            None => InsertTarget::Tabs {
                node: at.group,
                ix: at.index,
                activate: true,
            },
        };
        if self.compact.get_untracked() {
            self.current.set(Some(at.group));
        }
        self.edit(|area| area.move_panel(drag.panel, target));
    }

    /// The drag ended without a drop.
    pub(crate) fn cancel_drag(self) {
        self.drag.set(None);
        self.zones.replace(Vec::new());
    }

    /// Where `drag` would land with the pointer at `at`.
    fn resolve(self, drag: &TabDrag, at: Point<Points>) -> Option<DropAt> {
        if self.props.locked.get() {
            return None;
        }
        let zones = self.zones.get();
        if let Some(zone) = zones
            .iter()
            .find(|z| z.bar.is_some_and(|bar| bar.contains(&at)))
        {
            return self.resolve_bar(drag, zone, at);
        }
        if !self.droppable() {
            return None;
        }
        zones.iter().find_map(|zone| {
            let (group, content) = (zone.group?, zone.content?);
            if !content.contains(&at) {
                return None;
            }
            let side = split_placement_at(content, at);
            let alone = self
                .area
                .with(|area| area.group(group).is_some_and(|g| g.panels.len() == 1));
            if drag.source == Some(group) && (side.is_none() || alone) {
                return None;
            }
            Some(DropAt {
                group,
                side,
                index: None,
                content,
                line: None,
            })
        })
    }

    /// Over a tab bar: the slot the pointer is at. The compact strip lists
    /// several groups' panels; its slot is the place before (or after the
    /// last) panel there, in that panel's group.
    fn resolve_bar(self, drag: &TabDrag, zone: &Zone, at: Point<Points>) -> Option<DropAt> {
        let bar = zone.bar?;
        let (index, others) = slot_at(bar, &zone.tabs, &drag.panel, at);
        // One Cell in a terminal: a Cell is wider and taller than a point,
        // and a thinner line covers no Cell at all.
        let thickness = match (crate::terminal::is_terminal(), is_vertical(bar)) {
            (true, true) => crate::terminal::cell_height(),
            (true, false) => crate::terminal::cell_width(),
            (false, _) => LINE_THICKNESS,
        };
        let frames: Vec<Bounds<Points>> = others.iter().map(|(_, b)| *b).collect();
        let line = Some(slot_line(bar, &frames, index, thickness));
        let others: Vec<PanelId> = others.into_iter().map(|(p, _)| p.clone()).collect();
        match zone.group {
            Some(group) => {
                if !self.droppable() {
                    return None;
                }
                Some(DropAt {
                    group,
                    side: None,
                    index: Some(index),
                    content: zone.content.unwrap_or(bar),
                    line,
                })
            }
            None => {
                let (neighbor, after) = match others.get(index) {
                    Some(next) => (next.clone(), false),
                    None => (others.last()?.clone(), true),
                };
                self.area.with(|area| {
                    let group = area.group(area.group_of_panel(neighbor.as_str())?)?;
                    let kept: Vec<&PanelId> =
                        group.panels.iter().filter(|p| **p != drag.panel).collect();
                    let at = kept.iter().position(|p| **p == neighbor)? + usize::from(after);
                    Some(DropAt {
                        group: group.node,
                        side: None,
                        index: Some(at),
                        content: bar,
                        line,
                    })
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{point, size};

    use super::*;

    fn frame(x: f32, y: f32, w: f32, h: f32) -> Bounds<Points> {
        Bounds {
            origin: point(px(x), px(y)),
            size: size(px(w), px(h)),
        }
    }

    /// A bar at (100, 50), 400 × 24, with tabs a, b and c 80 wide from its
    /// start, 4 apart.
    fn bar_of_three() -> (Bounds<Points>, Vec<(PanelId, Bounds<Points>)>) {
        let bar = frame(100.0, 50.0, 400.0, 24.0);
        let tabs = ["a", "b", "c"]
            .iter()
            .enumerate()
            .map(|(i, p)| {
                (
                    PanelId::from(*p),
                    frame(100.0 + 84.0 * i as f32, 50.0, 80.0, 24.0),
                )
            })
            .collect();
        (bar, tabs)
    }

    /// The line where dragging `panel` over the bar of three at `x` lands.
    fn line_at(panel: &'static str, x: f32) -> (usize, Bounds<Points>) {
        let (bar, tabs) = bar_of_three();
        let (index, others) = slot_at(bar, &tabs, &panel.into(), point(px(x), px(60.0)));
        let frames: Vec<_> = others.iter().map(|(_, b)| *b).collect();
        (index, slot_line(bar, &frames, index, px(2.0)))
    }

    #[test]
    fn the_first_slot_s_line_is_at_the_first_tab_s_start() {
        // c dragged before a: the bar's start, kept inside it.
        assert_eq!(line_at("c", 110.0), (0, frame(100.0, 50.0, 2.0, 24.0)));
        // a dragged before b (where it was): b's start, centered on it.
        assert_eq!(line_at("a", 150.0), (0, frame(183.0, 50.0, 2.0, 24.0)));
    }

    #[test]
    fn a_middle_slot_s_line_is_centered_between_its_tabs() {
        // c dragged between a (ending at 180) and b (starting at 184).
        assert_eq!(line_at("c", 190.0), (1, frame(181.0, 50.0, 2.0, 24.0)));
    }

    #[test]
    fn the_last_slot_s_line_is_at_the_last_tab_s_end() {
        // a dragged past c, which ends at 348.
        assert_eq!(line_at("a", 450.0), (2, frame(347.0, 50.0, 2.0, 24.0)));
    }

    #[test]
    fn a_bar_with_no_other_tab_has_its_line_at_its_start() {
        let bar = frame(0.0, 0.0, 300.0, 24.0);
        assert_eq!(slot_line(bar, &[], 0, px(2.0)), frame(0.0, 0.0, 2.0, 24.0));
    }

    #[test]
    fn a_vertical_bar_s_line_is_horizontal() {
        // A bar 30 wide and 300 tall, tabs 30 × 40 down it, 10 apart.
        let bar = frame(10.0, 100.0, 30.0, 300.0);
        let tabs: Vec<(PanelId, Bounds<Points>)> = ["a", "b", "c"]
            .iter()
            .enumerate()
            .map(|(i, p)| {
                (
                    PanelId::from(*p),
                    frame(10.0, 100.0 + 50.0 * i as f32, 30.0, 40.0),
                )
            })
            .collect();
        let line = |y: f32| {
            let (index, others) = slot_at(bar, &tabs, &"a".into(), point(px(25.0), px(y)));
            let frames: Vec<_> = others.iter().map(|(_, b)| *b).collect();
            (index, slot_line(bar, &frames, index, px(2.0)))
        };
        // Before b (starting at 150), between b (ending at 190) and c
        // (starting at 200), after c (ending at 240).
        assert_eq!(line(120.0), (0, frame(10.0, 149.0, 30.0, 2.0)));
        assert_eq!(line(180.0), (1, frame(10.0, 194.0, 30.0, 2.0)));
        assert_eq!(line(300.0), (2, frame(10.0, 239.0, 30.0, 2.0)));
    }
}
