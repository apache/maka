//! `TitleBar`: the row an app draws as its window's title bar when the
//! window's `titleBar` style is `hidden`. Its background spans the row;
//! its content keeps clear of the system's window controls (macOS's
//! traffic lights, Windows' caption buttons, GTK's window buttons) where
//! the row actually meets them, so a bar over one pane of a split view
//! only steps aside on the pane at the window's edge.

use nsh_core::{
    element::desktop::current_window,
    geometry::{Edges, Points},
    prelude::*,
};

/// The props of [`TitleBar`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TitleBarProps {
    /// What the bar holds (a title, a sidebar toggle, the app's buttons).
    pub children: Prop<Children>,
}

/// The insets that keep a bar's content clear of the window controls:
/// `area` is the window's title bar area (the widths its controls take at
/// the left and right edges), `left` and `width` the bar's place across
/// the window's content, `window` that content's width. Only the part of
/// a control's width the bar overlaps counts: a bar that starts past the
/// left controls gets no left inset. Physical edges: the controls sit at
/// the same edge whatever the layout direction.
pub fn title_bar_insets(
    area: Edges<Points>,
    left: Points,
    width: Points,
    window: Points,
) -> (Points, Points) {
    let right_gap = window.0 - (left.0 + width.0);
    (
        Points((area.left.0 - left.0).max(0.0)),
        Points((area.right.0 - right_gap).max(0.0)),
    )
}

/// The row of a window's own title bar (with `titleBar: { style: "hidden" }`).
/// Pressing and dragging it moves the window, double clicking it does what
/// the system's title bar does; the controls inside it still take their
/// presses. It is as tall as the window's title bar area (`titleBar().height`)
/// at least and lays its children out in a row; it adds padding at the
/// left and right edges only where it overlaps the system's window
/// controls, in the current window (`<Window>`), including after entering
/// or leaving full screen (where there are none). Colors, borders, gaps and
/// any further padding are the app's `class` and `style`.
#[component]
pub fn TitleBar(props: TitleBarProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let me = element_ref();
    // Where the bar is across the window: left edge and width.
    let place = signal((Points::ZERO, Points::ZERO));
    let window = current_window();
    let area = computed(move || window.title_bar());
    let measure = move || {
        spawn(async move {
            if let Some(m) = me.measure().await {
                place.set((m.page.x, m.frame.size.width));
            }
        });
    };
    // A change of the window's width or of its controls moves the bar.
    effect(move || {
        let _ = (nsh_core::prelude::window(), area.get());
        untracked(measure);
    });
    let insets = computed(move || {
        let (left, width) = place.get();
        title_bar_insets(area.get(), left, width, nsh_core::prelude::window().width)
    });
    view()
        .element_ref(&me)
        .flex_row()
        .items_center()
        .flex_shrink(0.0)
        .min_h(move || Length::from(area.get().top))
        .pl(move || Length::from(insets.get().0))
        .pr(move || Length::from(insets.get().1))
        .window_drag(true)
        .on_layout(move |_: &Bounds<Points>| measure())
        .child(props.children)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(left: f32, right: f32) -> Edges<Points> {
        Edges {
            top: Points(28.0),
            right: Points(right),
            bottom: Points::ZERO,
            left: Points(left),
        }
    }

    #[test]
    fn insets_cover_only_the_overlap_with_the_controls() {
        let w = Points(800.0);
        // Full width: both sides (macOS left, Windows right).
        assert_eq!(
            title_bar_insets(area(78.0, 0.0), Points(0.0), w, w),
            (Points(78.0), Points(0.0))
        );
        assert_eq!(
            title_bar_insets(area(0.0, 138.0), Points(0.0), w, w),
            (Points(0.0), Points(138.0))
        );
        // A sidebar 240 wide: the content pane's bar starts past the
        // traffic lights and needs no inset.
        assert_eq!(
            title_bar_insets(area(78.0, 0.0), Points(240.0), Points(560.0), w),
            (Points(0.0), Points(0.0))
        );
        // A sidebar narrower than the controls: the rest of them.
        assert_eq!(
            title_bar_insets(area(78.0, 0.0), Points(50.0), Points(750.0), w),
            (Points(28.0), Points(0.0))
        );
        // The left pane with controls at the right: no inset.
        assert_eq!(
            title_bar_insets(area(0.0, 138.0), Points(0.0), Points(240.0), w),
            (Points(0.0), Points(0.0))
        );
        // Full screen or a system title bar: nothing to avoid.
        assert_eq!(
            title_bar_insets(Edges::default(), Points(0.0), w, w),
            (Points(0.0), Points(0.0))
        );
    }
}
