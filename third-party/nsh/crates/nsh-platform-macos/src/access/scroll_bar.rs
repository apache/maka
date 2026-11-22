//! A scroll area's scroll bar (`AXScrollBar`): where the scroll view is
//! along its axis, as AppKit's scroll views tell VoiceOver and UI tests
//! with their scrollers. NSH draws its own indicator (`crate::scroll`), so
//! the bar is an element of its own, made when a client first asks for it;
//! its value (0 at the start of the content, 1 at its end) and frame are
//! read from the view whenever they are asked for, and a client hears the
//! value change as the view scrolls ([`moved`]).

use objc2::{
    DefinedClass, MainThreadOnly, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::AnyObject,
};
use objc2_app_kit::{
    NSAccessibility, NSAccessibilityElement, NSAccessibilityOrientation,
    NSAccessibilityPostNotification, NSAccessibilityScrollBarRole,
    NSAccessibilityValueChangedNotification, NSView,
};
use objc2_foundation::{NSArray, NSNumber, NSPoint, NSRect, NSSize};

use crate::view::NshView;

/// The bar's thickness (points): the indicator's, with its margins.
const THICKNESS: f64 = 10.0;

/// The scroll view a bar belongs to.
#[derive(Debug)]
pub(crate) struct BarState {
    // Weak: a bar a client keeps must not keep the view alive.
    view: Weak<NSView>,
    vertical: bool,
}

define_class!(
    #[unsafe(super(NSAccessibilityElement))]
    #[thread_kind = MainThreadOnly]
    #[ivars = BarState]
    #[name = "NshAccessibilityScrollBar"]
    #[derive(Debug)]
    pub(crate) struct ScrollBar;

    impl ScrollBar {
        #[unsafe(method_id(accessibilityParent))]
        fn parent(&self) -> Option<Retained<AnyObject>> {
            self.ivars()
                .view
                .load()
                .map(|v| v.into_super().into_super().into_super())
        }

        #[unsafe(method_id(accessibilityValue))]
        fn value(&self) -> Option<Retained<AnyObject>> {
            let at = self.ivars().view.load().map_or(0.0, |v| position(&v));
            Some(NSNumber::new_f64(at).into_super().into_super().into_super())
        }

        // Along the trailing edge of the view (its bottom edge for a
        // horizontal one), where AppKit's scrollers are.
        #[unsafe(method(accessibilityFrame))]
        fn frame(&self) -> NSRect {
            let Some(view) = self.ivars().view.load() else {
                return NSRect::ZERO;
            };
            let f = view.accessibilityFrame();
            // Screen coordinates: y grows upwards.
            if self.ivars().vertical {
                NSRect::new(
                    NSPoint::new(f.origin.x + (f.size.width - THICKNESS).max(0.0), f.origin.y),
                    NSSize::new(THICKNESS.min(f.size.width), f.size.height),
                )
            } else {
                NSRect::new(f.origin, NSSize::new(f.size.width, THICKNESS.min(f.size.height)))
            }
        }
    }
);

/// How far scroll view `view` is along its axis: 0 at the start of the
/// content, 1 at its end (0 when it cannot scroll).
fn position(view: &NSView) -> f64 {
    let Some(view) = NshView::from_ns(view) else {
        return 0.0;
    };
    let Some(s) = view.try_state() else {
        return 0.0;
    };
    let Some(scroll) = &s.scroll else {
        return 0.0;
    };
    let (mx, my) = scroll.max((s.frame.size.width.0, s.frame.size.height.0));
    let (max, at) = if scroll.horizontal {
        (mx, scroll.x)
    } else {
        (my, scroll.y)
    };
    if max > 0.0 {
        f64::from(at.clamp(0.0, max) / max)
    } else {
        0.0
    }
}

/// The scroll bar of scroll area `view` on its axis (`vertical`), made the
/// first time a client asks; `None` for another axis or view.
pub(crate) fn bar(view: &NshView, vertical: bool) -> Option<Retained<ScrollBar>> {
    let mut s = view.try_state_mut()?;
    let area = s
        .access
        .spec
        .as_ref()
        .is_some_and(|spec| !spec.hidden && spec.role == super::Ax::ScrollArea);
    if !area
        || s.scroll
            .as_ref()
            .is_none_or(|scroll| scroll.horizontal == vertical)
    {
        return None;
    }
    if let Some(bar) = s
        .access
        .scroll_bar
        .as_ref()
        .filter(|bar| bar.ivars().vertical == vertical)
    {
        return Some(bar.clone());
    }
    let bar = ScrollBar::alloc(view.ns().mtm()).set_ivars(BarState {
        view: Weak::new(view.ns()),
        vertical,
    });
    // SAFETY: initializing the NSAccessibilityElement superclass.
    let bar: Retained<ScrollBar> = unsafe { msg_send![super(bar), init] };
    bar.setAccessibilityElement(true);
    // SAFETY: an immutable AppKit role constant.
    unsafe { bar.setAccessibilityRole(Some(NSAccessibilityScrollBarRole)) };
    bar.setAccessibilityOrientation(if vertical {
        NSAccessibilityOrientation::Vertical
    } else {
        NSAccessibilityOrientation::Horizontal
    });
    s.access.scroll_bar = Some(bar.clone());
    Some(bar)
}

/// `children`, AppKit's of scroll area `view`, with its scroll bar after
/// them, as a scroll view's scrollers follow its content.
pub(crate) fn with_bar(
    view: &NshView,
    children: Option<Retained<NSArray>>,
) -> Option<Retained<NSArray>> {
    let vertical = view
        .try_state()
        .and_then(|s| s.scroll.as_ref().map(|scroll| !scroll.horizontal));
    let Some(bar) = vertical.and_then(|vertical| bar(view, vertical)) else {
        return children;
    };
    let mut all: Vec<Retained<AnyObject>> = children.iter().flat_map(|c| c.iter()).collect();
    all.push(bar.into_super().into_super().into_super());
    Some(NSArray::from_retained_slice(&all))
}

/// Scroll view `view` moved, or its content, size or content insets
/// changed: a client that has its bar hears that the bar's value changed.
pub(crate) fn moved(view: &NshView) {
    let bar = view.try_state().and_then(|s| s.access.scroll_bar.clone());
    if let Some(bar) = bar {
        // SAFETY: an immutable AppKit notification constant, posted for a
        // live element on the main thread.
        unsafe { NSAccessibilityPostNotification(&bar, NSAccessibilityValueChangedNotification) };
    }
}
