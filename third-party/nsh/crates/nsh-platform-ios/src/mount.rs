//! Applies mount batches to UIKit views and owns the per-surface native
//! state: views, animation graph, image loads and gesture recognizers.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_core::{
    Bounds, Color, Command, EventKind, EventMask, EventPayload, GestureValues, ImageSource,
    KeyboardDismissMode, LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition,
    MountBatch, MountItem, NodeId, PayloadValue, Points, ResizeMode, StickyCell, SubmitBehavior,
    ViewKind, ViewProps, ViewStyle,
    animation::{AnimationProp, AnimationValue},
    geometry::{DevicePixels, point, size},
    time::Instant,
};
use nsh_engine::EngineControl;
use objc2::{
    MainThreadMarker, MainThreadOnly, Message,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    sel,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_quartz_core::{CAAnimation, CALayer, CAMediaTiming, CATransform3D};
use objc2_ui_kit::{
    UIActivityIndicatorView, UIActivityIndicatorViewStyle, UIControlEvents, UIDevice,
    UIFocusEnvironment, UIFocusSystem, UIGestureRecognizer, UIGestureRecognizerState,
    UIPanGestureRecognizer, UIPinchGestureRecognizer, UIRefreshControl,
    UIRotationGestureRecognizer, UIScrollView, UIScrollViewContentInsetAdjustmentBehavior,
    UIScrollViewKeyboardDismissMode, UITraitEnvironment, UIUserInterfaceIdiom, UIView,
    UIViewAnimationOptions,
};

use crate::{
    animation::Animator,
    decor::{self, Decor},
    image::{AssetBase, DecodedImage, ImageLoader, Request, not_a_bitmap},
    input::Input,
    native_view::NshView,
    navigation::{ModalHost, ScreenHost, StackHost},
    press::{PressAt, PressRecognizer},
    target::EventTarget,
    text_view::TextView,
    video::VideoHost,
    web::WebHost,
};

/// The mounter of one surface, shared with native callbacks.
pub(crate) type SharedMounter = Arc<MainThreadBound<RefCell<Option<Mounter>>>>;

enum Native {
    /// The surface root (owned by the platform).
    Root(Retained<UIView>),
    View(Retained<NshView>),
    Text(Retained<TextView>),
    /// The image itself is in [`Decor`]'s image layer.
    Image(Retained<NshView>),
    Scroll(Retained<UIScrollView>),
    Input(Box<Input>),
    Stack(Box<StackHost>),
    Screen(Box<ScreenHost>),
    Modal(Box<ModalHost>),
    HeaderItem(Retained<NshView>),
    /// Shown over the keyboard by the inputs naming it; UIKit places it.
    InputAccessory(Retained<NshView>),
    Canvas(Retained<crate::canvas::CanvasView>),
    Web(Box<WebHost>),
    Video(Box<VideoHost>),
    /// A registered native component in its container.
    Component(Box<crate::component::ComponentHost>),
}

impl Native {
    #[inline]
    fn view(&self) -> &UIView {
        match self {
            Native::Root(v) => v,
            Native::View(v) => v,
            Native::Text(t) => t,
            Native::Image(i) => i,
            Native::Scroll(s) => s,
            Native::Input(i) => i.view(),
            Native::Stack(s) => &s.container,
            Native::Screen(s) => &s.view,
            Native::Modal(m) => &m.view,
            Native::HeaderItem(v) | Native::InputAccessory(v) => v,
            Native::Canvas(v) => v,
            Native::Web(w) => &w.view,
            Native::Video(v) => &v.view,
            Native::Component(c) => &c.container,
        }
    }

    /// The view as a `NshView`, for views with app touch and accessibility
    /// properties.
    fn nsh(&self) -> Option<&NshView> {
        match self {
            Native::View(v)
            | Native::Image(v)
            | Native::HeaderItem(v)
            | Native::InputAccessory(v) => Some(v),
            Native::Component(c) => Some(&c.container),
            Native::Canvas(v) => Some(v),
            Native::Text(t) => Some(t),
            Native::Stack(s) => Some(&s.container),
            Native::Screen(s) => Some(&s.view),
            Native::Modal(m) => Some(&m.view),
            Native::Web(w) => Some(&w.view),
            Native::Video(v) => Some(&v.view),
            _ => None,
        }
    }

    fn kind(&self) -> decor::Kind {
        match self {
            Native::Root(_)
            | Native::View(_)
            | Native::Input(_)
            | Native::Stack(_)
            | Native::Screen(_)
            | Native::Modal(_)
            | Native::HeaderItem(_)
            | Native::InputAccessory(_)
            | Native::Canvas(_)
            | Native::Web(_)
            | Native::Video(_)
            | Native::Component(_) => decor::Kind::View,
            Native::Text(_) => decor::Kind::Text,
            Native::Image(_) => decor::Kind::Image,
            Native::Scroll(_) => decor::Kind::Scroll,
        }
    }
}

#[derive(Default)]
struct Gestures {
    press: Option<Retained<PressRecognizer>>,
    /// Reports `hover:` and the hover events (pointers).
    hover: Option<Retained<objc2_ui_kit::UIHoverGestureRecognizer>>,
    /// `onContextMenu`: secondary clicks (iPad pointers, Mac Catalyst's
    /// mouse).
    context: Option<Retained<objc2_ui_kit::UITapGestureRecognizer>>,
    /// `cursor`: the pointer's look.
    pointer: Option<Retained<objc2_ui_kit::UIPointerInteraction>>,
    pan: Option<Retained<UIPanGestureRecognizer>>,
    pinch: Option<Retained<UIPinchGestureRecognizer>>,
    rotation: Option<Retained<UIRotationGestureRecognizer>>,
    /// `panActivation`.
    gate: Option<Retained<crate::touch::PanGate>>,
    refresh: Option<Refresh>,
}

/// The scroll view touched inside a cooperating pan. Its starting offset
/// is consumed before the panel moves, including within one continuous drag.
struct PanScroll {
    view: Retained<UIScrollView>,
    offset: f32,
}

/// Pull-to-refresh. `UIRefreshControl` throws under Mac Catalyst's Mac
/// idiom, so there the pull is detected in the scroll delegate and shown
/// with a spinner revealed by a content inset.
enum Refresh {
    Native(Retained<UIRefreshControl>),
    Custom {
        spinner: Retained<UIActivityIndicatorView>,
        refreshing: bool,
        /// Qualification of the already-scheduled native reveal task.
        reveal_pending: Rc<Cell<bool>>,
    },
}

impl Drop for Refresh {
    fn drop(&mut self) {
        if let Self::Custom { reveal_pending, .. } = self {
            reveal_pending.set(false);
        }
    }
}

/// Lays UIKit's own content of `view` (controls, navigation bars, text
/// fields) out right to left, or left to right.
pub(crate) fn mirror(view: &UIView, rtl: bool) {
    view.setSemanticContentAttribute(if rtl {
        objc2_ui_kit::UISemanticContentAttribute::ForceRightToLeft
    } else {
        objc2_ui_kit::UISemanticContentAttribute::Unspecified
    });
}

fn mirror_native(native: &Native, rtl: bool) {
    mirror(native.view(), rtl);
    // The navigation controller (its back gesture and transitions) and bar.
    if let Native::Stack(stack) = native {
        if let Some(view) = stack.nav.view() {
            mirror(&view, rtl);
        }
        mirror(&stack.nav.navigationBar(), rtl);
    }
}

/// Whether anything under `root` reaches past `limit` points from its left
/// edge, in `root`'s space: what a scroll view's content legitimately
/// reaches sideways. A scroll view inside scrolls on its own, so what it
/// holds does not count. Stops at the first view that reaches.
fn reaches_beyond(root: &UIView, limit: CGFloat) -> bool {
    let mut pending: Vec<Retained<UIView>> = root.subviews().iter().collect();
    while let Some(view) = pending.pop() {
        let frame = view.convertRect_toView(view.bounds(), Some(root));
        if frame.origin.x + frame.size.width > limit {
            return true;
        }
        if view.downcast_ref::<UIScrollView>().is_none() {
            pending.extend(view.subviews().iter());
        }
    }
    false
}

/// The content width a vertical scroll view keeps. `reaches` says whether
/// anything inside it is wider than `viewport`; the caller asks that once the
/// batch has applied every frame, so a child that only just arrived counts —
/// a first mount sends the content size before its children's frames.
fn settled_content_width(viewport: CGFloat, content: CGFloat, reaches: bool) -> CGFloat {
    if viewport > 0.0 && content > viewport && !reaches {
        viewport
    } else {
        content
    }
}

/// The width a narrowed scroll view keeps. Its content was narrowed to the
/// viewport; the core's width comes back once something inside reaches past
/// the viewport again — a later batch widened a row, and the core sends no
/// new content size for it.
fn narrowed_width(viewport: CGFloat, core: CGFloat, reaches: bool) -> CGFloat {
    if reaches { core } else { viewport }
}

/// Whether the width judgement applies to a scroll view at all: one that
/// scrolls vertically and is not zoomed. A node switched to horizontal (or
/// given a zoom view) holds something the vertical extent never described,
/// so the width narrowed while it was vertical is stale — restoring it would
/// cut the content short.
fn still_judged(horizontal: bool, zoomable: bool) -> bool {
    !horizontal && !zoomable
}

/// The innermost visible subview of `view` at `point` (in `view`),
/// interaction enabled or not, honoring `pointerEvents`.
fn innermost(view: &UIView, point: CGPoint) -> Retained<UIView> {
    let box_only = view
        .downcast_ref::<NshView>()
        .is_some_and(|v| v.pointer_events() == nsh_core::PointerEvents::BoxOnly);
    if !box_only {
        let subviews = view.subviews().to_vec();
        for sub in subviews.iter().rev() {
            if sub.isHidden() || sub.alpha() <= 0.01 {
                continue;
            }
            if let Some(nsh) = sub.downcast_ref::<NshView>()
                && matches!(
                    nsh.pointer_events(),
                    nsh_core::PointerEvents::None | nsh_core::PointerEvents::BoxNone
                )
            {
                continue;
            }
            let p = view.convertPoint_toView(point, Some(sub));
            let b = sub.bounds();
            if p.x >= b.origin.x
                && p.y >= b.origin.y
                && p.x < b.origin.x + b.size.width
                && p.y < b.origin.y + b.size.height
            {
                return innermost(sub, p);
            }
        }
    }
    view.retain()
}

fn ui_insets(i: nsh_core::EdgeInsets) -> objc2_ui_kit::UIEdgeInsets {
    objc2_ui_kit::UIEdgeInsets {
        top: i.top.0 as CGFloat,
        left: i.left.0 as CGFloat,
        bottom: i.bottom.0 as CGFloat,
        right: i.right.0 as CGFloat,
    }
}

/// How the software keyboard last moved: what `LayoutCurve::Keyboard`
/// follows.
#[derive(Debug, Clone, Copy)]
pub(crate) struct KeyboardMotion {
    /// UIKit's curve (`UIKeyboardAnimationCurveUserInfoKey`): 7, a spring
    /// UIKit has no name for, while the keyboard shows or hides.
    pub(crate) curve: isize,
    /// Seconds.
    pub(crate) duration: f64,
    /// When the keyboard started to move (`CACurrentMediaTime`).
    pub(crate) start: f64,
}

impl KeyboardMotion {
    /// Easing in and out from now, over `duration` seconds.
    fn now(duration: f64) -> Self {
        Self {
            // UIViewAnimationCurveEaseInOut.
            curve: 0,
            duration,
            start: objc2_quartz_core::CACurrentMediaTime(),
        }
    }

    /// The options of a UIKit animation on this curve.
    fn options(&self) -> UIViewAnimationOptions {
        // UIViewAnimationOptions keeps the curve in bits 16-19, where any
        // UIViewAnimationCurve fits, the keyboard's unnamed 7 included.
        UIViewAnimationOptions::from_bits_retain(((self.curve as usize) & 0xf) << 16)
            | UIViewAnimationOptions::BeginFromCurrentState
            | UIViewAnimationOptions::AllowUserInteraction
    }

    /// Runs `f`, then starts the animations it added to `view`'s layer
    /// when the keyboard started to move, so that they keep pace with it
    /// however late they come (a batch from the engine thread arrives a
    /// frame or more after the keyboard's notification).
    fn aligned(&self, view: &UIView, f: impl FnOnce()) {
        let layer = view.layer();
        let animations = |layer: &CALayer| {
            layer
                .animationKeys()
                .map(|keys| {
                    keys.iter()
                        .filter_map(|key| {
                            // SAFETY: a key the layer just listed.
                            let animation = unsafe { layer.animationForKey(&key) }?;
                            Some((key, animation))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let before = animations(&layer);
        f();
        let elapsed = objc2_quartz_core::CACurrentMediaTime() - self.start;
        if !(elapsed > 0.0 && elapsed < self.duration) {
            return;
        }
        let begin = layer.convertTime_fromLayer(self.start, None);
        for (key, animation) in animations(&layer) {
            if before
                .iter()
                .any(|(k, a)| *k == key && std::ptr::eq::<CAAnimation>(&**a, &*animation))
            {
                continue;
            }
            // Animations a layer holds are frozen: change a copy.
            // SAFETY: CAAnimation conforms to NSCopying; `copy` returns a
            // new, mutable animation of the same class.
            let copy: Retained<CAAnimation> = unsafe { objc2::msg_send![&*animation, copy] };
            copy.setBeginTime(begin);
            // SAFETY: an immutable Core Animation constant.
            copy.setFillMode(unsafe { objc2_quartz_core::kCAFillModeBackwards });
            layer.addAnimation_forKey(&copy, Some(&key));
        }
    }
}

/// Sets the bottom inset of `scroll` and scrolls `reveal` (a rectangle in
/// its content) into view in one animation along `motion`, the keyboard's,
/// so that the content moves with the keyboard.
fn set_bottom_inset(
    scroll: &UIScrollView,
    bottom: CGFloat,
    reveal: Option<CGRect>,
    motion: KeyboardMotion,
    mtm: MainThreadMarker,
) {
    let target = scroll.retain();
    let block = block2::RcBlock::new(move || {
        let scroll = &target;
        let mut inset = scroll.contentInset();
        inset.bottom = bottom;
        scroll.setContentInset(inset);
        let mut indicators = scroll.verticalScrollIndicatorInsets();
        indicators.bottom = bottom;
        scroll.setVerticalScrollIndicatorInsets(indicators);
        if let Some(rect) = reveal {
            let insets = scroll.adjustedContentInset();
            let height = scroll.bounds().size.height;
            let mut offset = scroll.contentOffset();
            let (top, bottom) = (offset.y + insets.top, offset.y + height - insets.bottom);
            let (min_y, max_y) = (rect.origin.y, rect.origin.y + rect.size.height);
            if max_y > bottom {
                offset.y += (max_y - bottom).min(min_y - top);
            } else if min_y < top {
                offset.y -= top - min_y;
            }
            let end = (scroll.contentSize().height + insets.bottom - height).max(-insets.top);
            offset.y = offset.y.clamp(-insets.top, end);
            scroll.setContentOffset(offset);
        }
    });
    motion.aligned(scroll, || {
        UIView::animateWithDuration_delay_options_animations_completion(
            motion.duration,
            0.0,
            motion.options(),
            &block,
            None,
            mtm,
        )
    });
}

/// How far past the top a release must be to trigger a custom refresh.
const REFRESH_PULL: CGFloat = 64.0;
/// Space kept above the content while a custom refresh runs.
const REFRESH_INSET: CGFloat = 56.0;

fn place_spinner(spinner: &UIActivityIndicatorView, width: f32) {
    spinner.setCenter(CGPoint::new(width as CGFloat / 2.0, -REFRESH_INSET / 2.0));
}

struct Slot {
    native: Native,
    style: ViewStyle,
    decor: Decor,
    events: EventMask,
    gestures: Gestures,
    bindings: Vec<(AnimationProp, nsh_core::animation::NodeId)>,
    values: GestureValues,
    /// Values of the gesture nodes when the gesture began: pan x, pan y,
    /// pinch, rotation.
    gesture_start: [f32; 4],
    pan_scroll_handoff: bool,
    pan_scroll: Option<PanScroll>,
    /// `delayLongPress` (milliseconds).
    long_press_delay: Option<f32>,
    /// A horizontal list laid out right to left: mirrored as a whole.
    mirrored: bool,
    /// A cell of such a list: mirrored back.
    in_mirrored: bool,
    scroll_value: Option<nsh_core::animation::NodeId>,
    /// How a scroll view scrolls (scroll views only).
    behavior: Option<Box<nsh_core::ScrollBehavior>>,
    horizontal: bool,
    /// Image to show; loaded once the frame is known.
    image: Option<ImageSource>,
    /// The load in flight for this view.
    image_key: Option<String>,
    /// Placeholder, blur and fade of the image.
    image_options: nsh_core::ImageOptions,
    /// The placeholder's load in flight.
    placeholder_key: Option<String>,
    /// The image (not its placeholder) is shown.
    image_shown: bool,
    /// Interaction states the core wants reported (`tailwind::state`).
    tracked: u8,
    /// Current interaction states.
    states: u8,
}

impl Slot {
    /// The zoom view of a zoomable scroll view, which holds its children.
    fn zoom_view(&self) -> Option<Retained<UIView>> {
        match &self.native {
            Native::Scroll(scroll) if self.behavior.as_ref().is_some_and(|b| b.zooms()) => {
                crate::zoom::zoom_view(scroll)
            }
            _ => None,
        }
    }

    /// `centerContent`.
    fn centers(&self) -> bool {
        self.behavior.as_ref().is_some_and(|b| b.center_content)
    }

    fn new(native: Native) -> Self {
        Self {
            decor: match native {
                Native::Image(_) => Decor::for_image(),
                _ => Decor::default(),
            },
            native,
            style: ViewStyle::default(),
            events: EventMask::default(),
            gestures: Gestures::default(),
            bindings: Vec::new(),
            values: GestureValues::default(),
            gesture_start: [0.0; 4],
            pan_scroll_handoff: false,
            pan_scroll: None,
            long_press_delay: None,
            mirrored: false,
            in_mirrored: false,
            scroll_value: None,
            behavior: None,
            horizontal: false,
            image: None,
            image_key: None,
            image_options: nsh_core::ImageOptions::default(),
            placeholder_key: None,
            image_shown: false,
            tracked: 0,
            states: 0,
        }
    }
}

/// Applies mount batches to UIKit views. Main thread only.
pub(crate) struct Mounter {
    /// Indexed by node id (ids are dense).
    views: Vec<Option<Slot>>,
    /// Views with animated bindings, re-evaluated when values change.
    animated: Vec<NodeId>,
    /// Image views waiting for their frame before loading.
    pending_images: Vec<NodeId>,
    /// The display scale images were last requested at.
    image_scale: CGFloat,
    target: Retained<EventTarget>,
    animator: Animator,
    images: ImageLoader,
    /// What the app may reach (web view navigations check it).
    access: std::sync::Arc<nsh_engine::Access>,
    control: EngineControl,
    shared: SharedMounter,
    /// Mac Catalyst in the Mac idiom (no `UIRefreshControl`).
    mac_idiom: bool,
    /// The focused input.
    focused: Option<NodeId>,
    /// Height of the software keyboard over the surface.
    keyboard: f32,
    /// How the keyboard last moved (`LayoutCurve::Keyboard`).
    keyboard_motion: KeyboardMotion,
    /// The scroll view given a bottom inset to clear the keyboard.
    avoiding: Option<NodeId>,
    /// Animates the frames, insertions and removals of the current batch.
    layout_animation: Option<LayoutAnimation>,
    /// Views created by the current batch (they appear, not move).
    created: Vec<NodeId>,
    /// Views fading out before their removal.
    disappearing: rustc_hash::FxHashSet<NodeId>,
    /// One-shot display link for `requestAnimationFrame`.
    frame_link: Retained<objc2_quartz_core::CADisplayLink>,
    /// Parents of screens, header items and modals (which are not
    /// subviews of their parent).
    hosts: rustc_hash::FxHashMap<NodeId, NodeId>,
    /// Stacks whose screens changed in the current batch.
    dirty_stacks: Vec<NodeId>,
    /// Stacks whose screens changed during a push or pop transition: they
    /// catch up when it ends (UIKit breaks transitions that start while
    /// another one is running).
    deferred_stacks: Vec<NodeId>,
    /// Screens whose header changed in the current batch.
    dirty_headers: Vec<NodeId>,
    /// Modals to present or dismiss at the end of the current batch.
    dirty_modals: Vec<NodeId>,
    /// Where `asset:/` URIs of videos resolve.
    asset_base: Option<AssetBase>,
    /// Report touches to JS: on the root and on each modal's root.
    touch_trackers: Vec<(NodeId, Retained<crate::touch::TouchTracker>)>,
    /// Views listening to touches (the trackers run while there are any).
    touch_listeners: usize,
    /// Scroll views a JS responder keeps from scrolling.
    blocked_scrolls: Vec<Retained<UIScrollView>>,
    /// Vertical scroll views whose content size arrived in this batch, with
    /// the height that came with it. A batch applies a scroll view's content
    /// size before the frames of the children it measures (`ScrollContent` is
    /// queued when the scroll view is, its children after it), so a size that
    /// looks too wide is only judged after the whole batch is in place.
    content_sizes: Vec<(NodeId, CGFloat)>,
    /// The core's width and height for every vertical scroll view the platform
    /// narrowed, by id. The core does not resend a content size it did not
    /// change, so a later batch that widens what such a scroll view holds has
    /// to give that width back from here.
    narrowed: Vec<(NodeId, CGFloat, CGFloat)>,
    /// Whether this batch moved any frame: nothing under a narrowed scroll
    /// view can have grown otherwise, so the judgement is skipped.
    frames_applied: bool,
    /// The surface lays out right to left: native controls mirror.
    rtl: bool,
    /// Sticky cells of lists, by list.
    sticky: rustc_hash::FxHashMap<NodeId, Vec<StickyCell>>,
    /// The native components the app registered.
    components: crate::component::Components,
    /// Selection areas (`ViewProps::selection_area`) and their selections.
    areas: Vec<(NodeId, Retained<crate::selection_area::AreaResponder>)>,
    /// The performance monitor, while it measures ([`Mounter::measure`]).
    fps: Option<std::rc::Rc<crate::fps::Fps>>,
    mtm: MainThreadMarker,
}

impl Mounter {
    pub(crate) fn new(
        mtm: MainThreadMarker,
        root: Retained<UIView>,
        control: EngineControl,
        shared: SharedMounter,
        asset_base: Option<AssetBase>,
        access: std::sync::Arc<nsh_engine::Access>,
        components: crate::component::Components,
    ) -> Self {
        let target = EventTarget::new(mtm, control.clone(), shared.clone());
        let target_for_link = target.clone();
        let mut views = Vec::with_capacity(256);
        views.resize_with(2, || None);
        root.setTag(nsh_core::ROOT_ID as isize);
        views[nsh_core::ROOT_ID as usize] = Some(Slot::new(Native::Root(root)));
        Self {
            views,
            animated: Vec::new(),
            pending_images: Vec::new(),
            image_scale: 0.0,
            animator: Animator::new(&target),
            target,
            images: ImageLoader::new(
                asset_base.clone(),
                {
                    let shared = shared.clone();
                    std::sync::Arc::new(move |event| {
                        let mtm = MainThreadMarker::new().expect("main queue");
                        if let Some(m) = shared.get(mtm).borrow_mut().as_mut() {
                            m.load_event(event);
                        }
                    })
                },
                access.clone(),
            ),
            control,
            access,
            shared,
            mac_idiom: UIDevice::currentDevice(mtm).userInterfaceIdiom()
                == UIUserInterfaceIdiom::Mac,
            focused: None,
            keyboard: 0.0,
            keyboard_motion: KeyboardMotion {
                start: f64::NEG_INFINITY,
                ..KeyboardMotion::now(0.25)
            },
            avoiding: None,
            layout_animation: None,
            created: Vec::new(),
            disappearing: Default::default(),
            frame_link: crate::animation::frame_link(&target_for_link),
            hosts: Default::default(),
            dirty_stacks: Vec::new(),
            deferred_stacks: Vec::new(),
            dirty_headers: Vec::new(),
            dirty_modals: Vec::new(),
            asset_base: asset_base.clone(),
            sticky: Default::default(),
            touch_trackers: Vec::new(),
            touch_listeners: 0,
            blocked_scrolls: Vec::new(),
            content_sizes: Vec::new(),
            narrowed: Vec::new(),
            frames_applied: false,
            rtl: false,
            components,
            areas: Vec::new(),
            fps: None,
            mtm,
        }
    }

    /// Measures the surface's frames and commits with a performance
    /// monitor ([`crate::fps`]) from now on.
    pub(crate) fn measure(&mut self) {
        let fps = crate::fps::Fps::start(self.mtm);
        self.control.set_perf_monitor(Some(fps.monitor.clone()));
        self.fps = Some(fps);
    }

    pub(crate) fn apply(&mut self, batch: MountBatch) {
        let start = self.fps.is_some().then(Instant::now);
        self.apply_batch(batch);
        if let (Some(fps), Some(start)) = (&self.fps, start) {
            fps.drained(start.elapsed());
        }
    }

    fn apply_batch(&mut self, batch: MountBatch) {
        let mut animation_changed = false;
        for item in batch.items {
            animation_changed |= self.apply_item(item);
        }
        if let Some(animation) = self.layout_animation.take() {
            self.animate_appearing(&animation);
        }
        self.created.clear();
        self.finish_navigation();
        if animation_changed {
            self.apply_animations();
        }
        self.report_finished();
        self.start_image_loads();
        for (_, area) in &self.areas {
            area.batch_applied();
        }
        self.focused_caret_moved();
        self.settle_content_sizes();
    }

    /// Narrows the content size of a vertical scroll view to its width when
    /// nothing inside reaches past it — a stale extent left by an earlier
    /// layout makes the page pan sideways over nothing. Judged here, after
    /// the batch put every child's frame in place: a first mount sends the
    /// size before its children exist, and asking then would narrow a row
    /// that really is wider than the viewport.
    fn settle_content_sizes(&mut self) {
        let frames_applied = std::mem::take(&mut self.frames_applied);
        for (id, height) in std::mem::take(&mut self.content_sizes) {
            let mut narrowed = None;
            if let Some(Slot {
                native: Native::Scroll(scroll),
                ..
            }) = self.slot(id)
            {
                let viewport = scroll.bounds().size.width;
                let content = scroll.contentSize().width;
                // Content that fits cannot be narrowed; walking the subtree
                // to learn that would cost the page on every batch.
                if viewport > 0.0 && content > viewport {
                    let width = settled_content_width(
                        viewport,
                        content,
                        reaches_beyond(scroll, viewport + 0.5),
                    );
                    if width != content {
                        scroll.setContentSize(CGSize::new(width, height));
                        narrowed = Some((content, height));
                    }
                }
            }
            self.narrowed.retain(|&(n, ..)| n != id);
            if let Some((width, height)) = narrowed {
                self.narrowed.push((id, width, height));
            }
        }
        if frames_applied {
            self.rejudge_narrowed();
        }
    }

    /// Gives back the width the core sent once a later batch widens what a
    /// narrowed scroll view holds. The core does not resend a content size it
    /// did not change, so without this the tail stays out of reach — the bug
    /// this judgement fixes, in the other order.
    fn rejudge_narrowed(&mut self) {
        let mut i = 0;
        while i < self.narrowed.len() {
            let (id, core, height) = self.narrowed[i];
            let mut done = true;
            if let Some(slot) = self.slot(id)
                && let Native::Scroll(scroll) = &slot.native
                && still_judged(slot.horizontal, slot.zoom_view().is_some())
            {
                let viewport = scroll.bounds().size.width;
                let reaches = reaches_beyond(scroll, viewport + 0.5);
                let width = narrowed_width(viewport, core, reaches);
                if width != scroll.contentSize().width {
                    scroll.setContentSize(CGSize::new(width, height));
                }
                done = width == core;
            }
            if done {
                self.narrowed.swap_remove(i);
            } else {
                i += 1;
            }
        }
    }

    /// Reports the focused input's caret if the batch moved it (the input
    /// was laid out again: its text wraps elsewhere).
    fn focused_caret_moved(&self) {
        let Some(id) = self.focused else { return };
        let Some(Slot {
            native: Native::Input(input),
            events,
            ..
        }) = self.slot(id)
        else {
            return;
        };
        if !events.contains(EventKind::CaretMove) {
            return;
        }
        let view = input.editor_view();
        view.layoutIfNeeded();
        let Some(caret) = crate::input::caret(view) else {
            return;
        };
        if crate::input::caret_changed(view, caret) {
            self.input_event(id, EventKind::CaretMove, EventPayload::caret(caret));
        }
    }

    /// The surface's event target.
    pub(crate) fn target(&self) -> &Retained<EventTarget> {
        &self.target
    }

    /// Node `id`'s view (`nsh test --target ios`).
    #[cfg(feature = "dev")]
    pub(crate) fn ui_view(&self, id: NodeId) -> Option<Retained<UIView>> {
        Some(self.slot(id)?.native.view().retain())
    }

    /// Text view `id` (`None`: it is no text view).
    #[cfg(feature = "dev")]
    pub(crate) fn text_view(&self, id: NodeId) -> Option<Retained<TextView>> {
        match &self.slot(id)?.native {
            Native::Text(text) => Some(text.clone()),
            _ => None,
        }
    }

    /// The text input `id` holds (`None`: it is no input).
    #[cfg(feature = "dev")]
    pub(crate) fn input_text(&self, id: NodeId) -> Option<String> {
        match &self.slot(id)?.native {
            Native::Input(input) => Some(input.text()),
            _ => None,
        }
    }

    /// VoiceOver's escape gesture (or the test agent's `back`) reached the
    /// surface: while the app listens to going back (an overlay's
    /// `onCancel`, a back listener), the core hears it as the back button
    /// (the top overlay listening first). Whether it was taken.
    pub(crate) fn escape(&self) -> bool {
        if !self
            .slot(nsh_core::ROOT_ID)
            .is_some_and(|s| s.events.contains(EventKind::BackPress))
        {
            return false;
        }
        self.control
            .dispatch_event(nsh_core::ROOT_ID, EventKind::BackPress, EventPayload::None);
        true
    }

    /// Whether a native animation runs.
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.animator.animating()
    }

    #[inline]
    fn slot(&self, id: NodeId) -> Option<&Slot> {
        self.views.get(id as usize).and_then(Option::as_ref)
    }

    #[inline]
    fn slot_mut(&mut self, id: NodeId) -> Option<&mut Slot> {
        self.views.get_mut(id as usize).and_then(Option::as_mut)
    }

    /// Returns true if animation values or bindings changed.
    fn apply_item(&mut self, item: MountItem) -> bool {
        match item {
            MountItem::Create { id, kind } => {
                let native = match kind {
                    ViewKind::View => Native::View(NshView::new(self.mtm)),
                    ViewKind::Text => Native::Text(TextView::new(self.mtm)),
                    ViewKind::Image => Native::Image(NshView::new(self.mtm)),
                    ViewKind::Input => {
                        Native::Input(Box::new(Input::new(self.mtm, id, &self.target)))
                    }
                    ViewKind::Stack => {
                        Native::Stack(Box::new(StackHost::new(self.mtm, id, self.shared.clone())))
                    }
                    ViewKind::Screen => Native::Screen(Box::new(ScreenHost::new(
                        self.mtm,
                        id,
                        self.control.clone(),
                    ))),
                    ViewKind::Modal => Native::Modal(Box::new(ModalHost::new(
                        self.mtm,
                        id,
                        self.control.clone(),
                        self.target.clone(),
                    ))),
                    ViewKind::HeaderItem => Native::HeaderItem(NshView::new(self.mtm)),
                    ViewKind::InputAccessory => Native::InputAccessory(NshView::new(self.mtm)),
                    ViewKind::Canvas => Native::Canvas(crate::canvas::CanvasView::new(self.mtm)),
                    ViewKind::WebView => Native::Web(Box::new(WebHost::new(
                        self.mtm,
                        id,
                        self.control.clone(),
                        self.access.clone(),
                    ))),
                    ViewKind::Native => {
                        Native::Component(Box::new(crate::component::ComponentHost {
                            container: NshView::new(self.mtm),
                            component: None,
                        }))
                    }
                    ViewKind::Video => Native::Video(Box::new(VideoHost::new(
                        self.mtm,
                        id,
                        self.control.clone(),
                        self.asset_base.clone(),
                    ))),
                    ViewKind::Scroll => {
                        let scroll = UIScrollView::new(self.mtm);
                        // Layout already accounts for safe areas.
                        scroll.setContentInsetAdjustmentBehavior(
                            UIScrollViewContentInsetAdjustmentBehavior::Never,
                        );
                        scroll.setAlwaysBounceVertical(true);
                        // SAFETY: the delegate (target) lives as long as the
                        // mounter, which owns the scroll view.
                        unsafe {
                            scroll.setDelegate(Some(ProtocolObject::from_ref(&*self.target)))
                        };
                        // Taps that dismiss the keyboard
                        // (`keyboardShouldPersistTaps`).
                        let tap = crate::target::keyboard_tap_recognizer(self.mtm, &self.target);
                        scroll.addGestureRecognizer(&tap);
                        Native::Scroll(scroll)
                    }
                };
                native.view().setTag(id as isize);
                if self.rtl {
                    mirror_native(&native, true);
                }
                let idx = id as usize;
                if idx >= self.views.len() {
                    self.views
                        .resize_with((idx + 1).next_power_of_two(), || None);
                }
                let modal = matches!(native, Native::Modal(_));
                self.views[idx] = Some(Slot::new(native));
                if modal && self.touch_listeners > 0 {
                    self.add_touch_tracker(id);
                }
                if self.layout_animation.is_some() {
                    self.created.push(id);
                }
            }
            MountItem::Insert {
                parent,
                child,
                before,
            } => self.insert(parent, child, before),
            MountItem::ProjectRoot {
                parent,
                id,
                following,
            } => {
                let before = following
                    .into_iter()
                    .find(|&anchor| self.root_anchor(parent, id, anchor));
                self.insert(parent, id, before);
            }
            MountItem::RetireListCell { id, request, roots } => {
                // Earlier items can synchronously enqueue native callbacks
                // while mount holds its borrow. They belong before the ACK.
                let target = self.target.clone();
                target.drain_deferred(self);
                let path = self.retirement_focus_path(&roots);
                let retired = !roots.iter().any(|root| path.contains(root));
                if retired {
                    let mut stacks: Vec<_> = roots
                        .iter()
                        .filter_map(|root| {
                            matches!(
                                self.slot(*root).map(|slot| &slot.native),
                                Some(Native::Screen(_))
                            )
                            .then(|| self.hosts.get(root).copied())
                            .flatten()
                        })
                        .collect();
                    stacks.sort_unstable();
                    stacks.dedup();
                    for stack in stacks {
                        if matches!(self.slot(stack).map(|slot| &slot.native),
                            Some(Native::Stack(host)) if host.nav.transitionCoordinator().is_none())
                        {
                            self.report_popped(stack);
                        }
                    }
                    // Core supplies the entire logical group's native roots.
                    // Complete the focus check before changing any member.
                    for root in &roots {
                        if let Some(view) = self.slot(*root).map(|s| s.native.view().retain()) {
                            self.retire_input(&view);
                        }
                    }
                    let target = self.target.clone();
                    target.without_callbacks(|| {
                        for root in roots {
                            self.park_retired_root(root);
                        }
                    });
                }
                self.control.set_focus_path(path);
                self.control.retire_list_cell(id, request, retired);
            }
            MountItem::ListCellRetired { roots } => {
                // Core accepted the ACK: cancellation of this assignment is
                // no longer possible. SDK GC acts only on the old instance.
                let target = self.target.clone();
                target.without_callbacks(|| {
                    for root in roots {
                        if let Some(Slot {
                            native: Native::Modal(modal),
                            ..
                        }) = self.slot_mut(root)
                        {
                            **modal = modal.confirmed_retirement();
                        }
                    }
                });
            }
            MountItem::Remove { id } => {
                if self.remove_hosted(id) {
                    return false;
                }
                if let Some(s) = self.slot(id) {
                    match self.layout_animation.and_then(|a| a.delete) {
                        Some(t) => {
                            disappear(s.native.view(), id, &t, self.shared.clone(), self.mtm);
                            self.disappearing.insert(id);
                        }
                        None => s.native.view().removeFromSuperview(),
                    }
                }
            }
            MountItem::Delete { id } => {
                self.remove_hosted(id);
                self.sticky.remove(&id);
                // A removal animation it was running ends with it: its end
                // must not find the id, which a new view may take.
                self.disappearing.remove(&id);
                self.target.scroll_deleted(id);
                if let Some(i) = self.areas.iter().position(|(a, _)| *a == id) {
                    self.areas.remove(i).1.detach();
                }
                if let Some(mut s) = self.views.get_mut(id as usize).and_then(Option::take) {
                    // A modal deleted while presented (its subtree released
                    // without a remove) goes away too, as on Android.
                    if let Native::Modal(modal) = &mut s.native {
                        modal.dismiss(|| {});
                    }
                    if s.events.contains(EventKind::Touch) {
                        self.touch_listener_changed(false);
                    }
                    self.touch_trackers.retain(|(root, _)| *root != id);
                    s.native.view().removeFromSuperview();
                    for key in [&s.image_key, &s.placeholder_key].into_iter().flatten() {
                        self.images.cancel(id, key);
                    }
                    self.animated.retain(|&v| v != id);
                }
            }
            MountItem::Frame { id, frame } => {
                self.frames_applied = true;
                if let Some(Slot {
                    native: Native::HeaderItem(view),
                    ..
                }) = self.slot(id)
                {
                    // The header bar positions it; only its size is ours.
                    let origin = view.frame().origin;
                    view.setFrame(CGRect::new(
                        origin,
                        CGSize::new(
                            frame.size.width.0 as CGFloat,
                            frame.size.height.0 as CGFloat,
                        ),
                    ));
                    return false;
                }
                if let Some(Slot {
                    native: Native::InputAccessory(view),
                    ..
                }) = self.slot(id)
                {
                    // The keyboard places it and sets its width.
                    let old = view.frame();
                    let height = frame.size.height.0 as CGFloat;
                    view.setFrame(CGRect::new(
                        old.origin,
                        CGSize::new(old.size.width.max(frame.size.width.0 as CGFloat), height),
                    ));
                    if old.size.height != height && self.hosts.contains_key(&id) {
                        let view = Retained::into_super(view.clone());
                        for slot in self.views.iter().flatten() {
                            if let Native::Input(input) = &slot.native
                                && input.accessory() == Some(id)
                            {
                                input.set_accessory(Some(&view), true);
                            }
                        }
                    }
                    return false;
                }
                if let Some(s) = self.slot(id) {
                    let view = s.native.view();
                    let update = self.layout_animation.and_then(|a| a.update);
                    match update {
                        // Views that already had a frame move; new ones appear.
                        Some(t)
                            if !self.created.contains(&id)
                                && view.bounds().size != CGSize::ZERO =>
                        {
                            let target = view.retain();
                            animate(&t, self.keyboard_motion, view, self.mtm, move || {
                                set_frame(&target, frame)
                            });
                        }
                        _ => set_frame(view, frame),
                    }
                    if let Some(Refresh::Custom { spinner, .. }) = &s.gestures.refresh {
                        place_spinner(spinner, frame.size.width.0);
                    }
                    if let Native::Video(video) = &s.native {
                        video.layout();
                    }
                    if s.decor.sized() {
                        self.decorate(id);
                    }
                }
                // A bounce jumps by a quarter of the height.
                if let Some(s) = self.slot(id)
                    && let Some(a) = s
                        .style
                        .animation
                        .filter(|a| a.keyframes == nsh_core::Keyframes::Bounce)
                {
                    crate::interaction::keyframes(
                        &s.native.view().layer(),
                        Some(&a),
                        frame.size.height.0 as f64,
                    );
                }
                // The origin of the transform depends on the size.
                if let Some(s) = self.slot(id)
                    && s.style.transform_origin != nsh_core::TransformOrigin::CENTER
                {
                    s.native
                        .view()
                        .layer()
                        .setTransform(dynamic_transform(s, &self.animator));
                }
            }
            MountItem::TrackStates { id, states } => self.track_states(id, states),
            MountItem::Overflow { id, extent } => {
                if let Some(view) = self.slot(id).and_then(|s| s.native.nsh()) {
                    view.set_overflow(extent.map(|e| {
                        CGRect::new(
                            CGPoint::new(e.origin.x.0 as CGFloat, e.origin.y.0 as CGFloat),
                            CGSize::new(e.size.width.0 as CGFloat, e.size.height.0 as CGFloat),
                        )
                    }));
                }
            }
            MountItem::ViewStyle { id, style } => self.set_view_style(id, *style),
            MountItem::Text {
                id,
                text,
                layout,
                content,
            } => {
                if let Some(Slot {
                    native: Native::Text(view),
                    events,
                    ..
                }) = self.slot(id)
                {
                    let links = !text.links.is_empty() || view.has_links();
                    let events = *events;
                    view.set_layout(text, layout, content);
                    // Pressable spans need the block's press recognizer.
                    if links {
                        self.set_events(id, events);
                    }
                }
            }
            MountItem::Events { id, events } => self.set_events(id, events),
            MountItem::Appearance { appearance } => {
                if let Some(root) = self.slot(nsh_core::ROOT_ID) {
                    crate::system::set_appearance(appearance, root.native.view());
                }
            }
            MountItem::LayoutDirection { rtl } => {
                self.rtl = rtl;
                for s in self.views.iter().flatten() {
                    mirror_native(&s.native, rtl);
                }
            }
            MountItem::Image {
                id,
                source,
                resize_mode,
                options,
            } => self.set_image(id, source, resize_mode, options),
            MountItem::ScrollConfig {
                id,
                horizontal,
                scrollbar_visible,
                scroll_value,
                keyboard_dismiss,
                mirrored,
            } => {
                // A node that stops being vertical drops the width narrowed
                // while it was: the extent it holds is measured the other way.
                let vertical = self
                    .slot(id)
                    .is_some_and(|s| still_judged(horizontal, s.zoom_view().is_some()));
                if !vertical {
                    self.narrowed.retain(|&(n, ..)| n != id);
                }
                if let Some(s) = self.slot_mut(id)
                    && s.mirrored != mirrored
                {
                    s.mirrored = mirrored;
                    let cells: Vec<NodeId> = s
                        .native
                        .view()
                        .subviews()
                        .iter()
                        .map(|v| v.tag() as NodeId)
                        .collect();
                    if let Some(s) = self.slot(id) {
                        apply_dynamic(s, &self.animator);
                    }
                    for cell in cells {
                        self.set_in_mirrored(cell, mirrored);
                    }
                }
                if let Some(s) = self.slot_mut(id)
                    && let Native::Scroll(scroll) = &s.native
                {
                    scroll.setKeyboardDismissMode(match keyboard_dismiss {
                        KeyboardDismissMode::None => UIScrollViewKeyboardDismissMode::None,
                        KeyboardDismissMode::OnDrag => UIScrollViewKeyboardDismissMode::OnDrag,
                        KeyboardDismissMode::Interactive => {
                            UIScrollViewKeyboardDismissMode::Interactive
                        }
                    });
                    let bounces = s.behavior.as_ref().is_none_or(|b| b.bounces);
                    scroll.setAlwaysBounceVertical(bounces && !horizontal);
                    scroll.setAlwaysBounceHorizontal(bounces && horizontal);
                    scroll.setShowsVerticalScrollIndicator(scrollbar_visible && !horizontal);
                    scroll.setShowsHorizontalScrollIndicator(scrollbar_visible && horizontal);
                    s.horizontal = horizontal;
                    s.scroll_value = scroll_value;
                }
            }
            MountItem::ScrollContent { id, size } => {
                if let Some(
                    s @ Slot {
                        native: Native::Scroll(scroll),
                        ..
                    },
                ) = self.slot(id)
                {
                    let size = CGSize::new(size.width.0 as CGFloat, size.height.0 as CGFloat);
                    let vertical = still_judged(s.horizontal, s.zoom_view().is_some());
                    match s.zoom_view() {
                        Some(zoom) => crate::zoom::layout(scroll, &zoom, size, s.centers()),
                        None => scroll.setContentSize(size),
                    }
                    if vertical {
                        self.content_sizes.push((id, size.height));
                    }
                }
            }
            MountItem::ScrollBy { id, dx, dy } => {
                if let Some(Slot {
                    native: Native::Scroll(scroll),
                    ..
                }) = self.slot(id)
                {
                    self.target.scroll_applied(id);
                    let o = scroll.contentOffset();
                    scroll.setContentOffset(CGPoint::new(
                        o.x + dx.0 as CGFloat,
                        o.y + dy.0 as CGFloat,
                    ));
                }
            }
            MountItem::StickyCells { id, cells } => {
                let identity = CATransform3D::new_translation(0.0, 0.0, 0.0);
                for old in self.sticky.remove(&id).unwrap_or_default() {
                    if !cells.iter().any(|c| c.cell == old.cell)
                        && let Some(s) = self.slot(old.cell)
                    {
                        s.native.view().layer().setTransform(identity);
                    }
                }
                if !cells.is_empty() {
                    self.sticky.insert(id, cells);
                    self.front_sticky(id);
                    self.pin_sticky(id);
                }
            }
            MountItem::ScrollBehavior { id, behavior } => {
                let mtm = self.mtm;
                if let Some(s) = self.slot_mut(id)
                    && let Native::Scroll(scroll) = &s.native
                {
                    let b = &behavior;
                    // Native paging pages by the viewport; other snapping is
                    // done when a drag ends (`snap_target`).
                    scroll.setPagingEnabled(b.paging && !b.snaps());
                    let rate = if b.deceleration > 0.0 {
                        b.deceleration
                    } else if b.snaps() {
                        0.99
                    } else {
                        0.998
                    };
                    scroll.setDecelerationRate(rate as CGFloat);
                    scroll.setScrollEnabled(b.enabled);
                    scroll.setBounces(b.bounces);
                    scroll.setAlwaysBounceVertical(b.bounces && !s.horizontal);
                    scroll.setAlwaysBounceHorizontal(b.bounces && s.horizontal);
                    // The keyboard and refreshing add to the content inset.
                    let old = ui_insets(
                        s.behavior
                            .as_ref()
                            .map(|b| b.content_inset)
                            .unwrap_or_default(),
                    );
                    let new = ui_insets(b.content_inset);
                    let mut inset = scroll.contentInset();
                    inset.top += new.top - old.top;
                    inset.left += new.left - old.left;
                    inset.bottom += new.bottom - old.bottom;
                    inset.right += new.right - old.right;
                    scroll.setContentInset(inset);
                    // Zooming (UIKit asks the delegate for the zoom view).
                    scroll.setMinimumZoomScale(b.min_zoom as CGFloat);
                    scroll.setMaximumZoomScale(b.max_zoom.max(b.min_zoom) as CGFloat);
                    scroll.setBouncesZoom(b.bounces_zoom);
                    let zoom = crate::zoom::set_zoomable(scroll, b.zooms(), mtm);
                    if let Some(pinch) = scroll.pinchGestureRecognizer() {
                        pinch.setEnabled(b.pinch);
                    }
                    let center = b.center_content;
                    s.behavior = Some(behavior);
                    if let Some(zoom) = zoom {
                        crate::zoom::layout(scroll, &zoom, zoom.bounds().size, center);
                    }
                }
            }
            MountItem::Refreshing { id, refreshing } => self.set_refreshing(id, refreshing),
            MountItem::Canvas { id, drawing } => self.set_drawing(id, drawing),
            MountItem::AnimationBindings { id, bindings } => {
                if let Some(s) = self.slot_mut(id) {
                    // Properties no longer animated fall back to the static style.
                    s.bindings = bindings;
                    let bound = !s.bindings.is_empty();
                    self.animated.retain(|&v| v != id);
                    // An animated background changes how the shadow is drawn.
                    self.decorate(id);
                    if bound {
                        self.animated.push(id);
                    }
                    // Bound values apply now too (a canvas reads them when
                    // it draws next).
                    if let Some(s) = self.slot(id) {
                        apply_dynamic(s, &self.animator);
                    }
                    return true;
                }
            }
            MountItem::Gestures { id, values } => {
                if let Some(s) = self.slot_mut(id) {
                    s.values = values;
                    let events = s.events;
                    self.set_events(id, events);
                }
            }
            MountItem::ViewProps { id, props } => self.set_view_props(id, *props),
            MountItem::AccessibilityLabel { id, label } => self.set_accessibility_label(id, label),
            MountItem::LayoutAnimation(animation) => self.layout_animation = Some(animation),
            MountItem::ScreenConfig { id, config } => {
                if let Some(Slot {
                    native: Native::Screen(screen),
                    ..
                }) = self.slot_mut(id)
                {
                    screen.config = *config;
                    self.dirty_headers.push(id);
                    if let Some(&stack) = self.hosts.get(&id) {
                        self.dirty_stacks.push(stack);
                    }
                }
            }
            MountItem::NativeProps { id, props } => self.set_native_props(id, props),
            MountItem::ModalConfig { id, config } => {
                if let Some(Slot {
                    native: Native::Modal(modal),
                    ..
                }) = self.slot_mut(id)
                {
                    modal.configure(config);
                }
            }
            MountItem::Animation(op) => {
                self.animator.apply(op);
                return true;
            }
            MountItem::Input { id, config } => {
                let (target, mtm) = (self.target.clone(), self.mtm);
                let accessory = config
                    .accessory
                    .filter(|a| self.hosts.contains_key(a))
                    .and_then(|a| match self.slot(a) {
                        Some(Slot {
                            native: Native::InputAccessory(v),
                            ..
                        }) => Some(Retained::into_super(v.clone())),
                        _ => None,
                    });
                if let Some(Slot {
                    native: Native::Input(input),
                    ..
                }) = self.slot_mut(id)
                {
                    input.configure(*config, &target, mtm);
                    input.set_accessory(accessory.as_deref(), false);
                }
            }
            MountItem::InputValue { id, text, count } => {
                if let Some(Slot {
                    native: Native::Input(input),
                    ..
                }) = self.slot_mut(id)
                {
                    input.set_value(&text, count);
                }
            }
            MountItem::InputContent { id, content } => {
                if let Some(Slot {
                    native: Native::Input(input),
                    ..
                }) = self.slot_mut(id)
                {
                    input.set_content(content);
                }
            }
            MountItem::Component { id, name } => {
                let made = self.components.make(&name, id, &self.control);
                if let (
                    Some(component),
                    Some(Slot {
                        native: Native::Component(host),
                        ..
                    }),
                ) = (made, self.slot_mut(id))
                {
                    host.attach(component);
                }
            }
            MountItem::ComponentProps { id, props } => {
                if let Some(Slot {
                    native: Native::Component(host),
                    ..
                }) = self.slot_mut(id)
                    && let Some(component) = host.component.as_mut()
                {
                    for (name, value) in &props {
                        component.set_prop(name, value.as_ref());
                    }
                }
            }
            MountItem::Command { id, command } => self.command(id, command),
            // Hardware keyboards' shortcuts are not matched yet.
            MountItem::Keymap(keymap) => self.target.keymap().set(keymap),
        }
        false
    }

    fn root_anchor(&self, parent: NodeId, child: NodeId, anchor: NodeId) -> bool {
        let (Some(child), Some(candidate)) = (self.slot(child), self.slot(anchor)) else {
            return false;
        };
        let hosted = match (&child.native, &candidate.native) {
            (Native::Screen(_), Native::Screen(_))
            | (Native::HeaderItem(_), Native::HeaderItem(_))
            | (Native::Modal(_), Native::Modal(_))
            | (Native::InputAccessory(_), Native::InputAccessory(_)) => true,
            (
                Native::Screen(_)
                | Native::HeaderItem(_)
                | Native::Modal(_)
                | Native::InputAccessory(_),
                _,
            ) => return false,
            _ => false,
        };
        if hosted {
            return self.hosts.get(&anchor) == Some(&parent);
        }
        let Some(parent) = self.slot(parent) else {
            return false;
        };
        let zoom = parent.zoom_view();
        let parent = zoom
            .as_deref()
            .unwrap_or(parent.decor.container(parent.native.view()));
        candidate
            .native
            .view()
            .superview()
            .is_some_and(|native| std::ptr::eq::<UIView>(&*native, parent))
    }

    fn insert(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        if self.insert_hosted(parent, child, before) {
            return;
        }
        if self.disappearing.remove(&child)
            && let Some(c) = self.slot(child)
        {
            // Back before its removal finished animating.
            c.native.view().layer().removeAllAnimations();
            apply_dynamic(c, &self.animator);
        }
        if let (Some(p), Some(c)) = (self.slot(parent), self.slot(child)) {
            let zoom = p.zoom_view();
            let p = zoom
                .as_deref()
                .unwrap_or(p.decor.container(p.native.view()));
            let c = c.native.view();
            match before.and_then(|b| self.slot(b)) {
                Some(b) => p.insertSubview_belowSubview(c, b.native.view()),
                None => p.addSubview(c),
            }
        }
        let mirrored = self.slot(parent).is_some_and(|p| p.mirrored);
        self.set_in_mirrored(child, mirrored);
        if self.sticky.contains_key(&parent) {
            self.front_sticky(parent);
        }
    }

    fn command(&mut self, id: NodeId, command: Command) {
        if let Command::Native { name, args } = &command {
            if let Some(Slot {
                native: Native::Component(host),
                ..
            }) = self.slot_mut(id)
                && let Some(component) = host.component.as_mut()
            {
                component.command(name, args);
            }
            return;
        }
        let Some(s) = self.slot(id) else { return };
        match (command, &s.native) {
            (
                c @ (Command::Reload
                | Command::GoBack
                | Command::GoForward
                | Command::StopLoading
                | Command::InjectJavaScript(_)
                | Command::PostMessage(_)),
                Native::Web(web),
            ) => web.command(&c),
            (Command::Seek(seconds), Native::Video(video)) => video.seek(seconds),
            (Command::Focus, Native::Input(input)) => {
                input.editor_view().becomeFirstResponder();
            }
            (Command::Blur, Native::Input(input)) => {
                input.editor_view().resignFirstResponder();
            }
            // On the root: whatever is focused.
            (Command::Blur, native) if id == nsh_core::ROOT_ID => {
                native.view().endEditing(true);
            }
            (Command::ScrollTo { x, y, animated }, Native::Scroll(scroll)) => {
                let inset = scroll.adjustedContentInset();
                let size = scroll.contentSize();
                let bounds = scroll.bounds().size;
                let max_x = (size.width + inset.right - bounds.width).max(-inset.left);
                let max_y = (size.height + inset.bottom - bounds.height).max(-inset.top);
                let offset = CGPoint::new(
                    (x.0 as CGFloat).clamp(-inset.left, max_x),
                    (y.0 as CGFloat).clamp(-inset.top, max_y),
                );
                self.target.scroll_applied(id);
                scroll.setContentOffset_animated(offset, animated);
            }
            (
                Command::ZoomTo {
                    scale,
                    center,
                    animated,
                },
                Native::Scroll(scroll),
            ) => {
                if crate::zoom::zoom_view(scroll).is_some() {
                    let center = center.map(|c| (c.x.0, c.y.0));
                    crate::zoom::zoom_to(scroll, scale, center, animated);
                }
            }
            (Command::StatusBar(config), native) if id == nsh_core::ROOT_ID => {
                crate::system::set_status_bar(config, native.view());
            }
            (Command::Dialog(dialog), native) if id == nsh_core::ROOT_ID => {
                crate::system::show_dialog(&dialog, native.view(), &self.control);
            }
            (
                Command::PickImages {
                    id: request,
                    request: asked,
                },
                native,
            ) if id == nsh_core::ROOT_ID => {
                crate::picker::pick_images(request, asked, native.view(), &self.control);
            }
            (Command::SetJsResponder { block }, _) => self.set_js_responder(id, block),
            (Command::SetSelection { start, end }, Native::Input(input)) => {
                input.select(start, end)
            }
            (Command::ClearJsResponder, _) => self.clear_js_responder(),
            // Toasts are Android only.
            (Command::Toast { .. }, _) => {}
            (Command::Announce(text), _) => crate::system::announce(&text),
            (Command::ImageInfo { id, uri }, _) => self.images.info(id, &uri),
            (Command::SetClipboard(text), _) => crate::system::set_clipboard(&text),
            (Command::OpenUrl { id, url }, _) => crate::system::open_url(id, &url, &self.control),
            (Command::ReadClipboard { id, has_only }, _) => {
                let (has, text) = crate::system::read_clipboard(has_only);
                let mut fields = vec![
                    ("id", PayloadValue::Number(id as f64)),
                    ("has", PayloadValue::Bool(has)),
                ];
                if let Some(text) = text {
                    fields.push(("text", PayloadValue::Str(text)));
                }
                self.control.dispatch_event(
                    nsh_core::ROOT_ID,
                    EventKind::Clipboard,
                    EventPayload::Map(fields),
                );
            }
            (Command::SetClipboardImage(uri), _) => crate::system::set_clipboard_image(&uri),
            (Command::ReadClipboardImage { id, has_only }, _) => self.control.dispatch_event(
                nsh_core::ROOT_ID,
                EventKind::Clipboard,
                crate::system::read_clipboard_image(id, has_only),
            ),
            (Command::ReadClipboardFiles { id }, _) => self.control.dispatch_event(
                nsh_core::ROOT_ID,
                EventKind::Clipboard,
                crate::system::read_clipboard_files(id),
            ),
            (Command::AccessibilityFocus, native) => {
                crate::system::accessibility_focus(native.view())
            }
            (command, _) => log::warn!("{command:?} does not apply to view {id}"),
        }
    }

    /// Publishes UIKit's current focus without introducing a second focus
    /// owner. This is also called on hardware focus-system notifications.
    pub(crate) fn publish_focus_path(&self) {
        self.control.set_focus_path(self.focus_path());
    }

    fn focus_path(&self) -> Vec<NodeId> {
        let path = self.hardware_focus_path();
        if !path.is_empty() {
            return path;
        }
        // UIKit's keyboard editor can be first responder independently of
        // the hardware-keyboard focus system. Validate the existing input
        // callback's owner against the actual editor before using it.
        if let Some(Slot {
            native: Native::Input(input),
            ..
        }) = self.focused.and_then(|id| self.slot(id))
            && input.editor_view().isFirstResponder()
        {
            return self.path_from_native(input.editor_view());
        }
        Vec::new()
    }

    fn hardware_focus_path(&self) -> Vec<NodeId> {
        let Some(root) = self.slot(nsh_core::ROOT_ID) else {
            return Vec::new();
        };
        let Some(system) =
            UIFocusSystem::focusSystemForEnvironment(ProtocolObject::from_ref(root.native.view()))
        else {
            return Vec::new();
        };
        let Some(item) = system.focusedItem() else {
            return Vec::new();
        };
        let object: &AnyObject = AsRef::<AnyObject>::as_ref(&*item);
        if let Some(view) = object.downcast_ref::<UIView>() {
            let path = self.path_from_native(view);
            if !path.is_empty() {
                return path;
            }
        }
        // A custom focus item need not itself be a UIView.
        let mut parent = item.parentFocusEnvironment();
        while let Some(environment) = parent {
            let object: &AnyObject = AsRef::<AnyObject>::as_ref(&*environment);
            if let Some(controller) = object.downcast_ref::<crate::navigation::ModalController>()
                && let Some(Slot {
                    native: Native::Modal(modal),
                    ..
                }) = self.slot(controller.modal_id())
                && std::ptr::eq(&*modal.controller, controller)
            {
                // UIKit sheet controls can live outside NSH's content view.
                return self.path_from_native(&modal.view);
            }
            if let Some(view) = object.downcast_ref::<UIView>() {
                let path = self.path_from_native(view);
                if !path.is_empty() {
                    return path;
                }
            }
            parent = environment.parentFocusEnvironment();
        }
        Vec::new()
    }

    fn path_from_native(&self, view: &UIView) -> Vec<NodeId> {
        let mut path = Vec::new();
        let focused = view;
        let mut current = Some(view.retain());
        while let Some(view) = current {
            let id = view.tag() as NodeId;
            let slot = self
                .slot(id)
                .filter(|slot| std::ptr::eq::<UIView>(slot.native.view(), &*view));
            if let Some(slot) = slot {
                if let Native::Stack(stack) = &slot.native
                    && focused.isDescendantOfView(&stack.nav.navigationBar())
                    && let Some(screen) = stack.nav.topViewController().and_then(|controller| {
                        controller
                            .downcast::<crate::navigation::ScreenController>()
                            .ok()
                    })
                {
                    // UIKit's own back button is a sibling of Screen.view,
                    // but dispatches to the currently shown native screen.
                    let screen = screen.screen_id();
                    if !path.contains(&screen) {
                        path.push(screen);
                    }
                }
                path.push(id);
                if id == nsh_core::ROOT_ID {
                    return path;
                }
            }
            current = slot
                .and_then(|_| self.hosts.get(&id))
                .and_then(|&parent| self.slot(parent))
                .map(|parent| parent.native.view().retain())
                .or_else(|| view.superview());
        }
        // Focus belongs to another surface in the same window.
        Vec::new()
    }

    fn retirement_focus_path(&self, roots: &[NodeId]) -> Vec<NodeId> {
        let path = self.focus_path();
        if roots.iter().any(|root| path.contains(root)) {
            return path;
        }
        // Hosted web/native components can own a first responder without
        // an Input delegate callback. Check only the retiring cell's live
        // UIKit subtree; ordinary input events never scan the scene.
        let mut pending: Vec<_> = roots
            .iter()
            .filter_map(|&root| self.slot(root).map(|slot| slot.native.view().retain()))
            .collect();
        while let Some(view) = pending.pop() {
            if view.isFirstResponder() || view.isFocused() {
                return self.path_from_native(&view);
            }
            pending.extend(view.subviews());
        }
        path
    }

    fn retire_input(&mut self, cell: &UIView) {
        for (_, tracker) in &self.touch_trackers {
            tracker.cancel_in(cell);
        }
        let active = |state| {
            matches!(
                state,
                UIGestureRecognizerState::Began | UIGestureRecognizerState::Changed
            )
        };
        let mut pending = vec![cell.retain()];
        let mut recognizers = Vec::new();
        let mut scrolls = Vec::new();
        while let Some(view) = pending.pop() {
            let id = view.tag() as NodeId;
            let owned = self
                .slot(id)
                .is_some_and(|slot| std::ptr::eq::<UIView>(slot.native.view(), &*view));
            if owned
                && let Some(Refresh::Custom { reveal_pending, .. }) = self
                    .slot(id)
                    .and_then(|slot| slot.gestures.refresh.as_ref())
            {
                reveal_pending.set(false);
            }
            if let Some(gestures) = view.gestureRecognizers() {
                for gesture in gestures {
                    if let Some(press) = gesture.downcast_ref::<PressRecognizer>() {
                        if let Some(link) = press.retire() {
                            if let Some(link) = link {
                                if link.events.contains(EventKind::PressUp) {
                                    self.control.dispatch_event(
                                        link.node,
                                        EventKind::PressUp,
                                        EventPayload::None,
                                    );
                                }
                            } else if owned {
                                self.press_changed(id, false);
                            }
                        }
                    } else if owned && active(gesture.state()) {
                        if let Some(pan) = gesture.downcast_ref::<UIPanGestureRecognizer>()
                            && self
                                .slot(id)
                                .and_then(|slot| slot.gestures.pan.as_deref())
                                .is_some_and(|current| std::ptr::eq(current, pan))
                        {
                            let parent = view.superview();
                            self.pan(
                                id,
                                UIGestureRecognizerState::Cancelled,
                                pan.translationInView(parent.as_deref()),
                                pan.velocityInView(parent.as_deref()),
                            );
                        } else if let Some(pinch) =
                            gesture.downcast_ref::<UIPinchGestureRecognizer>()
                        {
                            self.transform_gesture(
                                id,
                                false,
                                UIGestureRecognizerState::Cancelled,
                                pinch.scale(),
                                pinch.velocity(),
                            );
                        } else if let Some(rotation) =
                            gesture.downcast_ref::<UIRotationGestureRecognizer>()
                        {
                            self.transform_gesture(
                                id,
                                true,
                                UIGestureRecognizerState::Cancelled,
                                rotation.rotation(),
                                rotation.velocity(),
                            );
                        } else if gesture
                            .downcast_ref::<objc2_ui_kit::UIHoverGestureRecognizer>()
                            .is_some()
                        {
                            self.hover(id, UIGestureRecognizerState::Cancelled, CGPoint::ZERO, 0);
                        }
                    }
                    if gesture.isEnabled() {
                        recognizers.push(gesture);
                    }
                }
            }
            if let Some(scroll) = view.downcast_ref::<UIScrollView>() {
                scrolls.push(scroll.retain());
            }
            pending.extend(view.subviews());
        }
        // The final events above precede ACK on the original control. UIKit
        // cancellation callbacks below cannot enqueue work behind that ACK.
        self.target.without_callbacks(|| {
            for gesture in recognizers {
                gesture.setEnabled(false);
                gesture.setEnabled(true);
            }
            for scroll in scrolls {
                let enabled = scroll.isScrollEnabled();
                scroll.setScrollEnabled(false);
                scroll.setContentOffset_animated(scroll.contentOffset(), false);
                scroll.setScrollEnabled(enabled);
            }
            cell.removeFromSuperview();
        });
    }

    /// An input event, if the input listens to it.
    pub(crate) fn input_event(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        if self.slot(id).is_some_and(|s| s.events.contains(kind)) {
            self.control.dispatch_event(id, kind, payload);
        }
    }

    /// The user edited an input. Always reported: the engine keeps the text
    /// for layout and stale-value checks even without a JS listener.
    pub(crate) fn input_changed(&mut self, id: NodeId, text: String) {
        let Some(Slot {
            native: Native::Input(input),
            ..
        }) = self.slot_mut(id)
        else {
            return;
        };
        input.count += 1;
        input.known.clone_from(&text);
        input.update_placeholder();
        let count = input.count;
        self.control.dispatch_event(
            id,
            EventKind::ChangeText,
            EventPayload::Text { text, count },
        );
    }

    /// The user edited input `id` to `text`, with the marked text `marked`
    /// (`None`: no composition). A composition that starts or changes is
    /// reported before the `onChangeText` of the text holding it, and one
    /// that ends after the `onChangeText` of the text it committed, as
    /// browsers order them.
    pub(crate) fn input_edited(&mut self, id: NodeId, text: String, marked: Option<String>) {
        if marked.is_some() {
            if let Some(Slot {
                native: Native::Input(input),
                ..
            }) = self.slot_mut(id)
                && let Some(change) = input.compose(marked)
            {
                self.composition_changed(id, change);
            }
            self.input_changed(id, text);
        } else {
            self.input_changed(id, text.clone());
            self.input_composition(id, text, marked);
        }
    }

    /// A UIKit callback of input `id` saw `text` with the marked text
    /// `marked` (`None`: no composition). Ignored while `text` is an edit
    /// not reported yet: the callback reporting it follows, so a commit's
    /// `onChangeText` comes before the composition's end.
    pub(crate) fn input_composition(&mut self, id: NodeId, text: String, marked: Option<String>) {
        let Some(Slot {
            native: Native::Input(input),
            ..
        }) = self.slot_mut(id)
        else {
            return;
        };
        if text != input.known {
            return;
        }
        if let Some(change) = input.compose(marked) {
            self.composition_changed(id, change);
        }
    }

    /// `onCompositionChange` of input `id`, if it listens.
    fn composition_changed(&self, id: NodeId, (composing, text): (bool, String)) {
        self.input_event(
            id,
            EventKind::CompositionChange,
            EventPayload::Map(vec![
                ("composing", nsh_core::PayloadValue::Bool(composing)),
                ("text", nsh_core::PayloadValue::Str(text)),
            ]),
        );
    }

    pub(crate) fn input_focused(&mut self, id: NodeId, focused: bool) {
        // Leaving an input ends its composition.
        if !focused
            && let Some(Slot {
                native: Native::Input(input),
                ..
            }) = self.slot_mut(id)
            && let Some(change) = input.compose(None)
        {
            self.composition_changed(id, change);
        }
        self.report_state(id, nsh_core::tailwind::state::FOCUSED, focused);
        let Some(s) = self.slot(id) else { return };
        let event = if focused {
            EventKind::Focus
        } else {
            EventKind::Blur
        };
        if s.events.contains(event) {
            self.control.dispatch_event(id, event, EventPayload::None);
        }
        if focused {
            self.focused = Some(id);
            // Moving between fields with the keyboard up.
            if self.keyboard > 0.0 {
                self.avoid_keyboard(KeyboardMotion::now(0.25));
            }
        } else if self.focused == Some(id) {
            self.focused = None;
        }
        self.publish_focus_path();
    }

    /// Return pressed in an input that submits (`submitBehavior`): reports
    /// `onSubmitEditing`, then ends editing for `blurAndSubmit`.
    pub(crate) fn input_submitted(&mut self, id: NodeId, text: String) {
        let Some(Slot {
            native: Native::Input(input),
            events,
            ..
        }) = self.slot(id)
        else {
            return;
        };
        if events.contains(EventKind::SubmitEditing) {
            let count = input.count;
            self.control.dispatch_event(
                id,
                EventKind::SubmitEditing,
                EventPayload::Text { text, count },
            );
        }
        if input.submit() == SubmitBehavior::BlurAndSubmit {
            input.editor_view().resignFirstResponder();
        }
    }

    /// The software keyboard now covers `height` points of the surface,
    /// getting there as `motion` says.
    pub(crate) fn keyboard_changed(&mut self, height: f32, motion: KeyboardMotion) {
        self.keyboard = height;
        self.keyboard_motion = motion;
        self.avoid_keyboard(motion);
    }

    /// Keeps the focused input visible: gives its scroll view a bottom inset
    /// as high as the part the keyboard covers, and scrolls to the input,
    /// both moving as the keyboard does.
    fn avoid_keyboard(&mut self, motion: KeyboardMotion) {
        let scroll = self.focused.and_then(|id| self.scroll_around(id));
        if let Some(previous) = self.avoiding.take()
            && (Some(previous) != scroll.as_ref().map(|(id, _)| *id) || self.keyboard <= 0.0)
            && let Some(Slot {
                native: Native::Scroll(view),
                ..
            }) = self.slot(previous)
        {
            let base = self.base_inset(previous).bottom;
            set_bottom_inset(view, base, None, motion, self.mtm);
        }
        let (Some((scroll_id, scroll)), Some(root)) = (scroll, self.slot(nsh_core::ROOT_ID)) else {
            return;
        };
        if self.keyboard <= 0.0 {
            return;
        }
        let root = root.native.view();
        let Some(parent) = scroll.superview() else {
            return;
        };
        // In window coordinates: the scroll view may be in a modal, which
        // is not inside the surface's root view.
        let frame = parent.convertRect_toView(scroll.frame(), None);
        let root_bottom =
            root.convertPoint_toView(CGPoint::new(0.0, root.bounds().size.height), None);
        let keyboard_top = root_bottom.y - self.keyboard as CGFloat;
        let covered = (frame.origin.y + frame.size.height - keyboard_top).max(0.0);
        let base = self.base_inset(scroll_id).bottom;
        let reveal = match self.focused.and_then(|id| self.slot(id)) {
            Some(Slot {
                native: Native::Input(input),
                ..
            }) => {
                let editor = input.editor_view();
                let rect = editor.convertRect_toView(editor.bounds(), Some(&scroll));
                let margin = 12.0;
                Some(CGRect::new(
                    CGPoint::new(rect.origin.x, rect.origin.y - margin),
                    CGSize::new(rect.size.width, rect.size.height + 2.0 * margin),
                ))
            }
            _ => None,
        };
        set_bottom_inset(&scroll, base + covered, reveal, motion, self.mtm);
        self.avoiding = Some(scroll_id);
    }

    /// The nearest app scroll view containing view `id`.
    /// The `contentInset` the app set on scroll view `id`.
    fn base_inset(&self, id: NodeId) -> objc2_ui_kit::UIEdgeInsets {
        ui_insets(
            self.slot(id)
                .and_then(|s| s.behavior.as_ref())
                .map(|b| b.content_inset)
                .unwrap_or_default(),
        )
    }

    /// The nearest scroll view around `view` (or `view` itself).
    fn scroll_of(&self, view: &UIView) -> Option<(&Slot, &UIScrollView)> {
        let mut view = Some(view.retain());
        while let Some(v) = view {
            if let Some(
                s @ Slot {
                    native: Native::Scroll(scroll),
                    ..
                },
            ) = self.slot(v.tag() as NodeId)
                && std::ptr::eq::<UIView>(scroll.as_ref(), &*v)
            {
                return Some((s, scroll));
            }
            view = v.superview();
        }
        None
    }

    /// How a touch on `view` treats the keyboard, when it is up and the
    /// touch is outside the focused input: its scroll view's
    /// `keyboardShouldPersistTaps`.
    pub(crate) fn keyboard_tap(&self, view: &UIView) -> Option<nsh_core::KeyboardTaps> {
        if self.keyboard <= 0.0 {
            return None;
        }
        let Some(Slot {
            native: Native::Input(input),
            ..
        }) = self.focused.and_then(|id| self.slot(id))
        else {
            return None;
        };
        if view.isDescendantOfView(input.view()) {
            return None;
        }
        let (scroll, _) = self.scroll_of(view)?;
        Some(
            scroll
                .behavior
                .as_ref()
                .map_or_else(Default::default, |b| b.keyboard_taps),
        )
    }

    /// Counts views listening to touches; the trackers run while any does.
    fn touch_listener_changed(&mut self, listening: bool) {
        if listening {
            self.touch_listeners += 1;
        } else {
            self.touch_listeners = self.touch_listeners.saturating_sub(1);
        }
        let on = self.touch_listeners > 0;
        if on && self.touch_trackers.is_empty() {
            self.add_touch_tracker(nsh_core::ROOT_ID);
            let modals: Vec<NodeId> = self
                .views
                .iter()
                .flatten()
                .filter(|s| matches!(s.native, Native::Modal(_)))
                .map(|s| s.native.view().tag() as NodeId)
                .collect();
            for modal in modals {
                self.add_touch_tracker(modal);
            }
        }
        for (_, tracker) in &self.touch_trackers {
            tracker.setEnabled(on);
        }
    }

    /// Tracks touches on the root view `root` (the surface or a modal).
    fn add_touch_tracker(&mut self, root: NodeId) {
        if self.touch_trackers.iter().any(|(id, _)| *id == root) {
            return;
        }
        let Some(view) = self.slot(root).map(|s| s.native.view().retain()) else {
            return;
        };
        let tracker = crate::touch::TouchTracker::new(self.mtm, &self.target);
        tracker.setEnabled(self.touch_listeners > 0);
        view.addGestureRecognizer(&tracker);
        self.touch_trackers.push((root, tracker));
    }

    /// The node under a touch at `point` of `view` (the view UIKit hit,
    /// which skips views without interaction such as text) and the nodes
    /// around it listening to touches, innermost first.
    pub(crate) fn touch_target(
        &self,
        view: &UIView,
        point: CGPoint,
    ) -> Option<(NodeId, Retained<UIView>, Vec<NodeId>)> {
        let mut target = None;
        let mut path = Vec::new();
        // The innermost view there, as React Native targets it.
        let mut current = Some(innermost(view, point));
        while let Some(v) = current {
            let id = v.tag() as NodeId;
            let slot = self
                .slot(id)
                .filter(|s| std::ptr::eq::<UIView>(s.native.view(), &*v));
            current = match slot {
                Some(s) => {
                    if target.is_none() {
                        target = Some((id, v.retain()));
                    }
                    if s.events.contains(EventKind::Touch) {
                        path.push(id);
                    }
                    // Screens, header items and modals are not subviews of
                    // their parent node's view.
                    match self.hosts.get(&id).and_then(|&p| self.slot(p)) {
                        Some(host) => Some(host.native.view().retain()),
                        None => v.superview(),
                    }
                }
                None => v.superview(),
            };
        }
        let (id, view) = target?;
        (!path.is_empty()).then_some((id, view, path))
    }

    /// Marks `id` as a cell of a mirrored list (or not), flipping it back.
    fn set_in_mirrored(&mut self, id: NodeId, mirrored: bool) {
        if let Some(c) = self.slot_mut(id)
            && c.in_mirrored != mirrored
        {
            c.in_mirrored = mirrored;
            if let Some(c) = self.slot(id) {
                apply_dynamic(c, &self.animator);
            }
        }
    }

    /// A native scroll view took the touches over.
    pub(crate) fn cancel_touches(&self) {
        for (_, tracker) in &self.touch_trackers {
            tracker.cancel_all();
        }
    }

    /// A JS responder took the touches on `id`: with `block`, the scroll
    /// views around it stop scrolling until it lets go.
    fn set_js_responder(&mut self, id: NodeId, block: bool) {
        self.clear_js_responder();
        if !block {
            return;
        }
        let Some(s) = self.slot(id) else { return };
        let mut current = s.native.view().superview();
        while let Some(v) = current {
            if let Some(scroll) = v.downcast_ref::<UIScrollView>() {
                let pan = scroll.panGestureRecognizer();
                if pan.isEnabled() {
                    pan.setEnabled(false);
                    self.blocked_scrolls.push(scroll.retain());
                }
            }
            current = v.superview();
        }
    }

    fn clear_js_responder(&mut self) {
        for scroll in self.blocked_scrolls.drain(..) {
            scroll.panGestureRecognizer().setEnabled(true);
        }
    }

    pub(crate) fn dismiss_keyboard(&self) {
        if let Some(root) = self.slot(nsh_core::ROOT_ID) {
            root.native.view().window().map(|w| w.endEditing(true));
        }
    }

    /// Where a fling of scroll view `id` ends when it snaps: `target` is
    /// UIKit's proposal, `velocity` in points per millisecond.
    pub(crate) fn snap_target(
        &self,
        id: NodeId,
        velocity: CGPoint,
        target: CGPoint,
    ) -> Option<CGPoint> {
        let Some(Slot {
            native: Native::Scroll(scroll),
            behavior: Some(b),
            horizontal,
            ..
        }) = self.slot(id)
        else {
            return None;
        };
        if !b.snaps() {
            return None;
        }
        let offset = scroll.contentOffset();
        let bounds = scroll.bounds().size;
        let content = scroll.contentSize();
        let (at, projected, v, viewport, length) = if *horizontal {
            (offset.x, target.x, velocity.x, bounds.width, content.width)
        } else {
            (
                offset.y,
                target.y,
                velocity.y,
                bounds.height,
                content.height,
            )
        };
        let snapped = b
            .snap_target(
                Points(at as f32),
                Points(projected as f32),
                v as f32,
                Points(viewport as f32),
                Points(length as f32),
            )?
            .0 as CGFloat;
        Some(if *horizontal {
            CGPoint::new(snapped, target.y)
        } else {
            CGPoint::new(target.x, snapped)
        })
    }

    fn scroll_around(&self, id: NodeId) -> Option<(NodeId, Retained<UIScrollView>)> {
        let mut view = self.slot(id)?.native.view().superview();
        while let Some(v) = view {
            if let Some(Slot {
                native: Native::Scroll(scroll),
                ..
            }) = self.slot(v.tag() as NodeId)
                && std::ptr::eq::<UIView>(scroll.as_ref(), &*v)
            {
                return Some((v.tag() as NodeId, scroll.clone()));
            }
            view = v.superview();
        }
        None
    }

    /// Reshapes a view's background, border, corners, clipping and shadow.
    /// Applies a view style; with a transition, changes animate.
    fn set_view_style(&mut self, id: NodeId, style: ViewStyle) {
        let mtm = self.mtm;
        let target = self.target.clone();
        let Some(s) = self.slot_mut(id) else { return };
        let view = s.native.view().retain();
        let layer = view.layer();
        layer.setDoubleSided(!style.backface_hidden);
        let old_filters = s
            .style
            .effects
            .as_ref()
            .map(|e| e.filters.clone())
            .unwrap_or_default();
        let keyframes_changed = s.style.animation != style.animation;
        let blend_changed = s.style.blend_mode != style.blend_mode;
        let cursor_changed = s.style.cursor != style.cursor;
        // Transitions apply to changes of a view already on screen.
        let transition = style
            .transition
            .filter(|t| t.duration > 0.0 && view.window().is_some());
        s.style = style;
        view.setHidden(s.style.hidden);
        match transition {
            Some(t) => {
                // Sublayers animate implicitly in the transaction; the
                // view's layer gets explicit animations.
                let this: *mut Self = self;
                crate::interaction::transition(&view, &t, || {
                    // SAFETY: `self` is borrowed mutably for the whole call;
                    // the closure runs synchronously inside it.
                    let this = unsafe { &mut *this };
                    this.decorate_animated(id);
                    if let Some(s) = this.slot(id) {
                        apply_dynamic(s, &this.animator);
                    }
                });
            }
            None => {
                self.decorate(id);
                if let Some(s) = self.slot(id) {
                    apply_dynamic(s, &self.animator);
                }
            }
        }
        let Some(s) = self.slot_mut(id) else { return };
        if keyframes_changed {
            let height = view.bounds().size.height;
            crate::interaction::keyframes(&layer, s.style.animation.as_ref(), height);
        }
        if blend_changed {
            crate::interaction::blend(&layer, s.style.blend_mode);
        }
        if cursor_changed {
            let wanted = s.style.cursor != nsh_core::Cursor::Auto;
            match (&s.gestures.pointer, wanted) {
                (None, true) => {
                    let delegate = ProtocolObject::from_ref(&*target);
                    let i = objc2_ui_kit::UIPointerInteraction::initWithDelegate(
                        objc2_ui_kit::UIPointerInteraction::alloc(mtm),
                        Some(delegate),
                    );
                    view.addInteraction(ProtocolObject::from_ref(&*i));
                    s.gestures.pointer = Some(i);
                }
                (Some(i), false) => {
                    view.removeInteraction(ProtocolObject::from_ref(&**i));
                    s.gestures.pointer = None;
                }
                (Some(i), true) => i.invalidate(),
                _ => {}
            }
        }
        // Filters of images apply to their pixels: decode again.
        let new_filters = s
            .style
            .effects
            .as_ref()
            .map(|e| e.filters.clone())
            .unwrap_or_default();
        if matches!(s.native, Native::Image(_)) && old_filters != new_filters && s.image.is_some() {
            s.image_shown = false;
            if let Some(key) = s.image_key.take() {
                self.images.cancel(id, &key);
            }
            if !self.pending_images.contains(&id) {
                self.pending_images.push(id);
            }
        }
    }

    /// Restyles with Core Animation's implicit animations on.
    fn decorate_animated(&mut self, id: NodeId) {
        let (mtm, animator) = (self.mtm, &self.animator);
        let Some(s) = self.views.get_mut(id as usize).and_then(Option::as_mut) else {
            return;
        };
        let background = dynamic_background(s, animator);
        let kind = s.native.kind();
        let bound = bound_style(s, animator);
        s.decor.apply_animated(
            s.native.view(),
            kind,
            bound.as_ref().unwrap_or(&s.style),
            background.0,
            background.1,
            mtm,
        );
        if bound.is_some() {
            apply_bound_decor(s, animator);
        }
    }

    /// The core asked for the states of `id` it reads (`active:`, ...).
    fn track_states(&mut self, id: NodeId, states: u8) {
        let Some(s) = self.slot_mut(id) else { return };
        if s.tracked == states {
            return;
        }
        s.tracked = states;
        let events = s.events;
        self.set_events(id, events);
    }

    /// An interaction state of `id` changed: tells the core if it reads it.
    fn report_state(&mut self, id: NodeId, bit: u8, on: bool) {
        let Some(s) = self.slot_mut(id) else { return };
        let states = if on { s.states | bit } else { s.states & !bit };
        if states == s.states {
            return;
        }
        s.states = states;
        let tracked = s.tracked;
        if tracked & bit != 0 {
            self.control.set_states(id, states & tracked);
        }
    }

    /// A pointer (an iPad's, a Mac's mouse) entered (`Began`), moved over
    /// or left view `id`, at `in_window` (the window's coordinates).
    pub(crate) fn hover(
        &mut self,
        id: NodeId,
        state: UIGestureRecognizerState,
        in_window: CGPoint,
        modifiers: isize,
    ) {
        let on = matches!(
            state,
            UIGestureRecognizerState::Began | UIGestureRecognizerState::Changed
        );
        self.report_state(id, nsh_core::tailwind::state::HOVERED, on);
        let Some(events) = self.slot(id).map(|s| s.events) else {
            return;
        };
        let changed = match state {
            UIGestureRecognizerState::Began => Some(EventKind::HoverIn),
            UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled => {
                Some(EventKind::HoverOut)
            }
            _ => None,
        };
        if let Some(kind) = changed.filter(|k| events.contains(*k)) {
            self.control.dispatch_event(id, kind, EventPayload::None);
        }
        if !on || !events.contains(EventKind::HoverMove) {
            return;
        }
        let Some(view) = self.slot(id).map(|s| s.native.view().retain()) else {
            return;
        };
        let (position, page_position) = self.pointer_positions(&view, in_window);
        let event = nsh_core::HoverEvent {
            position,
            page_position,
            modifiers: key_modifiers(modifiers),
        };
        self.control
            .dispatch_event(id, EventKind::HoverMove, EventPayload::Hover(event));
    }

    /// A secondary click on view `id`, at `in_window` (the window's
    /// coordinates).
    pub(crate) fn context_menu(&mut self, id: NodeId, in_window: CGPoint, modifiers: isize) {
        let Some(view) = self.slot(id).map(|s| s.native.view().retain()) else {
            return;
        };
        let (position, page_position) = self.pointer_positions(&view, in_window);
        let event = nsh_core::ContextMenuEvent {
            position,
            page_position,
            modifiers: key_modifiers(modifiers),
        };
        self.control
            .dispatch_event(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
    }

    /// `in_window` (the window's coordinates) in `view` and in the root
    /// view it is in.
    fn pointer_positions(
        &self,
        view: &UIView,
        in_window: CGPoint,
    ) -> (nsh_core::Point<Points>, nsh_core::Point<Points>) {
        let local = view.convertPoint_fromView(in_window, None);
        let page = self.root_view_of(view).map_or(in_window, |root| {
            root.convertPoint_fromView(in_window, None)
        });
        (
            point(Points(local.x as f32), Points(local.y as f32)),
            point(Points(page.x as f32), Points(page.y as f32)),
        )
    }

    /// The root view `view` is in: the surface's, or its modal's (touches'
    /// page coordinates are in it).
    fn root_view_of(&self, view: &UIView) -> Option<Retained<UIView>> {
        let mut current = Some(view.retain());
        while let Some(v) = current {
            let tag = v.tag() as NodeId;
            if tag == nsh_core::ROOT_ID
                || self
                    .slot(tag)
                    .is_some_and(|s| matches!(s.native, Native::Modal(_)))
            {
                return Some(v);
            }
            current = v.superview();
        }
        None
    }

    /// The pointer's look over view `id`.
    pub(crate) fn pointer_style(
        &self,
        id: NodeId,
    ) -> Option<Retained<objc2_ui_kit::UIPointerStyle>> {
        let s = self.slot(id)?;
        crate::interaction::pointer_style(s.native.view(), s.style.cursor, self.mtm)
    }

    fn decorate(&mut self, id: NodeId) {
        let (mtm, animator) = (self.mtm, &self.animator);
        let Some(s) = self.views.get_mut(id as usize).and_then(Option::as_mut) else {
            return;
        };
        let mut background = s.style.background_color;
        let mut animated = false;
        for &(prop, node) in &s.bindings {
            if prop == AnimationProp::BackgroundColor {
                animated = true;
                if let AnimationValue::Color(c) = animator.eval(node) {
                    background = Color(c);
                }
            }
        }
        let kind = s.native.kind();
        let bound = bound_style(s, animator);
        s.decor.apply(
            s.native.view(),
            kind,
            bound.as_ref().unwrap_or(&s.style),
            background,
            animated,
            mtm,
        );
        if bound.is_some() {
            apply_bound_decor(s, animator);
        }
    }

    fn set_image(
        &mut self,
        id: NodeId,
        source: Option<ImageSource>,
        resize_mode: ResizeMode,
        options: nsh_core::ImageOptions,
    ) {
        let Some(s) = self.slot_mut(id) else { return };
        if !matches!(s.native, Native::Image(_)) {
            return;
        }
        // `center` shows the image at its own size: decoded so, where the
        // other modes decode it at the view's.
        let natural = |m: ResizeMode| m == ResizeMode::Center;
        let same_decode = natural(s.decor.resize_mode()) == natural(resize_mode);
        s.decor.set_fit(resize_mode, options.position);
        let same_source = same_decode
            && s.image.as_ref().map(|src| &src.uri) == source.as_ref().map(|src| &src.uri);
        let same_look = s.image_options.placeholder == options.placeholder
            && s.image_options.blur_radius == options.blur_radius;
        s.image_options = options;
        if same_source && same_look {
            return;
        }
        s.decor.set_image(None, 0.0);
        s.image_shown = false;
        let old = [s.image_key.take(), s.placeholder_key.take()];
        s.image = source;
        let wants = s.image.is_some() || s.image_options.placeholder.is_some();
        for key in old.into_iter().flatten() {
            self.images.cancel(id, &key);
        }
        if wants {
            self.pending_images.push(id);
        }
    }

    /// The screen's pixels per point. Not `contentScaleFactor`: it stays 1
    /// on views that draw nothing themselves.
    fn display_scale(&self) -> CGFloat {
        let Some(root) = self.slot(nsh_core::ROOT_ID).map(|s| s.native.view()) else {
            return 2.0;
        };
        // SAFETY: a plain getter.
        let scale = unsafe { root.traitCollection().displayScale() };
        if scale > 0.0 {
            return scale;
        }
        root.window().map_or(2.0, |w| w.screen().scale())
    }

    /// The surface's traits changed: on a screen of another scale (an
    /// external display, Catalyst), images decode again for it.
    pub(crate) fn traits_changed(&mut self) {
        if self.display_scale() == self.image_scale {
            return;
        }
        for (id, slot) in self.views.iter_mut().enumerate() {
            let Some(s) = slot else { continue };
            if !matches!(s.native, Native::Image(_))
                || (s.image.is_none() && s.image_options.placeholder.is_none())
            {
                continue;
            }
            let id = id as NodeId;
            for key in [s.image_key.take(), s.placeholder_key.take()]
                .into_iter()
                .flatten()
            {
                self.images.cancel(id, &key);
            }
            if !self.pending_images.contains(&id) {
                self.pending_images.push(id);
            }
        }
        self.start_image_loads();
    }

    /// Starts loads queued during the batch, now that frames are known so
    /// images can be decoded at their display size.
    fn start_image_loads(&mut self) {
        let scale = self.display_scale();
        self.image_scale = scale;
        for id in std::mem::take(&mut self.pending_images) {
            let Some(s) = self.slot(id) else { continue };
            let Native::Image(view) = &s.native else {
                continue;
            };
            let size = view.bounds().size;
            // 0: the image's own size, which `center` shows.
            let max_pixels = if s.decor.resize_mode() == ResizeMode::Center {
                0
            } else {
                (size.width.max(size.height) * scale).ceil() as u32
            };
            let filters = s
                .style
                .effects
                .as_ref()
                .map(|e| &e.filters[..])
                .unwrap_or(&[]);
            let look = crate::image::Look {
                blur: s.image_options.blur_radius.0 + nsh_core::blur_radius(filters).0,
                matrix: nsh_core::compose_color_matrices(filters),
            };
            let (source, placeholder) = (
                s.image.as_ref().map(|s| (s.uri.clone(), s.data.clone())),
                s.image_options
                    .placeholder
                    .as_ref()
                    .map(|s| (s.uri.clone(), s.data.clone())),
            );
            if let Some((uri, data)) = source {
                match self
                    .images
                    .request(id, &uri, data.as_ref(), max_pixels, scale, look)
                {
                    Request::Ready(decoded) => {
                        if let Some(s) = self.slot_mut(id) {
                            s.decor.set_image(Some(&decoded.image), 0.0);
                            s.image_shown = true;
                        }
                        self.image_event(id, Ok(&decoded));
                    }
                    Request::Pending => {
                        if let Some(s) = self.slot_mut(id) {
                            s.image_key = Some(ImageLoader::key(&uri, max_pixels, look));
                            if s.events.contains(EventKind::LoadStart) {
                                self.control.dispatch_event(
                                    id,
                                    EventKind::LoadStart,
                                    EventPayload::None,
                                );
                            }
                        }
                    }
                }
            }
            // The placeholder, until the image shows.
            let shown = self.slot(id).is_some_and(|s| s.image_shown);
            if let Some((uri, data)) = placeholder.filter(|_| !shown) {
                let plain = crate::image::Look::default();
                match self
                    .images
                    .request(id, &uri, data.as_ref(), max_pixels, scale, plain)
                {
                    Request::Ready(decoded) => {
                        if let Some(s) = self.slot_mut(id) {
                            s.decor.set_image(Some(&decoded.image), 0.0);
                        }
                    }
                    Request::Pending => {
                        if let Some(s) = self.slot_mut(id) {
                            s.placeholder_key = Some(ImageLoader::key(&uri, max_pixels, plain));
                        }
                    }
                }
            }
        }
    }

    /// What canvas `id` draws; loads the images it draws.
    fn set_drawing(&mut self, id: NodeId, drawing: Arc<nsh_core::canvas::Drawing>) {
        let Some(Slot {
            native: Native::Canvas(view),
            ..
        }) = self.slot(id)
        else {
            return;
        };
        let view = view.clone();
        view.set_drawing(drawing.clone());
        // Not the view's `contentScaleFactor`: zooming raises it.
        let scale = self.display_scale();
        for image in drawing.images() {
            if view.has_image(&image.uri) {
                continue;
            }
            // At their natural size: the drawing may scale them anyway.
            match self.images.request(
                id,
                &image.uri,
                None,
                0,
                scale,
                crate::image::Look::default(),
            ) {
                Request::Ready(decoded) if decoded.vector => {
                    log::warn!("canvas image failed: {}", not_a_bitmap(&image.uri));
                }
                Request::Ready(decoded) => view.set_image(image.uri.clone(), decoded.image),
                Request::Pending => {}
            }
        }
    }

    /// What the image loader reports.
    /// The disk cache the images it loads go through.
    pub(crate) fn set_image_cache(&mut self, cache: Option<nsh_core::image::DiskCache>) {
        self.images.set_disk_cache(cache);
    }

    pub(crate) fn load_event(&mut self, event: crate::image::LoadEvent) {
        use crate::image::LoadEvent;
        match event {
            LoadEvent::Decoded { key, result } => self.image_loaded(&key, result),
            LoadEvent::Bytes { uri, result } => self.images.bytes_ready(&uri, result),
            LoadEvent::Download { uri, headers } => self.images.download(&uri, &headers),
            LoadEvent::Progress { uri, loaded, total } => {
                for id in self.images.waiting(&uri) {
                    let Some(s) = self.slot(id) else { continue };
                    if s.image.as_ref().is_some_and(|i| *i.uri == *uri)
                        && s.events.contains(EventKind::Progress)
                    {
                        self.control.dispatch_event(
                            id,
                            EventKind::Progress,
                            EventPayload::Map(vec![
                                ("loaded", PayloadValue::Number(loaded as f64)),
                                ("total", PayloadValue::Number(total as f64)),
                            ]),
                        );
                    }
                }
            }
            LoadEvent::Info { id, result } => {
                let mut fields = vec![("id", PayloadValue::Number(id as f64))];
                match result {
                    Ok((w, h)) => {
                        fields.push(("width", PayloadValue::Number(w as f64)));
                        fields.push(("height", PayloadValue::Number(h as f64)));
                    }
                    Err(message) => fields.push(("error", PayloadValue::Str(message))),
                }
                self.control.dispatch_event(
                    nsh_core::ROOT_ID,
                    EventKind::ImageInfo,
                    EventPayload::Map(fields),
                );
            }
        }
    }

    pub(crate) fn image_loaded(&mut self, key: &str, result: Result<DecodedImage, String>) {
        for id in self.images.finish(key, &result) {
            if let Some(Slot {
                native: Native::Canvas(view),
                ..
            }) = self.slot(id)
            {
                // Canvas images are requested at their natural size.
                match (&result, key.strip_prefix("0@")) {
                    (Ok(decoded), Some(uri)) if decoded.vector => {
                        log::warn!("canvas image failed: {}", not_a_bitmap(uri));
                    }
                    (Ok(decoded), Some(uri)) => view.set_image(uri.into(), decoded.image.clone()),
                    (Err(message), _) => log::warn!("canvas image failed: {message}"),
                    _ => {}
                }
                continue;
            }
            let Some(s) = self.slot_mut(id) else { continue };
            if s.placeholder_key.as_deref() == Some(key) {
                s.placeholder_key = None;
                if let (Ok(decoded), false) = (&result, s.image_shown) {
                    s.decor.set_image(Some(&decoded.image), 0.0);
                }
                continue;
            }
            if s.image_key.as_deref() != Some(key) {
                continue;
            }
            s.image_key = None;
            match &result {
                Ok(decoded) => {
                    // React Native fades images in on Android only.
                    let fade = s.image_options.fade_ms.unwrap_or(0.0) as f64 / 1000.0;
                    s.decor.set_image(Some(&decoded.image), fade);
                    s.image_shown = true;
                    self.image_event(id, Ok(decoded));
                }
                Err(message) => {
                    log::warn!("image failed: {message}");
                    // The placeholder (if any) stays.
                    self.image_event(id, Err(message));
                }
            }
        }
    }

    /// `onLoad` reports the source's size in pixels (as Android).
    fn image_event(&self, id: NodeId, result: Result<&DecodedImage, &String>) {
        let Some(s) = self.slot(id) else { return };
        match result {
            Ok(decoded) if s.events.contains(EventKind::Load) => {
                self.control.dispatch_event(
                    id,
                    EventKind::Load,
                    EventPayload::Image(size(
                        DevicePixels(decoded.width as i32),
                        DevicePixels(decoded.height as i32),
                    )),
                );
            }
            Err(message) if s.events.contains(EventKind::Error) => {
                self.control.dispatch_event(
                    id,
                    EventKind::Error,
                    EventPayload::Error {
                        message: message.clone(),
                    },
                );
            }
            _ => {}
        }
        if s.events.contains(EventKind::LoadEnd) {
            self.control
                .dispatch_event(id, EventKind::LoadEnd, EventPayload::None);
        }
    }

    fn set_events(&mut self, id: NodeId, events: EventMask) {
        let listened = self
            .slot(id)
            .is_some_and(|s| s.events.contains(EventKind::Touch));
        self.set_view_events(id, events);
        let listens = self
            .slot(id)
            .is_some_and(|s| s.events.contains(EventKind::Touch));
        if listened != listens {
            self.touch_listener_changed(listens);
        }
    }

    fn set_view_events(&mut self, id: NodeId, events: EventMask) {
        let target = self.target.clone();
        let control = self.control.clone();
        let (mtm, mac_idiom) = (self.mtm, self.mac_idiom);
        let Some(slot) = self.views.get_mut(id as usize).and_then(Option::as_mut) else {
            return;
        };
        slot.events = events;
        if let Native::Input(input) = &mut slot.native {
            input.set_paste_listens(events.contains(EventKind::Paste));
        }
        let v = slot.values;
        let handoff = slot.pan_scroll_handoff;
        let any = |kinds: &[EventKind]| kinds.iter().any(|&k| events.contains(k));
        let handles_press = any(&[
            EventKind::Press,
            EventKind::LongPress,
            EventKind::PressDown,
            EventKind::PressUp,
        ]);
        let own_press = handles_press || slot.tracked & nsh_core::tailwind::state::PRESSED != 0;
        let (links, links_long_press) = match &slot.native {
            Native::Text(t) => (t.has_links(), t.links_long_press()),
            _ => (false, false),
        };
        let wants_press = own_press || links;
        let wants_pan = v.pan_x.is_some()
            || v.pan_y.is_some()
            || any(&[EventKind::PanStart, EventKind::PanEnd]);
        let wants_pinch = v.pinch.is_some() || any(&[EventKind::PinchStart, EventKind::PinchEnd]);
        let wants_rotation =
            v.rotation.is_some() || any(&[EventKind::RotationStart, EventKind::RotationEnd]);
        let view = slot.native.view();
        let g = &mut slot.gestures;
        let delegate = ProtocolObject::from_ref(&*target);
        toggle(&mut g.press, wants_press, view, || {
            PressRecognizer::new(mtm, &target)
        });
        // SAFETY: every selector is implemented by `EventTarget`, which the
        // mounter keeps alive as long as the recognizers; so is the delegate.
        unsafe {
            toggle(&mut g.pan, wants_pan, view, || {
                let r = UIPanGestureRecognizer::initWithTarget_action(
                    UIPanGestureRecognizer::alloc(mtm),
                    Some(&target),
                    Some(sel!(handlePan:)),
                );
                r.setDelegate(Some(delegate));
                if handoff {
                    r.setMaximumNumberOfTouches(1);
                }
                r
            });
            toggle(&mut g.pinch, wants_pinch, view, || {
                let r = UIPinchGestureRecognizer::initWithTarget_action(
                    UIPinchGestureRecognizer::alloc(mtm),
                    Some(&target),
                    Some(sel!(handlePinch:)),
                );
                r.setDelegate(Some(delegate));
                r
            });
            toggle(&mut g.rotation, wants_rotation, view, || {
                let r = UIRotationGestureRecognizer::initWithTarget_action(
                    UIRotationGestureRecognizer::alloc(mtm),
                    Some(&target),
                    Some(sel!(handleRotation:)),
                );
                r.setDelegate(Some(delegate));
                r
            });
        }
        if let Some(press) = &g.press {
            press.set_long_press(events.contains(EventKind::LongPress) || links_long_press);
            press.set_own(own_press, handles_press);
            press.set_long_press_delay(slot.long_press_delay);
        }
        let wants_hover = slot.tracked & nsh_core::tailwind::state::HOVERED != 0
            || events.contains(EventKind::HoverIn)
            || events.contains(EventKind::HoverOut)
            || events.contains(EventKind::HoverMove);
        toggle(&mut slot.gestures.hover, wants_hover, view, || {
            // SAFETY: `handleHover:` is implemented by the target, which
            // outlives the recognizer.
            unsafe {
                objc2_ui_kit::UIHoverGestureRecognizer::initWithTarget_action(
                    objc2_ui_kit::UIHoverGestureRecognizer::alloc(mtm),
                    Some(&target),
                    Some(sel!(handleHover:)),
                )
            }
        });
        let wants_context = events.contains(EventKind::ContextMenu);
        toggle(&mut slot.gestures.context, wants_context, view, || {
            // SAFETY: `handleContextMenu:` is implemented by the target,
            // which outlives the recognizer; `buttonMaskRequired` is
            // UIGestureRecognizer's (iOS 13.4), UIEventButtonMaskSecondary.
            unsafe {
                let r = objc2_ui_kit::UITapGestureRecognizer::initWithTarget_action(
                    objc2_ui_kit::UITapGestureRecognizer::alloc(mtm),
                    Some(&target),
                    Some(sel!(handleContextMenu:)),
                );
                let _: () = objc2::msg_send![&r, setButtonMaskRequired: 1isize << 1];
                // A finger has no buttons, so the mask does not hold it:
                // a tap would open the menu and cancel the presses inside.
                // Only a mouse or a trackpad (UITouchTypeIndirectPointer).
                let pointer = objc2_foundation::NSNumber::new_isize(3);
                r.setAllowedTouchTypes(&objc2_foundation::NSArray::from_retained_slice(&[pointer]));
                r
            }
        });
        let wants_touch = events.contains(EventKind::Touch);
        if wants_press
            || wants_pan
            || wants_pinch
            || wants_rotation
            || wants_touch
            || wants_hover
            || wants_context
        {
            view.setUserInteractionEnabled(true);
        }
        if let Some(nsh) = slot.native.nsh() {
            nsh.set_pressable(events.contains(EventKind::Press), &control);
        }
        if let Native::Scroll(scroll) = &slot.native {
            let wants_refresh = events.contains(EventKind::Refresh);
            match (&slot.gestures.refresh, wants_refresh) {
                (None, true) if mac_idiom => {
                    let spinner = UIActivityIndicatorView::initWithActivityIndicatorStyle(
                        UIActivityIndicatorView::alloc(mtm),
                        UIActivityIndicatorViewStyle::Medium,
                    );
                    spinner.setHidesWhenStopped(true);
                    place_spinner(&spinner, scroll.bounds().size.width as f32);
                    scroll.addSubview(&spinner);
                    slot.gestures.refresh = Some(Refresh::Custom {
                        spinner,
                        refreshing: false,
                        reveal_pending: Rc::new(Cell::new(false)),
                    });
                }
                (None, true) => {
                    let control = UIRefreshControl::new(mtm);
                    // SAFETY: `handleRefresh:` is implemented by the target.
                    unsafe {
                        control.addTarget_action_forControlEvents(
                            Some(&target),
                            sel!(handleRefresh:),
                            UIControlEvents::ValueChanged,
                        )
                    };
                    scroll.setRefreshControl(Some(&control));
                    slot.gestures.refresh = Some(Refresh::Native(control));
                }
                (Some(refresh), false) => {
                    match refresh {
                        Refresh::Native(_) => scroll.setRefreshControl(None),
                        Refresh::Custom { spinner, .. } => spinner.removeFromSuperview(),
                    }
                    slot.gestures.refresh = None;
                }
                _ => {}
            }
        }
    }

    /// Screens, header items and modals are not subviews of their parent:
    /// records them for [`Mounter::finish_navigation`]. Returns true if
    /// `child` is one of them.
    fn insert_hosted(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) -> bool {
        let Some(c) = self.slot(child) else {
            return false;
        };
        match &c.native {
            Native::Screen(screen) => {
                screen.restore();
                if let Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) = self.slot_mut(parent)
                {
                    stack.screens.retain(|&s| s != child);
                    let pos = before
                        .and_then(|b| stack.screens.iter().position(|&s| s == b))
                        .unwrap_or(stack.screens.len());
                    stack.screens.insert(pos, child);
                    self.dirty_stacks.push(parent);
                }
            }
            Native::HeaderItem(_) => self.dirty_headers.push(parent),
            Native::Modal(_) => self.dirty_modals.push(child),
            // A cancellation can reinsert this root without changing the
            // editors' InputConfig, so restore their actual native references.
            Native::InputAccessory(view) => {
                for slot in self.views.iter().flatten() {
                    if let Native::Input(input) = &slot.native
                        && input.accessory() == Some(child)
                    {
                        input.set_accessory(Some(view), true);
                    }
                }
            }
            _ => return false,
        }
        self.hosts.insert(child, parent);
        true
    }

    /// Parks one member of Core's supplied logical-root snapshot. The
    /// existing native hosting relation is enough to remove platform chrome;
    /// it is not a second logical-ownership tree.
    fn park_retired_root(&mut self, id: NodeId) {
        let parent = self.hosts.remove(&id);
        let kind = self.slot(id).map(|slot| match &slot.native {
            Native::Modal(_) => ViewKind::Modal,
            Native::Screen(_) => ViewKind::Screen,
            Native::HeaderItem(_) => ViewKind::HeaderItem,
            Native::InputAccessory(_) => ViewKind::InputAccessory,
            _ => ViewKind::View,
        });
        match kind {
            Some(ViewKind::Modal) => {
                self.dirty_modals.retain(|&modal| modal != id);
                if let Some(Slot {
                    native: Native::Modal(modal),
                    ..
                }) = self.slot_mut(id)
                {
                    modal.controller.flush_dismiss();
                    modal.park();
                }
            }
            Some(ViewKind::Screen) => {
                if let Some(Slot {
                    native: Native::Screen(screen),
                    ..
                }) = self.slot(id)
                {
                    screen.park();
                }
                if let Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) = parent.and_then(|parent| self.slot_mut(parent))
                {
                    stack.park_screen(id);
                }
            }
            Some(ViewKind::HeaderItem) => {
                if let Some(parent) = parent {
                    self.apply_hosted_header(parent);
                }
            }
            Some(ViewKind::InputAccessory) => {
                for slot in self.views.iter().flatten() {
                    if let Native::Input(input) = &slot.native
                        && input.accessory() == Some(id)
                    {
                        input.set_accessory(None, true);
                    }
                }
            }
            _ => {}
        }
    }

    fn apply_hosted_header(&self, id: NodeId) {
        if let Some(Slot {
            native: Native::Screen(screen),
            ..
        }) = self.slot(id)
        {
            screen.apply_header(
                |item| {
                    if self.hosts.get(&item) != Some(&id) {
                        return None;
                    }
                    match self.slot(item).map(|slot| &slot.native) {
                        Some(Native::HeaderItem(view)) => Some(Retained::into_super(view.clone())),
                        _ => None,
                    }
                },
                Some(self.shared.clone()),
            );
        }
    }

    /// The counterpart of [`Mounter::insert_hosted`] for removals.
    fn remove_hosted(&mut self, id: NodeId) -> bool {
        if let Some(Slot {
            native: Native::Modal(modal),
            ..
        }) = self.slot_mut(id)
            && modal.revoke_parked()
        {
            self.hosts.remove(&id);
            self.dirty_modals.retain(|&modal| modal != id);
            return true;
        }
        let parent = self.hosts.remove(&id).or_else(|| {
            // A parked screen keeps its existing stack order/pop authority;
            // a real source removal still has to revoke that membership.
            if !matches!(
                self.slot(id).map(|slot| &slot.native),
                Some(Native::Screen(_))
            ) {
                return None;
            }
            self.views.iter().enumerate().find_map(|(parent, slot)| {
                matches!(slot.as_ref().map(|slot| &slot.native),
                    Some(Native::Stack(stack)) if stack.screens.contains(&id))
                .then_some(parent as NodeId)
            })
        });
        let Some(parent) = parent else {
            return false;
        };
        match self.slot(id).map(|s| &s.native) {
            Some(Native::Screen(_)) => {
                if let Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) = self.slot_mut(parent)
                {
                    stack.screens.retain(|&s| s != id);
                    stack.popped.retain(|&s| s != id);
                    self.dirty_stacks.push(parent);
                }
            }
            Some(Native::HeaderItem(view)) => {
                view.removeFromSuperview();
                self.dirty_headers.push(parent);
            }
            Some(Native::Modal(_)) => self.dirty_modals.push(id),
            _ => {}
        }
        true
    }

    /// Applies the navigation changes of a batch once all its views exist
    /// and are laid out: pushes and pops screens, updates headers, presents
    /// and dismisses modals.
    fn finish_navigation(&mut self) {
        let mut stacks = std::mem::take(&mut self.dirty_stacks);
        stacks.sort_unstable();
        stacks.dedup();
        for id in stacks {
            let Some(Slot {
                native: Native::Stack(stack),
                ..
            }) = self.slot(id)
            else {
                continue;
            };
            if stack.nav.transitionCoordinator().is_some() {
                if !self.deferred_stacks.contains(&id) {
                    self.deferred_stacks.push(id);
                }
                continue;
            }
            let screens: Vec<_> = stack
                .screens
                .iter()
                .filter(|s| !stack.popped.contains(s))
                .filter(|screen| self.hosts.get(screen) == Some(&id))
                .filter_map(|&s| match self.slot(s).map(|s| &s.native) {
                    Some(Native::Screen(screen)) => {
                        Some((s, screen.controller.clone(), screen.config.animation))
                    }
                    _ => None,
                })
                .collect();
            let leaving = stack
                .nav
                .topViewController()
                .and_then(|c| c.downcast::<crate::navigation::ScreenController>().ok())
                .and_then(|c| match self.slot(c.screen_id()).map(|s| &s.native) {
                    Some(Native::Screen(screen)) => Some(screen.config.animation),
                    _ => None,
                });
            stack.reconcile(&screens, leaving);
            if let Some(Slot {
                native: Native::Stack(stack),
                ..
            }) = self.slot_mut(id)
            {
                stack.contain();
            }
        }
        let mut headers = std::mem::take(&mut self.dirty_headers);
        headers.sort_unstable();
        headers.dedup();
        for id in headers {
            let Some(Slot {
                native: Native::Screen(screen),
                ..
            }) = self.slot(id)
            else {
                continue;
            };
            self.apply_hosted_header(id);
            if screen.config.large_title {
                // Large titles collapse as the content scrolls under them.
                if let Some(scroll) = first_scroll_view(&screen.view) {
                    scroll.setContentInsetAdjustmentBehavior(
                        UIScrollViewContentInsetAdjustmentBehavior::Automatic,
                    );
                }
            }
        }
        let modals = std::mem::take(&mut self.dirty_modals);
        let root = self
            .slot(nsh_core::ROOT_ID)
            .map(|s| s.native.view().retain());
        for id in modals {
            let shown = self.hosts.contains_key(&id);
            let control = self.control.clone();
            let Some(Slot {
                native: Native::Modal(modal),
                ..
            }) = self.slot_mut(id)
            else {
                continue;
            };
            if shown {
                if let Some(root) = &root {
                    if !modal.present(root) {
                        // An exact old SDK shell is completing GC. Its real
                        // completion retries this existing native projection.
                        self.dirty_modals.push(id);
                    }
                }
            } else {
                modal.dismiss(move || {
                    control.dispatch_event(id, EventKind::Dismiss, EventPayload::None)
                });
            }
        }
    }

    pub(crate) fn native_navigation_completed(&mut self) {
        self.finish_navigation();
    }

    /// A stack is about to show a screen: its header options apply.
    pub(crate) fn stack_will_show(
        &mut self,
        nav: &objc2_ui_kit::UINavigationController,
        controller: &objc2_ui_kit::UIViewController,
        animated: bool,
    ) {
        let Some(screen) = controller.downcast_ref::<crate::navigation::ScreenController>() else {
            return;
        };
        let Some(Slot {
            native: Native::Screen(screen),
            ..
        }) = self.slot(screen.screen_id())
        else {
            return;
        };
        let c = &screen.config;
        nav.setNavigationBarHidden_animated(!c.header_visible, animated);
        crate::navigation::style_bar(&nav.navigationBar(), c);
    }

    /// A stack finished a transition: screens the user popped (back button,
    /// swipe) are reported so the app removes them.
    pub(crate) fn stack_did_show(&mut self, id: NodeId) {
        self.report_popped(id);
        // Changes that arrived during the transition, once it is over (the
        // transition coordinator outlives this callback).
        if let Some(i) = self.deferred_stacks.iter().position(|&s| s == id) {
            self.deferred_stacks.swap_remove(i);
            let shared = self.shared.clone();
            dispatch2::DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                if let Some(m) = shared.get(mtm).borrow_mut().as_mut() {
                    m.dirty_stacks.push(id);
                    m.finish_navigation();
                }
            });
        }
    }

    /// Reports the screens of stack `id` that the user popped natively.
    fn report_popped(&mut self, id: NodeId) {
        let Some(Slot {
            native: Native::Stack(stack),
            ..
        }) = self.slot(id)
        else {
            return;
        };
        let shown = stack.nav.viewControllers();
        // Screens the controller had and lost; not those still waiting for
        // a transition to end.
        let gone: Vec<NodeId> = stack
            .applied
            .borrow()
            .iter()
            .copied()
            .filter(|s| stack.screens.contains(s))
            .filter(|s| !stack.popped.contains(s))
            .filter(|&s| match self.slot(s).map(|s| &s.native) {
                Some(Native::Screen(screen)) => !shown.iter().any(|c| {
                    std::ptr::eq::<objc2_ui_kit::UIViewController>(&*c, screen.controller.as_ref())
                }),
                _ => false,
            })
            .collect();
        if gone.is_empty() {
            return;
        }
        if let Some(Slot {
            native: Native::Stack(stack),
            ..
        }) = self.slot_mut(id)
        {
            stack.popped.extend(&gone);
        }
        for screen in gone {
            self.control
                .dispatch_event(screen, EventKind::Dismiss, EventPayload::None);
        }
    }

    /// The top screen of stack `id`, whether it listens to `onBackPress`
    /// and whether it keeps the user (`popOnBack` false).
    pub(crate) fn stack_back_press(&self, id: NodeId) -> Option<(NodeId, bool, bool)> {
        let Some(Slot {
            native: Native::Stack(stack),
            ..
        }) = self.slot(id)
        else {
            return None;
        };
        let top = *stack
            .screens
            .iter()
            .rev()
            .find(|s| !stack.popped.contains(s) && self.hosts.get(s) == Some(&id))?;
        match self.slot(top) {
            Some(Slot {
                native: Native::Screen(screen),
                events,
                ..
            }) => Some((
                top,
                events.contains(EventKind::BackRequest),
                screen.config.prevent_back,
            )),
            _ => None,
        }
    }

    /// Sends a payload-less event to the engine.
    pub(crate) fn dispatch(&self, id: NodeId, kind: EventKind) {
        self.control.dispatch_event(id, kind, EventPayload::None);
    }

    /// Whether the user may pop the top screen of stack `id`.
    pub(crate) fn stack_can_pop(&self, id: NodeId) -> bool {
        let Some(Slot {
            native: Native::Stack(stack),
            ..
        }) = self.slot(id)
        else {
            return false;
        };
        let top = stack
            .screens
            .iter()
            .rev()
            .find(|s| !stack.popped.contains(s) && self.hosts.get(s) == Some(&id))
            .and_then(|&s| match self.slot(s).map(|s| &s.native) {
                Some(Native::Screen(screen)) => {
                    Some(screen.config.gesture_enabled && !screen.config.prevent_back)
                }
                _ => None,
            });
        // Never while a push or pop is still animating.
        stack.nav.viewControllers().count() > 1
            && stack.nav.transitionCoordinator().is_none()
            && top.unwrap_or(true)
    }

    /// Properties of a web view or video.
    fn set_native_props(&mut self, id: NodeId, props: nsh_core::NativeProps) {
        use nsh_core::NativeProps as P;
        let Some(s) = self.slot_mut(id) else { return };
        match (&mut s.native, props) {
            (Native::Web(v), P::WebView(p)) => v.configure(*p),
            (Native::Video(v), P::Video(p)) => v.configure(*p),
            _ => {}
        }
    }

    /// Touch, accessibility and test properties.
    fn set_view_props(&mut self, id: NodeId, props: ViewProps) {
        let (control, mtm) = (self.control.clone(), self.mtm);
        let Some(s) = self.slot_mut(id) else { return };
        s.long_press_delay = props.long_press_delay;
        s.pan_scroll_handoff = props.pan_scroll_handoff;
        if let Some(pan) = &s.gestures.pan {
            pan.setMaximumNumberOfTouches(if props.pan_scroll_handoff {
                1
            } else {
                usize::MAX
            });
        }
        let activation = props.pan_activation;
        toggle(
            &mut s.gestures.gate,
            activation.is_some(),
            s.native.view(),
            || crate::touch::PanGate::new(mtm, activation.unwrap_or_default()),
        );
        if let (Some(gate), Some(a)) = (&s.gestures.gate, activation) {
            gate.set_activation(a);
        }
        if let Some(press) = &s.gestures.press {
            press.set_long_press_delay(props.long_press_delay);
        }
        // Only views that keep their props (which texts below look up).
        let area =
            (props.selection_area && s.native.nsh().is_some()).then(|| s.native.view().retain());
        let was_area = self.areas.iter().any(|(a, _)| *a == id);
        let Some(s) = self.slot_mut(id) else { return };
        match s.native.nsh() {
            Some(view) => view.set_props(props, &control),
            None => {
                // Scroll views and inputs: only what UIKit offers directly.
                use objc2_ui_kit::{NSObjectUIAccessibility, UIAccessibilityIdentification};
                let view = s.native.view();
                let test_id = props
                    .test_id
                    .as_deref()
                    .map(objc2_foundation::NSString::from_str);
                view.setAccessibilityIdentifier(test_id.as_deref());
                let label = props
                    .accessibility
                    .label
                    .as_deref()
                    .map(objc2_foundation::NSString::from_str);
                view.setAccessibilityLabel(label.as_deref(), mtm);
                view.setAccessibilityElementsHidden(props.accessibility.hidden, mtm);
            }
        }
        // After the props: the texts below read whether they are in an area.
        match (area, was_area) {
            (Some(view), false) => self
                .areas
                .push((id, crate::selection_area::AreaResponder::attach(&view, mtm))),
            (None, true) => {
                if let Some(i) = self.areas.iter().position(|(a, _)| *a == id) {
                    self.areas.remove(i).1.detach();
                }
            }
            _ => {}
        }
    }

    /// Only the label of the view's props changed.
    fn set_accessibility_label(&mut self, id: NodeId, label: Option<std::sync::Arc<str>>) {
        let mtm = self.mtm;
        let Some(s) = self.slot(id) else { return };
        match s.native.nsh() {
            Some(view) => view.set_accessibility_label(label),
            None => {
                use objc2_ui_kit::NSObjectUIAccessibility;
                let label = label.as_deref().map(objc2_foundation::NSString::from_str);
                s.native.view().setAccessibilityLabel(label.as_deref(), mtm);
            }
        }
    }

    /// A finger went down on (or left) a pressable view.
    pub(crate) fn press_changed(&mut self, id: NodeId, pressed: bool, at: PressAt) {
        self.report_state(id, nsh_core::tailwind::state::PRESSED, pressed);
        let Some(s) = self.slot(id) else { return };
        let event = if pressed {
            EventKind::PressDown
        } else {
            EventKind::PressUp
        };
        if s.events.contains(event) {
            let payload = self.press_payload(id, at);
            self.control.dispatch_event(id, event, payload);
        }
    }

    /// A press event on pressable text span `node` of text view `view`.
    pub(crate) fn link_event(&mut self, node: NodeId, kind: EventKind, view: NodeId, at: PressAt) {
        let payload = self.press_payload(view, at);
        self.control.dispatch_event(node, kind, payload);
    }

    /// The payload of a press on view `id` (for a text's span, its text's
    /// view).
    fn press_payload(&self, id: NodeId, at: PressAt) -> EventPayload {
        let Some(view) = self.slot(id).map(|s| s.native.view().retain()) else {
            return EventPayload::None;
        };
        let (position, page_position) = self.pointer_positions(&view, at.in_window);
        EventPayload::Press(nsh_core::PressEvent {
            position,
            page_position,
            modifiers: key_modifiers(at.modifiers),
            clicks: at.clicks,
        })
    }

    /// Presses the element the app put in the trailing header slot, as a tap
    /// on a system bar button does: the first view inside the slot that
    /// takes a press (the one made first), resolved now (the slot's content
    /// arrives after the button is made). A slot with none takes no press.
    pub(crate) fn press_trailing_header(&mut self, screen: NodeId) {
        let Some(Slot {
            native: Native::Screen(host),
            ..
        }) = self.slot(screen)
        else {
            return;
        };
        let Some(slot_node) = host.config.right else {
            return;
        };
        let Some(container) = self.slot(slot_node).map(|s| s.native.view().retain()) else {
            return;
        };
        let mut found = None;
        for (index, slot) in self.views.iter().enumerate() {
            let Some(slot) = slot else { continue };
            if !slot.events.contains(EventKind::Press) {
                continue;
            }
            let id = index as NodeId;
            if let Some(view) = self.slot(id).map(|s| s.native.view().retain())
                && view != container
                && view.isDescendantOfView(&container)
            {
                found = Some(id);
                break;
            }
        }
        if let Some(node) = found {
            self.control
                .dispatch_event(node, EventKind::Press, EventPayload::None);
        }
    }

    /// The finger lifted on a pressable view.
    pub(crate) fn pressed(&mut self, id: NodeId, at: PressAt) {
        if let Some(s) = self.slot(id)
            && s.events.contains(EventKind::Press)
        {
            let payload = self.press_payload(id, at);
            self.control.dispatch_event(id, EventKind::Press, payload);
        }
    }

    /// A press was held for half a second.
    pub(crate) fn long_pressed(&mut self, id: NodeId, at: PressAt) {
        if let Some(s) = self.slot(id)
            && s.events.contains(EventKind::LongPress)
        {
            let payload = self.press_payload(id, at);
            self.control
                .dispatch_event(id, EventKind::LongPress, payload);
        }
    }

    /// Whether a drag on view `id` moving at `velocity` may start: a pan
    /// with only a horizontal (or vertical) value waits for a mostly
    /// horizontal (vertical) movement, so it coexists with scrolling.
    pub(crate) fn pan_should_begin(&self, id: NodeId, velocity: CGPoint) -> bool {
        let Some(s) = self.slot(id) else { return true };
        match (s.values.pan_x.is_some(), s.values.pan_y.is_some()) {
            (true, false) => velocity.x.abs() > velocity.y.abs(),
            (false, true) => velocity.y.abs() > velocity.x.abs(),
            _ => true,
        }
    }

    /// A cooperating pan sees only scrolls between its view and the touch,
    /// never a scroll elsewhere in the sheet or behind its backdrop.
    pub(crate) fn pan_touch(&mut self, id: NodeId, touched: &UIView) {
        let Some(s) = self.slot_mut(id) else { return };
        s.pan_scroll = None;
        if !s.pan_scroll_handoff {
            return;
        }
        let panel = s.native.view();
        let mut current = Some(touched.retain());
        while let Some(view) = current {
            if &*view == panel {
                break;
            }
            if let Some(scroll) = view.downcast_ref::<UIScrollView>()
                && scroll.isScrollEnabled()
                && (scroll.contentSize().height > scroll.bounds().size.height
                    || scroll.alwaysBounceVertical())
            {
                s.pan_scroll = Some(PanScroll {
                    view: scroll.retain(),
                    offset: (scroll.contentOffset().y + scroll.adjustedContentInset().top).max(0.0)
                        as f32,
                });
                break;
            }
            current = view.superview();
        }
    }

    /// Sharing is restricted to the touched descendant's scroll pan.
    pub(crate) fn pan_shares_scroll(
        &self,
        pan: &UIGestureRecognizer,
        other: &UIGestureRecognizer,
    ) -> bool {
        let Some(view) = pan.view() else { return false };
        let Some(s) = self.slot(view.tag() as NodeId) else {
            return false;
        };
        s.pan_scroll_handoff
            && s.gestures
                .pan
                .as_deref()
                .is_some_and(|own| std::ptr::eq(own as &UIGestureRecognizer, pan))
            && s.pan_scroll.as_ref().is_some_and(|scroll| {
                std::ptr::eq(
                    &*scroll.view.panGestureRecognizer() as &UIGestureRecognizer,
                    other,
                )
            })
    }

    /// Keep the native scroll at its top while the panel consumes the
    /// remaining drag. This also prevents rubber banding under the panel.
    pub(crate) fn pan_scroll_offset(&self, scroll: &UIScrollView, offset: CGPoint) -> CGPoint {
        let mut current = scroll.superview();
        while let Some(view) = current {
            if let Some(s) = self.slot(view.tag() as NodeId)
                && s.pan_scroll_handoff
                && let Some(touched) = &s.pan_scroll
                && &*touched.view == scroll
                && let Some(pan) = &s.gestures.pan
                && (matches!(
                    pan.state(),
                    UIGestureRecognizerState::Began | UIGestureRecognizerState::Changed
                ) || pan.state() == UIGestureRecognizerState::Ended && scroll.isDragging())
            {
                let t = pan.translationInView(view.superview().as_deref());
                if s.gesture_start[1] + t.y as f32 > touched.offset {
                    return CGPoint::new(offset.x, -scroll.adjustedContentInset().top);
                }
            }
            current = view.superview();
        }
        offset
    }

    /// A drag on a view: moves its pan values natively and reports start
    /// and end (with velocity) to JS.
    pub(crate) fn pan(
        &mut self,
        id: NodeId,
        state: UIGestureRecognizerState,
        t: CGPoint,
        v: CGPoint,
    ) {
        let Some(s) = self.slot(id) else { return };
        let (values, events) = (s.values, s.events);
        let payload = |m: &Self| {
            if state == UIGestureRecognizerState::Cancelled {
                EventPayload::PanCancelled {
                    translation: point(Points(t.x as f32), Points(t.y as f32)),
                    velocity_x: v.x as f32,
                    velocity_y: v.y as f32,
                    value_x: values.pan_x.map(|n| Points(m.animator.value(n))),
                    value_y: values.pan_y.map(|n| Points(m.animator.value(n))),
                }
            } else {
                EventPayload::Pan {
                    translation: point(Points(t.x as f32), Points(t.y as f32)),
                    velocity_x: v.x as f32,
                    velocity_y: v.y as f32,
                    value_x: values.pan_x.map(|n| Points(m.animator.value(n))),
                    value_y: values.pan_y.map(|n| Points(m.animator.value(n))),
                }
            }
        };
        if state == UIGestureRecognizerState::Began {
            // Grabbing an animating value stops it where it is.
            let x = values.pan_x.map_or(0.0, |n| self.animator.value(n));
            let y = values.pan_y.map_or(0.0, |n| self.animator.value(n));
            if let Some(s) = self.slot_mut(id) {
                (s.gesture_start[0], s.gesture_start[1]) = (x, y);
            }
            if events.contains(EventKind::PanStart) {
                self.control
                    .dispatch_event(id, EventKind::PanStart, payload(self));
            }
        }
        if matches!(
            state,
            UIGestureRecognizerState::Began | UIGestureRecognizerState::Changed
        ) {
            let start = self.slot(id).map_or([0.0; 4], |s| s.gesture_start);
            if let Some(n) = values.pan_x {
                self.animator.set(n, start[0] + t.x as f32);
            }
            if let Some(n) = values.pan_y {
                let y = self
                    .slot(id)
                    .and_then(|s| s.pan_scroll.as_ref())
                    .map_or(start[1] + t.y as f32, |scroll| {
                        (start[1] + t.y as f32 - scroll.offset).max(0.0)
                    });
                self.animator.set(n, y);
                if let Some(scroll) = self.slot(id).and_then(|s| s.pan_scroll.as_ref()) {
                    let offset = scroll.view.contentOffset();
                    let clamped = self.pan_scroll_offset(&scroll.view, offset);
                    if clamped != offset {
                        scroll.view.setContentOffset(clamped);
                    }
                }
            }
            self.apply_animations();
        }
        if matches!(
            state,
            UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled
        ) && events.contains(EventKind::PanEnd)
        {
            self.control
                .dispatch_event(id, EventKind::PanEnd, payload(self));
        }
        self.report_finished();
    }

    /// A pinch (`rotation` false, `amount` the scale) or a two-finger
    /// rotation (`amount` in radians) on a view.
    pub(crate) fn transform_gesture(
        &mut self,
        id: NodeId,
        rotation: bool,
        state: UIGestureRecognizerState,
        amount: f64,
        velocity: f64,
    ) {
        let Some(s) = self.slot(id) else { return };
        let (node, events) = if rotation {
            (s.values.rotation, s.events)
        } else {
            (s.values.pinch, s.events)
        };
        let slot_index = if rotation { 3 } else { 2 };
        // Degrees for rotations, like `transform: [{ rotate }]`.
        let (amount, velocity) = if rotation {
            (amount.to_degrees(), velocity.to_degrees())
        } else {
            (amount, velocity)
        };
        let (start_event, end_event, key) = if rotation {
            (EventKind::RotationStart, EventKind::RotationEnd, "rotation")
        } else {
            (EventKind::PinchStart, EventKind::PinchEnd, "scale")
        };
        let payload = || {
            EventPayload::Map(vec![
                (key, PayloadValue::Number(amount)),
                ("velocity", PayloadValue::Number(velocity)),
            ])
        };
        if state == UIGestureRecognizerState::Began {
            let start = node.map_or(if rotation { 0.0 } else { 1.0 }, |n| self.animator.value(n));
            if let Some(s) = self.slot_mut(id) {
                s.gesture_start[slot_index] = start;
            }
            if events.contains(start_event) {
                self.control.dispatch_event(id, start_event, payload());
            }
        }
        if matches!(
            state,
            UIGestureRecognizerState::Began | UIGestureRecognizerState::Changed
        ) && let Some(n) = node
        {
            let start = self.slot(id).map_or(0.0, |s| s.gesture_start[slot_index]);
            let value = if rotation {
                start + amount as f32
            } else {
                start * amount as f32
            };
            self.animator.set(n, value);
            self.apply_animations();
        }
        if matches!(
            state,
            UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled
        ) && events.contains(end_event)
        {
            self.control.dispatch_event(id, end_event, payload());
        }
        self.report_finished();
    }

    /// JS waits for a display frame (`requestAnimationFrame`).
    pub(crate) fn request_frame(&self) {
        self.frame_link.setPaused(false);
    }

    /// The frame link fired.
    pub(crate) fn frame(&self) {
        self.frame_link.setPaused(true);
        self.control.frame();
    }

    /// Fades or grows in the views a layout animation created.
    fn animate_appearing(&mut self, animation: &LayoutAnimation) {
        let Some(t) = animation.create else { return };
        for &id in &self.created {
            let Some(s) = self.slot(id) else { continue };
            let view = s.native.view();
            if view.superview().is_none() {
                continue;
            }
            match t.property {
                LayoutProperty::Opacity => view.setAlpha(0.0),
                LayoutProperty::Scale => view
                    .layer()
                    .setTransform(scaled_transform(&view.layer().transform(), 0.01)),
            }
            let (target, alpha, transform) = (
                view.retain(),
                dynamic_opacity(s, &self.animator) as CGFloat,
                dynamic_transform(s, &self.animator),
            );
            animate(&t, self.keyboard_motion, view, self.mtm, move || {
                target.setAlpha(alpha);
                target.layer().setTransform(transform);
            });
        }
    }

    /// The removal animation of view `id` finished.
    pub(crate) fn disappeared(&mut self, id: NodeId) {
        if self.disappearing.remove(&id)
            && let Some(s) = self.slot(id)
        {
            let view = s.native.view();
            view.removeFromSuperview();
            view.layer().removeAllAnimations();
            apply_dynamic(s, &self.animator);
        }
    }

    fn set_refreshing(&mut self, id: NodeId, on: bool) {
        let mtm = self.mtm;
        let Some(s) = self.slot_mut(id) else { return };
        let Native::Scroll(scroll) = &s.native else {
            return;
        };
        match &mut s.gestures.refresh {
            Some(Refresh::Native(control)) if control.isRefreshing() != on => {
                if on {
                    control.beginRefreshing();
                } else {
                    control.endRefreshing();
                }
            }
            Some(Refresh::Custom {
                spinner,
                refreshing,
                reveal_pending,
            }) if *refreshing != on => {
                *refreshing = on;
                reveal_pending.set(on);
                let mut inset = scroll.contentInset();
                let base = s
                    .behavior
                    .as_ref()
                    .map_or(0.0, |b| b.content_inset.top.0 as CGFloat);
                inset.top = base + if on { REFRESH_INSET } else { 0.0 };
                if on {
                    spinner.startAnimating();
                    scroll.setContentInset(inset);
                    // Reveal the spinner if the list is at the top. On the
                    // next turn: a release past the top has already started
                    // its bounce towards the old inset, which this replaces.
                    let scroll = MainThreadBound::new(scroll.clone(), mtm);
                    let pending = MainThreadBound::new(reveal_pending.clone(), mtm);
                    DispatchQueue::main().exec_async(move || {
                        let mtm = MainThreadMarker::new().expect("main queue");
                        if !pending.get(mtm).replace(false) {
                            return;
                        }
                        let scroll = scroll.get(mtm);
                        let offset = scroll.contentOffset();
                        if offset.y <= 0.0 && !scroll.isDragging() {
                            scroll.setContentOffset_animated(
                                CGPoint::new(offset.x, -REFRESH_INSET),
                                true,
                            );
                        }
                    });
                } else {
                    spinner.stopAnimating();
                    let scroll = scroll.clone();
                    let block = block2::RcBlock::new(move || scroll.setContentInset(inset));
                    UIView::animateWithDuration_animations(0.25, &block, mtm);
                }
            }
            _ => {}
        }
    }

    /// The user released a drag: a far enough pull past the top starts a
    /// custom (Mac idiom) refresh.
    pub(crate) fn drag_ended(&mut self, id: NodeId, offset: CGPoint) {
        let Some(s) = self.slot(id) else { return };
        if let Some(Refresh::Custom {
            refreshing: false, ..
        }) = s.gestures.refresh
            && offset.y <= -REFRESH_PULL
        {
            self.set_refreshing(id, true);
            self.control
                .dispatch_event(id, EventKind::Refresh, EventPayload::None);
        }
    }

    /// Brings a list's sticky cells above its other cells (the cells of a
    /// list in the scroll view's viewport are in that list, where the core
    /// keeps them on top).
    fn front_sticky(&self, list: NodeId) {
        let (Some(cells), Some(l)) = (self.sticky.get(&list), self.slot(list)) else {
            return;
        };
        let container = l.native.view();
        for c in cells {
            if let Some(s) = self.slot(c.cell)
                && s.native.view().superview().as_deref() == Some(container)
            {
                container.bringSubviewToFront(s.native.view());
            }
        }
    }

    /// Moves a list's sticky cells with its scroll offset: each one stays
    /// at the top of the viewport until the next pushes it out.
    fn pin_sticky(&self, list: NodeId) {
        let (Some(cells), Some(l)) = (self.sticky.get(&list), self.slot(list)) else {
            return;
        };
        let Native::Scroll(scroll) = &l.native else {
            return;
        };
        let offset = scroll.contentOffset();
        let offset = if l.horizontal { offset.x } else { offset.y } as f32;
        for c in cells {
            let Some(s) = self.slot(c.cell) else { continue };
            // An animated offset is the graph's (pinned again with its frames).
            let extra = c.offset.map_or(0.0, |n| self.animator.value(n));
            let t =
                (offset + extra - c.start.0).clamp(0.0, (c.end.0 - c.start.0).max(0.0)) as CGFloat;
            let (x, y) = if l.horizontal { (t, 0.0) } else { (0.0, t) };
            s.native
                .view()
                .layer()
                .setTransform(CATransform3D::new_translation(x, y, 0.0));
        }
    }

    /// A scroll view moved: feeds its scroll value in the same frame.
    /// Scroll view `id` zoomed: centers its content again (`centerContent`).
    pub(crate) fn zoomed(&mut self, id: NodeId) {
        if let Some(
            s @ Slot {
                native: Native::Scroll(scroll),
                ..
            },
        ) = self.slot(id)
            && s.centers()
            && let Some(zoom) = s.zoom_view()
        {
            crate::zoom::layout(scroll, &zoom, zoom.bounds().size, true);
        }
    }

    pub(crate) fn scrolled(&mut self, id: NodeId, offset: CGPoint) {
        let start = self.fps.is_some().then(Instant::now);
        self.follow_scroll(id, offset);
        if let (Some(fps), Some(start)) = (&self.fps, start) {
            fps.scrolled(start.elapsed());
        }
    }

    fn follow_scroll(&mut self, id: NodeId, offset: CGPoint) {
        self.pin_sticky(id);
        for (_, area) in &self.areas {
            area.scrolled();
        }
        let Some(s) = self.slot(id) else { return };
        if let Some(node) = s.scroll_value {
            let value = if s.horizontal { offset.x } else { offset.y };
            self.animator.set(node, value as f32);
            self.apply_animations();
            self.report_finished();
        }
    }

    /// Scroll view `id` came to rest (`onScrollEnd`).
    pub(crate) fn scroll_ended(&mut self, id: NodeId) {
        if let Some(node) = self.slot(id).and_then(|s| s.scroll_value) {
            self.animator.settle(node);
        }
    }

    /// Display link frame.
    pub(crate) fn tick(&mut self) {
        let start = self.fps.is_some().then(Instant::now);
        let changed = self.animator.tick();
        if changed {
            self.apply_animations();
        }
        self.report_finished();
        if let (Some(fps), Some(start)) = (&self.fps, start) {
            fps.ticked(start.elapsed(), changed);
        }
    }

    fn apply_animations(&mut self) {
        let animator = &self.animator;
        for &id in &self.animated {
            if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref) {
                apply_dynamic(s, animator);
            }
        }
        // Sticky cells that stick an animated value further in follow it.
        for (&id, cells) in &self.sticky {
            if cells.iter().any(|c| c.offset.is_some()) {
                self.pin_sticky(id);
            }
        }
    }

    fn report_finished(&mut self) {
        let finished = self.animator.take_finished();
        if !finished.is_empty() {
            self.control.animations_finished(finished);
        }
    }
}

