//! A `DockArea` at compact width (below 600 points of its own width:
//! phones, narrow split views, windows and containers; or `compact`), as `UISplitViewController` collapses
//! on compact width and Material 3's supporting pane becomes a sheet. The
//! layout keeps its data; only its presentation changes:
//!
//! - **The center** shows one of its tab groups at a time, full size. Its
//!   tab bar lists every visible center panel in tree order; selecting a
//!   panel of another group makes that group the one shown (and displays
//!   the panel in it). Every center panel stays placed, hidden but the
//!   shown one, so switching keeps their state. A drag (after a long press
//!   on touch screens) only reorders: it moves the panel next to the tab
//!   it is dropped by, in that tab's group; nothing splits.
//! - **The side docks** are drawers over the center from their edge, as
//!   wide as the dock, and **the bottom dock** a sheet as tall. One at a
//!   time is presented (`AreaCx::presented`), none when the area becomes
//!   compact, whatever the layout's `open` says: `toggleDock` /
//!   `setDockOpen` present one (dismissing the other) or dismiss it, and
//!   a press on its backdrop, Escape and back dismiss it. That is the
//!   compact presentation's own state: the layout's `open` (the full
//!   presentation's docks) is left as it is and nothing is reported as a
//!   layout change, so a window widened again shows the docks as they
//!   were; `onDockOpenChange` and `DockInfo::open` follow what is
//!   presented. It slides in and out as `Sheet` does (`SheetMotion`), over
//!   its backdrop (each dock's own, so only the presented one shows,
//!   apart from one fading out while another comes in). A dismissed one
//!   stays placed out of view
//!   (`display: none` around its overlays, which also keeps it from
//!   taking Escape), so its panels keep their state. The drawers, the
//!   sheet and the backdrop are the app's to style (`drawerClass`,
//!   `sheetClass`, `backdropClass`); NSH draws no scrim or card.

use std::rc::Rc;

use nsh_core::{
    geometry::{Bounds, Points},
    prelude::*,
};

use super::{
    dock_area::{AreaCx, DockInfo, DockTab, GroupRefs, dock_key, region},
    layout::PanelId,
    state::DockPlacement,
    tab_group::{panel_slot, shown_of, tab, tab_value},
};
use crate::popup::SheetMotion;

/// The compact presentation of area `a`.
pub(crate) fn compact_view(a: AreaCx) -> AnyElement {
    let groups = computed(move || {
        a.area.with(|area| {
            area.groups()
                .into_iter()
                .filter(|g| g.placement == DockPlacement::Center)
                .collect::<Vec<_>>()
        })
    });
    let current = computed(move || {
        let pick = a.current.get();
        groups.with(|groups| {
            groups
                .iter()
                .find(|g| Some(g.node) == pick)
                .or(groups.first())
                .cloned()
        })
    });
    let shown = computed(move || current.with(|g| g.as_ref().and_then(|g| shown_of(a, g))));
    let panels = computed(move || {
        groups.with(|groups| {
            groups
                .iter()
                .flat_map(|g| g.panels.iter().cloned())
                .collect::<Vec<_>>()
        })
    });
    let tabs = computed(move || {
        panels
            .get()
            .into_iter()
            .filter(|p| a.visible(p))
            .collect::<Vec<_>>()
    });
    let refs = GroupRefs {
        group: None,
        bar: element_ref(),
        content: None,
        tabs: Rc::default(),
    };
    a.register(refs.clone());
    let tab_refs = refs.tabs.clone();
    view()
        .flex_1()
        .flex_col()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .child(
            view()
                .flex_1()
                .flex_col()
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
                            move |panel, index| {
                                let id = panel.get_untracked();
                                let value = {
                                    let id = id.clone();
                                    computed(move || {
                                        tab_value(a, &id).map(|tab| DockTab {
                                            index: index.get(),
                                            active: shown.with(|s| s.as_ref() == Some(&id)),
                                            ..tab
                                        })
                                    })
                                };
                                tab(a, id, None, value, tab_refs.clone())
                            },
                        )),
                )
                .child(
                    view()
                        .relative()
                        .flex_1()
                        .min_h(px(0.0))
                        .overflow_hidden()
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
                        ))
                        .child(when(
                            move || panels.with(Vec::is_empty),
                            move || {
                                dynamic(move || {
                                    a.props
                                        .render_empty
                                        .get()
                                        .map(|r| r.render("empty", DockPlacement::Center).flex_1())
                                })
                            },
                        )),
                ),
        )
        .child(drawer(a, DockPlacement::Left))
        .child(drawer(a, DockPlacement::Right))
        .child(drawer(a, DockPlacement::Bottom))
        .into_element()
}

/// The dock at `placement` as a drawer (a sheet at the bottom), while the
/// area has one.
fn drawer(a: AreaCx, placement: DockPlacement) -> AnyElement {
    let has = computed(move || a.area.with(|area| area.dock(placement).is_some()));
    when(
        move || has.get(),
        move || {
            let info = computed(move || {
                a.area.with(|area| {
                    area.dock(placement).map(|pane| DockInfo {
                        placement,
                        // Compact: presented, not the layout's `open`.
                        open: a.is_dock_open(placement),
                        size: pane.dock.size(),
                        collapsible: pane.dock.is_collapsible(),
                    })
                })
            });
            let side = match placement {
                DockPlacement::Left => Placement::Left,
                DockPlacement::Right => Placement::Right,
                _ => Placement::Bottom,
            };
            let motion = SheetMotion::new(
                move || info.with(|i| i.as_ref().is_some_and(|i| i.open)),
                move || side,
            )
            .keeping_panel();
            let close = move || {
                a.set_dock_open(placement, false);
            };
            let size = move || info.with(|i| i.as_ref().map_or(Points::ZERO, |i| i.size));
            let bottom = placement == DockPlacement::Bottom;
            let backdrop = overlay()
                .inset_0()
                .bind_opacity(&motion.fade)
                .focusable(false)
                .app_class(a.props.backdrop_class)
                .inline_style(a.props.backdrop_style)
                .on_press(close);
            let panel = overlay()
                .flex_col()
                .style_with(move |s| match side {
                    Placement::Left => s.top_0().bottom_0().left_0().w(size()),
                    Placement::Right => s.top_0().bottom_0().right_0().w(size()),
                    _ => s.left_0().right_0().bottom_0().h(size()),
                })
                .app_class(if bottom {
                    a.props.sheet_class
                } else {
                    a.props.drawer_class
                })
                .inline_style(if bottom {
                    a.props.sheet_style
                } else {
                    a.props.drawer_style
                })
                .bind_translate_x(&motion.x)
                .bind_translate_y(&motion.y)
                .on_layout(move |frame: &Bounds<Points>| motion.laid_out(frame.size))
                .on_cancel(close)
                .child(dynamic(move || {
                    let info = info.get()?;
                    a.props
                        .render_dock
                        .get()
                        .map(|r| r.render(dock_key(placement), info))
                }))
                .child(view().flex_1().min_h(px(0.0)).child(region(a, placement)));
            // Out of view while closed, and placed: hidden around the
            // overlays, which are then not shown (nor take Escape).
            view()
                .absolute()
                .style_when(move || !motion.shown.get(), |s| s.hidden())
                .child(backdrop)
                .child(panel)
        },
    )
    .into_element()
}
