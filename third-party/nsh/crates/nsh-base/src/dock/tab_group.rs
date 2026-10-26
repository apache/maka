//! A `DockArea`'s tab groups (`gpui-base`'s `TabGroup`): the tab bar, the
//! tabs the area wraps around the app's `renderTab`, the content frame
//! where every panel of the group is placed and the displayed one shown;
//! the drop indicator; and the drag of a tab, which runs in the core.
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
//! ([`super::DropPlaceholderBounds::for_placement`]). The release applies
//! one move ([`AreaCx::drop_at`]); a gesture the system takes away drops
//! nothing.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::{
    AccessibilityState,
    element::{LayoutAnimation, LayoutCurve, LayoutTransition},
    geometry::{Bounds, Point, Points},
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
                .child(each(
                    move || tabs.get(),
                    |panel: &PanelId| panel.clone(),
                    move |panel, _| {
                        let id = panel.get_untracked();
                        let value = {
                            let id = id.clone();
                            computed(move || tab_value(a, &id))
                        };
                        tab(a, id, Some(node), value, tab_refs.clone())
                    },
                )),
        )
        .child(
            view()
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

/// The drop indicator: while a drag would land on a group, over the part
/// of its content frame the panel would take (all of it to merge, a half
/// to split). It is an overlay in the root view, placed with the frame
/// the drag measured, so it is drawn above everything in the area: the
/// handles' lines, which lie over the edges of the groups beside them,
/// never cover its edges, and no frame clips it. It moves from place to
/// place, across groups too. The compact presentation has none.
pub(crate) fn drop_indicator(a: AreaCx) -> AnyElement {
    let target = computed(move || {
        if a.compact.get() {
            return None;
        }
        a.drag.with(|drag| drag.as_ref().and_then(|d| d.target))
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
            // The first place is where it appears; a later one, where it
            // moves to.
            let shown = Cell::new(None);
            effect(move || {
                let now = place();
                let before = shown.replace(now);
                if before != now {
                    animate_indicator(before.is_none());
                }
            });
            overlay()
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
                .app_class(a.props.drop_indicator_class)
                .inline_style(a.props.drop_indicator_style)
                .child(dynamic(move || {
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

/// The tab of panel `panel` (in group `source`; `None`: the compact
/// strip): the app's `renderTab` inside, the tab role and its selected
/// state, a press that selects it and a drag that moves it. It registers
/// its view in `tabs` for the drags to measure.
pub(crate) fn tab(
    a: AreaCx,
    panel: PanelId,
    source: Option<NodeId>,
    value: Memo<Option<DockTab>>,
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
    let desktop = is_desktop();
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
    let pressed = panel.clone();
    let dragged = panel.clone();
    view()
        .role(AccessibilityRole::Tab)
        .accessibility_state(move || AccessibilityState {
            selected: selected(),
            ..AccessibilityState::default()
        })
        .app_class(a.props.tab_class)
        .inline_style(a.props.tab_style)
        .element_ref(&me)
        .on_press(move || a.select(&pressed))
        .on_hover_in(move || {
            hovered.replace(true);
        })
        .on_hover_out(move || {
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

/// The slot among `tabs` (left to right, or top to bottom when `bar` is
/// taller than wide) that `at` is past, `panel` left out.
fn slot_at(
    bar: Bounds<Points>,
    tabs: &[(PanelId, Bounds<Points>)],
    panel: &PanelId,
    at: Point<Points>,
) -> (usize, Vec<PanelId>) {
    let across = bar.size.height > bar.size.width;
    let mut others: Vec<&(PanelId, Bounds<Points>)> =
        tabs.iter().filter(|(p, _)| p != panel).collect();
    let key = |b: &Bounds<Points>| if across { b.center().y } else { b.center().x };
    others.sort_by(|x, y| key(&x.1).0.total_cmp(&key(&y.1).0));
    let pointer = if across { at.y } else { at.x };
    let index = others.iter().filter(|(_, b)| key(b) < pointer).count();
    (index, others.into_iter().map(|(p, _)| p.clone()).collect())
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
            })
        })
    }

    /// Over a tab bar: the slot the pointer is at. The compact strip lists
    /// several groups' panels; its slot is the place before (or after the
    /// last) panel there, in that panel's group.
    fn resolve_bar(self, drag: &TabDrag, zone: &Zone, at: Point<Points>) -> Option<DropAt> {
        let bar = zone.bar?;
        let (index, others) = slot_at(bar, &zone.tabs, &drag.panel, at);
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
                    })
                })
            }
        }
    }
}