impl Drop for Mounter {
    fn drop(&mut self) {
        // The link retains its target; invalidating breaks the cycle.
        self.frame_link.invalidate();
    }
}

/// The first scroll view in `view`'s subtree (breadth first).
fn first_scroll_view(view: &UIView) -> Option<Retained<UIScrollView>> {
    let mut queue = vec![view.retain()];
    while !queue.is_empty() {
        let mut next = Vec::new();
        for v in queue {
            for child in v.subviews().iter() {
                if let Ok(scroll) = child.clone().downcast::<UIScrollView>() {
                    return Some(scroll);
                }
                next.push(child);
            }
        }
        queue = next;
    }
    None
}

/// Adds or removes a gesture recognizer.
fn toggle<G: AsRef<UIGestureRecognizer>>(
    slot: &mut Option<Retained<G>>,
    wanted: bool,
    view: &UIView,
    make: impl FnOnce() -> Retained<G>,
) {
    match (slot.as_ref(), wanted) {
        (None, true) => {
            let recognizer = make();
            view.addGestureRecognizer((*recognizer).as_ref());
            *slot = Some(recognizer);
        }
        (Some(recognizer), false) => {
            view.removeGestureRecognizer((**recognizer).as_ref());
            *slot = None;
        }
        _ => {}
    }
}

