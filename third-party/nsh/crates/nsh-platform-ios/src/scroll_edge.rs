//! `ios={{ scrollEdgeElement }}`: a view floating over an edge of a scroll
//! view (a bottom toolbar, a floating button) shapes that scroll view's
//! edge effect, as a bar does. UIKit learns of it through a
//! `UIScrollEdgeElementContainerInteraction` on the view, naming the scroll
//! view and the edge: the content scrolled under the view then fades out
//! around what the view shows. The interaction came with the edge effect
//! (iOS 26); earlier versions have neither, and nothing is done there.
//!
//! An edge named by at least one view uses the soft style, the effect the
//! system's bars give on iPhone and iPad alike. Left automatic, UIKit can
//! pick the hard style (a near-opaque band with a dividing line), as it does
//! under a search field floating over a list: that cuts the content the view
//! is meant to let fade out. The mount counts the views naming each edge and
//! gives the edge back its automatic style once none does; NSH sets this
//! style nowhere else, so automatic is what the edge had before. Only the
//! named edge changes: a top edge under a navigation bar is the bar's
//! effect too, and is soft while a view names it.

use nsh_core::ScrollEdge;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use objc2_ui_kit::{UIScrollView, UIView};

/// `UIRectEdge` of `edge`.
fn rect_edge(edge: ScrollEdge) -> usize {
    match edge {
        ScrollEdge::Top => 1 << 0,
        // `UIRectEdgeBottom`; `ScrollEdge` may grow.
        _ => 1 << 2,
    }
}

/// Gives `scroll`'s effect at `edge` the soft style, or back the
/// automatic one.
pub(crate) fn set_style(scroll: &UIScrollView, edge: ScrollEdge, soft: bool) {
    let Some(class) = AnyClass::get(c"UIScrollEdgeEffectStyle") else {
        return;
    };
    // SAFETY: UIScrollView's `topEdgeEffect` / `bottomEdgeEffect` (never
    // nil from iOS 26, which `UIScrollEdgeEffectStyle` came with), the
    // style's class properties and the effect's `style` setter.
    unsafe {
        let effect: Option<Retained<AnyObject>> = match edge {
            ScrollEdge::Top => msg_send![scroll, topEdgeEffect],
            _ => msg_send![scroll, bottomEdgeEffect],
        };
        let Some(effect) = effect else { return };
        let style: Retained<AnyObject> = if soft {
            msg_send![class, softStyle]
        } else {
            msg_send![class, automaticStyle]
        };
        let () = msg_send![&*effect, setStyle: &*style];
    }
}

/// Gives `view` the interaction naming `to` (the scroll view and its
/// edge), or takes it away (`None`). `kept` holds the interaction the view
/// has. The style of the edge is the mount's ([`set_style`]).
pub(crate) fn set(
    view: &UIView,
    kept: &mut Option<Retained<AnyObject>>,
    to: Option<(&UIScrollView, ScrollEdge)>,
) {
    let Some((scroll, edge)) = to else {
        if let Some(interaction) = kept.take() {
            // SAFETY: UIView's `removeInteraction:` with the interaction
            // added below.
            let () = unsafe { msg_send![view, removeInteraction: &*interaction] };
        }
        return;
    };
    let interaction = match kept {
        Some(interaction) => interaction.clone(),
        None => {
            let Some(class) = AnyClass::get(c"UIScrollEdgeElementContainerInteraction") else {
                return;
            };
            // SAFETY: the interaction's plain initializer; UIView's
            // `addInteraction:` with a UIInteraction, which the view keeps.
            let interaction: Retained<AnyObject> = unsafe { msg_send![class, new] };
            let () = unsafe { msg_send![view, addInteraction: &*interaction] };
            kept.insert(interaction).clone()
        }
    };
    // SAFETY: the interaction's `scrollView` (held weakly by UIKit) and
    // `edge` (a `UIRectEdge`) setters.
    unsafe {
        let () = msg_send![&*interaction, setScrollView: scroll];
        let () = msg_send![&*interaction, setEdge: rect_edge(edge)];
    }
}