/// The modifier keys of UIKeyModifierFlags.
fn key_modifiers(flags: isize) -> nsh_core::keymap::Modifiers {
    // UIKeyModifierShift, Control, Alternate, Command.
    let has = |bit: u32| flags & (1 << bit) != 0;
    nsh_core::keymap::Modifiers {
        ctrl: has(18),
        alt: has(19),
        shift: has(17),
        cmd: has(20),
    }
}

/// Sets a frame through `bounds` + `center`: `frame` is undefined for
/// transformed views, and a scroll view's bounds origin is its scroll
/// offset, which must be kept.
fn set_frame(view: &UIView, frame: Bounds<Points>) {
    let origin = view.bounds().origin;
    view.setBounds(CGRect::new(
        origin,
        CGSize::new(
            frame.size.width.0 as CGFloat,
            frame.size.height.0 as CGFloat,
        ),
    ));
    view.setCenter(CGPoint::new(
        (frame.origin.x.0 + frame.size.width.0 / 2.0) as CGFloat,
        (frame.origin.y.0 + frame.size.height.0 / 2.0) as CGFloat,
    ));
}

/// The opacity to show: the style's or its animated value.
fn dynamic_background(slot: &Slot, animator: &Animator) -> (Color, bool) {
    let mut background = slot.style.background_color;
    let mut animated = false;
    for &(prop, node) in &slot.bindings {
        if prop == AnimationProp::BackgroundColor {
            animated = true;
            if let AnimationValue::Color(c) = animator.eval(node) {
                background = Color(c);
            }
        }
    }
    (background, animated)
}

fn dynamic_opacity(slot: &Slot, animator: &Animator) -> f32 {
    let mut opacity = slot.style.opacity * crate::visual::filter_opacity(&slot.style);
    for &(prop, node) in &slot.bindings {
        if prop == AnimationProp::Opacity {
            opacity = animator.eval(node).number().clamp(0.0, 1.0);
        }
    }
    opacity
}

/// The transform list with animated entries, as a Core Animation matrix.
fn dynamic_transform(slot: &Slot, animator: &Animator) -> CATransform3D {
    let mut overrides = [None; nsh_core::MAX_TRANSFORMS];
    for &(prop, node) in &slot.bindings {
        if let AnimationProp::Transform(i) = prop
            && let Some(o) = overrides.get_mut(i as usize)
        {
            *o = Some(animator.eval(node).number());
        }
    }
    let mut m = slot.style.transform.matrix(|i| overrides[i]).0;
    // Mirrored lists flip first; their cells flip back last (row vectors).
    let mut flip = translation(0.0, 0.0, 0.0);
    flip[0] = -1.0;
    if slot.mirrored {
        m = mat_mul(&flip, &m);
    }
    if slot.in_mirrored {
        m = mat_mul(&m, &flip);
    }
    let origin = slot.style.transform_origin;
    if origin != nsh_core::TransformOrigin::CENTER {
        // Around the origin rather than the layer's center (its anchor):
        // to the origin, transform, and back (row vectors).
        let size = slot.native.view().bounds().size;
        let (d, dz) = origin.offset(nsh_core::geometry::size(
            Points(size.width as f32),
            Points(size.height as f32),
        ));
        let (dx, dy, dz) = (d.x.0 as CGFloat, d.y.0 as CGFloat, dz.0 as CGFloat);
        m = mat_mul(
            &mat_mul(&translation(-dx, -dy, -dz), &m),
            &translation(dx, dy, dz),
        );
    }
    CATransform3D {
        m11: m[0],
        m12: m[1],
        m13: m[2],
        m14: m[3],
        m21: m[4],
        m22: m[5],
        m23: m[6],
        m24: m[7],
        m31: m[8],
        m32: m[9],
        m33: m[10],
        m34: m[11],
        m41: m[12],
        m42: m[13],
        m43: m[14],
        m44: m[15],
    }
}

/// A translation matrix (row vectors, as Core Animation).
fn translation(x: CGFloat, y: CGFloat, z: CGFloat) -> [CGFloat; 16] {
    [
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        x, y, z, 1.0,
    ]
}

/// `a × b` of row-major 4×4 matrices.
fn mat_mul(a: &[CGFloat; 16], b: &[CGFloat; 16]) -> [CGFloat; 16] {
    let mut out = [0.0; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = (0..4).map(|k| a[r * 4 + k] * b[k * 4 + c]).sum();
        }
    }
    out
}

/// `t` scaled by `f` around the layer's center.
fn scaled_transform(t: &CATransform3D, f: CGFloat) -> CATransform3D {
    let mut out = *t;
    for v in [
        &mut out.m11,
        &mut out.m12,
        &mut out.m13,
        &mut out.m21,
        &mut out.m22,
        &mut out.m23,
    ] {
        *v *= f;
    }
    out
}

/// The style to shape a view's decoration by when its border or shadow is
/// bound: the bound values in place of the static ones, and the layers for
/// them made even while they are transparent (they may not stay so).
fn bound_style(slot: &Slot, animator: &Animator) -> Option<ViewStyle> {
    let decor = |p: &AnimationProp| {
        matches!(
            p,
            AnimationProp::BorderColor
                | AnimationProp::ShadowColor
                | AnimationProp::ShadowOpacity
                | AnimationProp::ShadowRadius
        )
    };
    if !slot.bindings.iter().any(|(p, _)| decor(p)) {
        return None;
    }
    let mut style = slot.style.clone();
    let (mut border, mut shadow) = (false, false);
    for &(prop, node) in &slot.bindings {
        let value = animator.eval(node);
        match (prop, value) {
            (AnimationProp::BorderColor, AnimationValue::Color(c)) => {
                style.borders.colors = [Color(c); 4];
                border = true;
            }
            (AnimationProp::ShadowColor, AnimationValue::Color(c)) => {
                style.shadow.color = Color(c);
                shadow = true;
            }
            (AnimationProp::ShadowOpacity, v) => {
                style.shadow.opacity = v.number().clamp(0.0, 1.0);
                shadow = true;
            }
            (AnimationProp::ShadowRadius, v) => {
                style.shadow.radius = Points(v.number().max(0.0));
                shadow = true;
            }
            _ => {}
        }
    }
    if border {
        for c in &mut style.borders.colors {
            c.0 |= 0xff;
        }
    }
    if shadow {
        style.shadow.color.0 |= 0xff;
        style.shadow.opacity = style.shadow.opacity.max(f32::MIN_POSITIVE);
    }
    Some(style)
}

/// Bound border colors and shadows onto the layers made for them.
fn apply_bound_decor(slot: &Slot, animator: &Animator) {
    let view = slot.native.view();
    let mut shadow = None;
    for &(prop, node) in &slot.bindings {
        let value = animator.eval(node);
        match (prop, value) {
            (AnimationProp::BorderColor, AnimationValue::Color(c)) => {
                slot.decor.set_border_color(view, Color(c))
            }
            (AnimationProp::ShadowColor, AnimationValue::Color(c)) => {
                shadow.get_or_insert(slot.style.shadow).color = Color(c)
            }
            (AnimationProp::ShadowOpacity, v) => {
                shadow.get_or_insert(slot.style.shadow).opacity = v.number()
            }
            (AnimationProp::ShadowRadius, v) => {
                shadow.get_or_insert(slot.style.shadow).radius = Points(v.number())
            }
            _ => {}
        }
    }
    if let Some(s) = shadow {
        slot.decor.set_shadow(view, s.color, s.opacity, s.radius.0);
    }
}

/// Opacity, background color and transform: static values overridden by
/// animated bindings.
fn apply_dynamic(slot: &Slot, animator: &Animator) {
    if let Native::Canvas(canvas) = &slot.native {
        canvas.set_values(slot.bindings.iter().filter_map(|&(prop, node)| match prop {
            AnimationProp::CanvasArg(k) => Some((k, animator.eval(node))),
            _ => None,
        }));
    }
    let view = slot.native.view();
    let mut background = slot.style.background_color;
    for &(prop, node) in &slot.bindings {
        if prop == AnimationProp::BackgroundColor
            && let AnimationValue::Color(c) = animator.eval(node)
        {
            background = Color(c);
        }
    }
    view.setAlpha(dynamic_opacity(slot, animator) as CGFloat);
    slot.decor.set_background(view, background);
    view.layer().setTransform(dynamic_transform(slot, animator));
    apply_bound_decor(slot, animator);
    if let Native::Text(text) = &slot.native {
        let color = slot.bindings.iter().find_map(|&(prop, node)| match prop {
            AnimationProp::Color => match animator.eval(node) {
                AnimationValue::Color(c) => Some(Color(c)),
                _ => None,
            },
            _ => None,
        });
        text.set_color(color);
    }
}

/// Runs `f` in a UIKit animation of `view` following `t`; on the
/// keyboard's curve, `keyboard` says how it moves.
fn animate(
    t: &LayoutTransition,
    keyboard: KeyboardMotion,
    view: &UIView,
    mtm: MainThreadMarker,
    f: impl Fn() + 'static,
) {
    let block = block2::RcBlock::new(f);
    let (duration, delay) = (t.duration_ms as f64 / 1000.0, t.delay_ms as f64 / 1000.0);
    let base = UIViewAnimationOptions::BeginFromCurrentState
        | UIViewAnimationOptions::AllowUserInteraction;
    match t.curve {
        // The keyboard's own spring, from when it started to move.
        LayoutCurve::Keyboard => keyboard.aligned(view, || {
            UIView::animateWithDuration_delay_options_animations_completion(
                duration,
                delay,
                keyboard.options(),
                &block,
                None,
                mtm,
            )
        }),
        LayoutCurve::Spring { damping } => {
            UIView::animateWithDuration_delay_usingSpringWithDamping_initialSpringVelocity_options_animations_completion(
                duration,
                delay,
                damping as CGFloat,
                0.0,
                base,
                &block,
                None,
                mtm,
            )
        }
        curve => {
            let curve = match curve {
                LayoutCurve::Linear => UIViewAnimationOptions::CurveLinear,
                LayoutCurve::EaseIn => UIViewAnimationOptions::CurveEaseIn,
                LayoutCurve::EaseOut => UIViewAnimationOptions::CurveEaseOut,
                _ => UIViewAnimationOptions::CurveEaseInOut,
            };
            UIView::animateWithDuration_delay_options_animations_completion(
                duration,
                delay,
                base | curve,
                &block,
                None,
                mtm,
            )
        }
    }
}

/// Fades or shrinks `view` out, then removes it (unless it came back).
fn disappear(
    view: &UIView,
    id: NodeId,
    t: &LayoutTransition,
    shared: SharedMounter,
    mtm: MainThreadMarker,
) {
    let target = view.retain();
    let property = t.property;
    let block = block2::RcBlock::new(move || match property {
        LayoutProperty::Opacity => target.setAlpha(0.0),
        LayoutProperty::Scale => target
            .layer()
            .setTransform(scaled_transform(&target.layer().transform(), 0.01)),
    });
    let done = block2::RcBlock::new(move |_finished: objc2::runtime::Bool| {
        if let Some(m) = shared
            .get(MainThreadMarker::new().expect("main"))
            .borrow_mut()
            .as_mut()
        {
            m.disappeared(id);
        }
    });
    UIView::animateWithDuration_delay_options_animations_completion(
        t.duration_ms as f64 / 1000.0,
        t.delay_ms as f64 / 1000.0,
        UIViewAnimationOptions::BeginFromCurrentState,
        &block,
        Some(&done),
        mtm,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A first mount's children arrive after the content size does; judged
    /// once they are in place, a row wider than the viewport keeps its width.
    #[test]
    fn a_row_wider_than_the_viewport_keeps_its_width() {
        assert_eq!(settled_content_width(320.0, 400.0, true), 400.0);
    }

    /// A width left behind by an earlier layout, with nothing inside reaching
    /// it, narrows to the viewport: the page would pan over nothing.
    #[test]
    fn a_stale_extent_narrows_to_the_viewport() {
        assert_eq!(settled_content_width(320.0, 500.0, false), 320.0);
    }

    /// A narrowed scroll view keeps the viewport while nothing reaches it, and
    /// takes the core's width back once a later batch widens a row. The core
    /// sends no new size for that batch, so the judgement is made again here.
    #[test]
    fn a_narrowed_view_takes_the_core_width_back_once_a_row_grows() {
        assert_eq!(narrowed_width(320.0, 500.0, false), 320.0);
        assert_eq!(narrowed_width(320.0, 500.0, true), 500.0);
    }

    /// A node switched to horizontal (or given a zoom view) is no longer
    /// judged: the width narrowed while it was vertical describes nothing it
    /// holds now, and giving 500 back to 600 points of horizontal content
    /// would leave the last 100 unreachable.
    #[test]
    fn a_scroll_view_that_stops_being_vertical_is_not_judged() {
        assert!(still_judged(false, false));
        assert!(!still_judged(true, false));
        assert!(!still_judged(false, true));
    }

    /// Content that fits is left alone.
    #[test]
    fn content_within_the_viewport_is_left_alone() {
        assert_eq!(settled_content_width(320.0, 100.0, false), 100.0);
    }

    /// The judgement reads the children's frames, so it only means anything
    /// after they are in place: the same scroll view keeps a 400pt row it was
    /// sent a size for before the row existed, and narrows a 500pt size over
    /// children that fit.
    #[test]
    fn the_judgement_reads_the_frames_that_are_in_place() {
        // No window is involved: frames and a content size only. UIKit still
        // wants the main thread, so this skips where the test thread is not
        // it (a plain `cargo test`) and runs under `nsh test`.
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("skipped: UIKit views need the main thread");
            return;
        };
        let scroll = UIScrollView::new(mtm);
        scroll.setFrame(CGRect::new(CGPoint::ZERO, CGSize::new(320.0, 200.0)));
        let row = UIView::new(mtm);
        scroll.addSubview(&row);

        // The content size arrived before the row's frame did.
        row.setFrame(CGRect::new(CGPoint::ZERO, CGSize::new(400.0, 50.0)));
        assert_eq!(
            settled_content_width(320.0, 400.0, reaches_beyond(&scroll, 320.5)),
            400.0
        );

        // A wider size over a row that fits: narrowed to the viewport.
        row.setFrame(CGRect::new(CGPoint::ZERO, CGSize::new(300.0, 50.0)));
        assert_eq!(
            settled_content_width(320.0, 500.0, reaches_beyond(&scroll, 320.5)),
            320.0
        );
    }
}
