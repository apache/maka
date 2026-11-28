//! Applies mount batches to UIKit views and owns the per-surface native
//! state: views, animation graph, image loads and gesture recognizers.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    sync::Arc,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_core::{
    Bounds, Color, Command, EventKind, EventMask, EventPayload, GestureValues, ImageSource,
    KeyboardDismissMode, LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition,
    MountBatch, MountItem, NodeId, PayloadValue, Points, ResizeMode, StickyCell, SubmitBehavior,
    ViewKind, ViewProps, ViewStyle,
    animation::{AnimationProp, AnimationValue},
    geometry::{DevicePixels, Size, point, size},
    shader::ShaderRole,
    time::Instant,
};
use nsh_engine::EngineControl;
use objc2::{
    ClassType, MainThreadMarker, MainThreadOnly, Message, rc::Retained, runtime::ProtocolObject,
    sel,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize, CGVector};
use objc2_quartz_core::{CAAnimation, CALayer, CAMediaTiming, CATransform3D};
use objc2_ui_kit::{
    UIActivityIndicatorView, UIActivityIndicatorViewStyle, UIControlEvents,
    UICubicTimingParameters, UIDevice, UIGestureRecognizer, UIGestureRecognizerState,
    UINavigationController, UIPanGestureRecognizer, UIPinchGestureRecognizer, UIRefreshControl,
    UIRotationGestureRecognizer, UIScrollView, UIScrollViewContentInsetAdjustmentBehavior,
    UIScrollViewKeyboardDismissMode, UISpringTimingParameters, UITraitEnvironment,
    UIUserInterfaceIdiom, UIView, UIViewAnimating, UIViewAnimationOptions,
    UIViewControllerTransitionCoordinator, UIViewControllerTransitionCoordinatorContext,
    UIViewPropertyAnimator,
};

use crate::{
    animation::Animator,
    decor::{self, Decor},
    image::{AssetBase, DecodedImage, ImageLoader, Request},
    input::Input,
    interaction::{CoverageAnimation, coverage_animation},
    native_view::NshView,
    navigation::{ModalHost, ScreenHost, StackHost},
    press::{PressAt, PressRecognizer},
    target::EventTarget,
    text_view::TextView,
    video::VideoHost,
    web::WebHost,
};

/// The mounter of a surface, reached on the main thread.
pub(crate) type MounterCell = MainThreadBound<RefCell<Option<Mounter>>>;
/// The mounter of one surface, shared with native callbacks.
pub(crate) type SharedMounter = Arc<MounterCell>;

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

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct InitialInputLayout {
    frame: Option<Bounds<Points>>,
    content: Option<Bounds<Points>>,
}

/// The geometry a new input receives later in this batch. Inputs are inserted
/// before layout emits their frame and content box, but UIKit may draw an
/// inserted text field immediately; creating it with this geometry keeps that
/// first draw from using zero text insets.
fn initial_input_layouts(items: &[MountItem]) -> rustc_hash::FxHashMap<NodeId, InitialInputLayout> {
    let mut inputs = rustc_hash::FxHashMap::default();
    for item in items {
        if let MountItem::Create {
            id,
            kind: ViewKind::Input,
        } = item
        {
            inputs.insert(*id, InitialInputLayout::default());
        }
    }
    if inputs.is_empty() {
        return inputs;
    }
    for item in items {
        let (id, frame, content) = match item {
            MountItem::Frame { id, frame } => (*id, Some(*frame), None),
            MountItem::InputContent { id, content } => (*id, None, Some(*content)),
            _ => continue,
        };
        if let Some(layout) = inputs.get_mut(&id) {
            layout.frame = frame.or(layout.frame);
            layout.content = content.or(layout.content);
        }
    }
    inputs
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

    /// The view `ref.focus()` / `ref.blur()` move the keyboard focus to, if
    /// it is one of the app's own views: inputs, embedded native views,
    /// screens, stacks and modals keep their own keys.
    fn focus_view(&self) -> Option<&NshView> {
        match self {
            Native::View(v)
            | Native::Image(v)
            | Native::HeaderItem(v)
            | Native::InputAccessory(v) => Some(v),
            Native::Text(v) => Some(v.as_super()),
            Native::Canvas(v) => Some(v.as_super()),
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
    /// Reports `hover:` and the mouse events (pointers): `onMouseEnter`,
    /// `onMouseMove`, `onMouseLeave`.
    hover: Option<Retained<objc2_ui_kit::UIHoverGestureRecognizer>>,
    /// `onContextMenu`: secondary clicks (iPad pointers, Mac Catalyst's
    /// mouse).
    context: Option<Retained<objc2_ui_kit::UITapGestureRecognizer>>,
    /// `cursor`: the pointer's look.
    pointer: Option<Retained<objc2_ui_kit::UIPointerInteraction>>,
    pan: Option<Retained<UIPanGestureRecognizer>>,
    pinch: Option<Retained<UIPinchGestureRecognizer>>,
    rotation: Option<Retained<UIRotationGestureRecognizer>>,
    /// `onFileDrop`: a `UIDropInteraction` ([`crate::file_drop`]).
    file_drop: Option<Retained<objc2::runtime::AnyObject>>,
    /// `panActivation`.
    gate: Option<Retained<crate::touch::PanGate>>,
    refresh: Option<Refresh>,
}

/// The scroll view touched inside a cooperating pan. Its starting offset
/// is consumed before the panel moves, including within one continuous drag.
struct PanScroll {
    view: Retained<UIScrollView>,
    offset: f32,
    /// `onPanStart` went out: it waits for the panel to move, so scrolling
    /// alone does not start a sheet's drag (which ends editing).
    started: bool,
}

/// Pull-to-refresh. `UIRefreshControl` throws under Mac Catalyst's Mac
/// idiom, and cannot give way to the app's own indicator, so there (and
/// when the app draws its own) the pull is detected in the scroll delegate
/// and shown with a spinner (none for the app's indicator), revealed by a
/// content inset.
enum Refresh {
    Native(Retained<UIRefreshControl>),
    Custom {
        spinner: Option<Retained<UIActivityIndicatorView>>,
        refreshing: bool,
    },
}

/// Whether `refresh`, a scroll view's pull to refresh, is `control` itself
/// (not merely a control in the same place).
fn holds_refresh(refresh: Option<&Refresh>, control: &UIRefreshControl) -> bool {
    matches!(refresh, Some(Refresh::Native(held)) if std::ptr::eq(&**held, control))
}

/// A refresh control for scroll view `id`. It names its scroll view itself
/// ([`refresh_owner`]): UIKit may place it in a container of its own (iOS 26
/// under a large title), so its superview is not the scroll view.
fn refresh_control(id: NodeId, mtm: MainThreadMarker) -> Retained<UIRefreshControl> {
    let control = UIRefreshControl::new(mtm);
    control.setTag(id as isize);
    control
}

/// The scroll view refresh control `control` was made for
/// ([`refresh_control`]), wherever UIKit placed it.
pub(crate) fn refresh_owner(control: &UIRefreshControl) -> NodeId {
    control.tag() as NodeId
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

/// Where `view` is laid out in its window, as `convertRect:toView:nil` of
/// its bounds says without the layers' transforms. The keyboard is avoided
/// for where a view rests: a transform moves what is drawn, often for a
/// while (a sheet coming in as the keyboard rises moves its input by the
/// animator's frames), and measuring it mid-way would move the content up
/// by what the sheet itself is about to clear.
fn laid_out_in_window(view: &UIView) -> CGRect {
    // `center` and `bounds` are the layout's (`frame` follows the
    // transform); nsh keeps every layer's anchor at its middle.
    let offset = |v: &UIView| {
        let (center, bounds) = (v.center(), v.bounds());
        CGPoint::new(
            center.x - bounds.size.width / 2.0,
            center.y - bounds.size.height / 2.0,
        )
    };
    let size = view.bounds().size;
    let mut origin = offset(view);
    let mut parent = view.superview();
    // Up to the window, whose own place on the screen is not counted.
    while let Some(p) = parent.filter(|p| p.superview().is_some()) {
        let (at, scrolled) = (offset(&p), p.bounds().origin);
        origin.x += at.x - scrolled.x;
        origin.y += at.y - scrolled.y;
        parent = p.superview();
    }
    CGRect::new(origin, size)
}

/// Moves the content of `view` up by `shift` (through its bounds' origin,
/// so neither its frame nor a transform the app set changes) along
/// `motion`, the keyboard's.
fn set_pan(view: &UIView, shift: CGFloat, motion: KeyboardMotion, mtm: MainThreadMarker) {
    let target = view.retain();
    let block = block2::RcBlock::new(move || {
        let mut bounds = target.bounds();
        bounds.origin.y = shift;
        target.setBounds(bounds);
    });
    motion.aligned(view, || {
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

/// Sets the bottom inset of `scroll`'s content to `bottom` and of its
/// vertical indicator to `indicator` (the app's own insets plus the room
/// kept for the keyboard), and scrolls `reveal` (a rectangle in its
/// content) into view in one animation along `motion`, the keyboard's, so
/// that the content moves with the keyboard.
fn set_bottom_inset(
    scroll: &UIScrollView,
    bottom: CGFloat,
    indicator: CGFloat,
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
        indicators.bottom = indicator;
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

fn place_spinner(spinner: &UIActivityIndicatorView, width: f32, inset: Points) {
    spinner.setCenter(CGPoint::new(
        width as CGFloat / 2.0,
        -inset.0 as CGFloat / 2.0,
    ));
}

/// Where the content of `scroll` rests below its top edge: the app's top
/// inset `base` and what UIKit adds itself (a large title's bar), without
/// the room a refresh keeps.
fn rest_top(scroll: &UIScrollView, base: CGFloat) -> CGFloat {
    scroll.adjustedContentInset().top - scroll.contentInset().top + base
}

/// The room a refreshing scroll view keeps above its content.
fn refresh_inset(s: &Slot) -> Points {
    s.behavior
        .as_deref()
        .cloned()
        .unwrap_or_default()
        .refresh_inset()
}

struct Slot {
    native: Native,
    style: ViewStyle,
    decor: Decor,
    events: EventMask,
    /// The logical parent the core inserted this node in, for hardware-key
    /// ancestry even when the native view is hosted elsewhere (a screen, a
    /// modal, a header item).
    parent: Option<NodeId>,
    /// `ViewProps::key_capture`: the rule this node mounts for its focused
    /// descendants (not only `NshView`: a scroll view has one too).
    key_capture: nsh_core::KeyCapture,
    /// `ViewProps::accessibility.state.disabled`, for capture rules.
    disabled: bool,
    /// `ViewProps::key_parent`: the logical parent of a portaled view (an
    /// overlay's native Insert is at the root, not under its app parent).
    /// `None` uses the Insert parent.
    key_parent: Option<NodeId>,
    gestures: Gestures,
    bindings: Vec<(AnimationProp, nsh_core::animation::NodeId)>,
    values: GestureValues,
    /// Values of the gesture nodes when the gesture began: pan x, pan y,
    /// pinch, rotation.
    gesture_start: [f32; 4],
    pan_scroll_handoff: bool,
    pan_scroll: Option<PanScroll>,
    /// `panActivation`: the view's own pan starts as it activates.
    pan_activation: Option<nsh_core::PanActivation>,
    /// Where the finger of the view's own pan went down (window points),
    /// for `PanEvent::origin`.
    pan_down: CGPoint,
    /// `delayLongPress` (milliseconds).
    long_press_delay: Option<f32>,
    /// A horizontal list laid out right to left: mirrored as a whole.
    mirrored: bool,
    /// A cell of such a list: mirrored back.
    in_mirrored: bool,
    scroll_value: Option<nsh_core::animation::NodeId>,
    /// `pullValue` (vertical scroll views), with the distance it was last
    /// fed.
    pull_value: Option<nsh_core::animation::NodeId>,
    pull: CGFloat,
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
    /// The video poster's load in flight.
    poster_key: Option<String>,
    /// The image (not its placeholder) is shown.
    image_shown: bool,
    /// Interaction states the core wants reported (`tailwind::state`).
    tracked: u16,
    /// Current interaction states.
    states: u16,
    /// A style was applied before: a view's first style does not transition
    /// from the defaults, as in `nsh_core`'s `transition::restyle`.
    styled: bool,
    /// Its `UIScrollEdgeElementContainerInteraction`, while it names the
    /// scroll view it floats over (`crate::scroll_edge`).
    edge_element: Option<Retained<objc2::runtime::AnyObject>>,
    /// The scroll view and edge it names, counted in `Mounter::soft_edges`.
    edge_named: Option<(NodeId, nsh_core::ScrollEdge)>,
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
            parent: None,
            key_capture: nsh_core::KeyCapture::None,
            disabled: false,
            key_parent: None,
            gestures: Gestures::default(),
            bindings: Vec::new(),
            values: GestureValues::default(),
            gesture_start: [0.0; 4],
            pan_scroll_handoff: false,
            pan_scroll: None,
            pan_activation: None,
            pan_down: CGPoint::ZERO,
            long_press_delay: None,
            mirrored: false,
            in_mirrored: false,
            scroll_value: None,
            pull_value: None,
            pull: 0.0,
            behavior: None,
            horizontal: false,
            image: None,
            image_key: None,
            image_options: nsh_core::ImageOptions::default(),
            placeholder_key: None,
            poster_key: None,
            image_shown: false,
            tracked: 0,
            states: 0,
            styled: false,
            edge_element: None,
            edge_named: None,
        }
    }
}

/// The screen a stack showed when the app removed it
/// ([`Mounter::remove_hosted`]).
struct LeavingScreen {
    id: NodeId,
    /// Its `transitionShader`, unless less motion is asked for.
    shader: Option<nsh_core::NavShader>,
    animation: nsh_core::ScreenAnimation,
}

/// Applies mount batches to UIKit views. Main thread only.
pub(crate) struct Mounter {
    /// Indexed by node id (ids are dense).
    views: Vec<Option<Slot>>,
    /// The viewport the engine has laid out, which can lag UIKit's bounds.
    mounted_viewport: Size<Points>,
    /// First mounted child if it animates the backdrop, with its last
    /// eligible color. Animation frames never walk the UIKit hierarchy.
    animated_backdrop: Option<(NodeId, Option<Color>)>,
    /// The current backdrop candidate waiting for a finite native animation.
    backdrop_waiting: Option<NodeId>,
    /// Views with animated bindings, re-evaluated when values change.
    animated: Vec<NodeId>,
    /// Image views waiting for their frame before loading.
    pending_images: Vec<NodeId>,
    /// The display scale images were last requested at.
    image_scale: CGFloat,
    target: Retained<EventTarget>,
    animator: Animator,
    images: ImageLoader,
    /// `OffscreenCanvas` renders waiting for their images.
    offscreen: crate::canvas::Offscreen,
    /// The engine's sounds and players ([`crate::audio`]).
    audio: crate::audio::Speaker,
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
    /// The screen, modal or surface root whose content moved up to clear
    /// the keyboard (the focused input is in no scroll view), and by how
    /// much.
    panned: Option<(NodeId, CGFloat)>,
    /// The keyboard moved and the app's answer to it (a batch laying out
    /// what reads its height) may still come: the content moves once it
    /// came ([`Mounter::keyboard_settled`]).
    keyboard_pending: bool,
    /// Animates the frames, insertions and removals of the current batch.
    layout_animation: Option<LayoutAnimation>,
    /// Views created by the current batch (they appear, not move).
    created: Vec<NodeId>,
    /// Views fading out before their removal.
    disappearing: rustc_hash::FxHashSet<NodeId>,
    /// The scroll view edges views name (`ios={{ scrollEdgeElement }}`),
    /// with how many name each: soft while any does (`crate::scroll_edge`).
    soft_edges: Vec<(NodeId, nsh_core::ScrollEdge, u32)>,
    /// Display link for JS frame requests and pending native backdrops.
    frame_link: Retained<objc2_quartz_core::CADisplayLink>,
    frame_requested: Cell<bool>,
    /// Parents of screens, header items and modals (which are not
    /// subviews of their parent).
    hosts: rustc_hash::FxHashMap<NodeId, NodeId>,
    /// Stacks whose screens changed in the current batch.
    dirty_stacks: Vec<NodeId>,
    /// Views whose transform went back to the identity: the stacks inside
    /// them are laid out again ([`Mounter::lay_out_untransformed`]).
    untransformed: Vec<NodeId>,
    /// A retained tab changed visibility; sync the newly visible stack.
    bottom_bar_dirty: bool,
    /// Stacks whose screens changed during a push or pop transition: they
    /// catch up when it ends (UIKit breaks transitions that start while
    /// another one is running).
    deferred_stacks: Vec<NodeId>,
    /// The orientations the root was last given, until they are applied:
    /// after the batch's pushes and pops, and after any transition under
    /// way (a turn started during a push can make UIKit cancel the push).
    orientations: Option<u8>,
    /// Whether applying them waits for a transition to end.
    orientations_waiting: bool,
    /// Screens whose header changed in the current batch.
    dirty_headers: Vec<NodeId>,
    /// Screens whose header follows the scroll view under it
    /// (`headerBackgroundOnScroll`): checked after every batch, which may
    /// add, move or remove that scroll view.
    following_scroll: Vec<NodeId>,
    /// Modals to present or dismiss at the end of the current batch.
    dirty_modals: Vec<NodeId>,
    /// Every modal, with whether it was in the tree when last checked: a
    /// modal leaves with the subtree it is in, not when its node is
    /// released (a later batch), and comes back with it.
    modal_attached: Vec<(NodeId, bool)>,
    /// Views were inserted, removed or deleted in this batch: the modals
    /// are checked against the tree.
    tree_changed: bool,
    /// Modals the app shows that wait for a transition to end
    /// ([`navigation::transition_over`]): presented over a modal on its
    /// way out, they would go with it.
    waiting_modals: Vec<NodeId>,
    /// Modals dismissed since the last [`Mounter::finish_modals`], which a
    /// modal presented there waits for even before their transition
    /// starts.
    dismissed_now: Vec<NodeId>,
    /// Modals taken along by a dismissal under them, then hidden or
    /// deleted by the app: reported closed once that dismissal ends. With
    /// their controllers, which outlive a deleted modal's slot.
    closing_taken: Vec<(NodeId, Retained<crate::navigation::ModalController>)>,
    /// Where `asset:/` URIs of videos resolve.
    asset_base: Option<AssetBase>,
    /// Report touches to JS: on the root and on each modal's root.
    touch_trackers: Vec<(NodeId, Retained<crate::touch::TouchTracker>)>,
    /// Views listening to touches (the trackers run while there are any).
    touch_listeners: usize,
    /// The native gestures a JS responder keeps from taking its touches:
    /// the pans of the scroll views and the swipe back of the stacks around
    /// it.
    blocked_gestures: Vec<Retained<UIGestureRecognizer>>,
    /// Vertical scroll views whose content size arrived in this batch. Judge
    /// the final size once per view. A batch applies a scroll view's content
    /// size before the frames of the children it measures (`ScrollContent` is
    /// queued when the scroll view is, its children after it), so a size that
    /// looks too wide is only judged after the whole batch is in place.
    content_sizes: rustc_hash::FxHashSet<NodeId>,
    /// The core's width for every vertical scroll view the platform
    /// narrowed, by id. The core does not resend a content size it did not
    /// change, so a later batch that widens what such a scroll view holds has
    /// to give that width back from here.
    narrowed: Vec<(NodeId, CGFloat)>,
    /// Whether this batch moved any frame: nothing under a narrowed scroll
    /// view can have grown otherwise, so the judgement is skipped.
    frames_applied: bool,
    /// The surface lays out right to left: native controls mirror.
    rtl: bool,
    /// Sticky cells of lists, by list.
    sticky: rustc_hash::FxHashMap<NodeId, Vec<StickyCell>>,
    /// The native components the app registered.
    components: crate::component::Components,
    /// The scroll views the embedding app watches, by `nativeID`
    /// ([`crate::scroll_watch`]), and those of this surface it may watch.
    scroll_watchers: crate::ScrollWatchers,
    scrolls: crate::scroll_watch::SurfaceScrolls,
    /// Selectable views (`ViewProps::selectable_view`) and their selections.
    areas: Vec<(NodeId, Retained<crate::selectable_view::AreaResponder>)>,
    /// The performance monitor, while it measures ([`Mounter::measure`]).
    fps: Option<std::rc::Rc<crate::fps::Fps>>,
    /// Shader views and the GPU device they render with.
    shaders: crate::shader::Shaders,
    /// GPU views and the display link they render on.
    gpu: crate::gpu::SurfaceGpu,
    /// Texts whose color transitions.
    text_colors: crate::interaction::TextColors,
    /// The `transitionShader`s of pages and dialogs.
    nav_shaders: rustc_hash::FxHashMap<NodeId, nsh_core::NavShader>,
    /// The screen each stack showed when the app removed it: the app
    /// releases it in the same batch, before [`Mounter::finish_navigation`]
    /// changes the stack.
    leaving_screens: rustc_hash::FxHashMap<NodeId, LeavingScreen>,
    /// The tint of this surface's alerts and action sheets, from its
    /// tokens ([`crate::system::alert_tint`]).
    alert_tint: Option<nsh_core::element::AdaptiveColor>,
    /// The alerts shown and not answered yet (`Command::CloseDialog`).
    dialogs: crate::system::Dialogs,
    /// The surface's share sheet, which a new share replaces
    /// ([`crate::share`]).
    share: crate::share::Current,
    /// The sign-in session showing ([`crate::auth_session`]).
    auth_session: crate::auth_session::Current,
    /// `SplitView`s' splits, by their native component's node
    /// ([`crate::split`]).
    splits: rustc_hash::FxHashMap<NodeId, crate::split::SplitHost>,
    /// The app's address given to the system ([`crate::SurfaceOptions::handoff`]):
    /// `None` while the app has not opted in.
    handoff: Option<nsh_platform_apple::handoff::Activity>,
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
        let scrolls = crate::scroll_watch::SurfaceScrolls::default();
        let target = EventTarget::new(mtm, control.clone(), shared.clone(), scrolls.clone());
        let target_for_link = target.clone();
        let shaders = crate::shader::Shaders::new(&target_for_link, &shared);
        let mut views = Vec::with_capacity(256);
        views.resize_with(2, || None);
        root.setTag(nsh_core::ROOT_ID as isize);
        let mounted_viewport = viewport_size(root.bounds().size);
        views[nsh_core::ROOT_ID as usize] = Some(Slot::new(Native::Root(root)));
        Self {
            views,
            mounted_viewport,
            animated_backdrop: None,
            backdrop_waiting: None,
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
            offscreen: Default::default(),
            audio: Default::default(),
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
            panned: None,
            keyboard_pending: false,
            layout_animation: None,
            created: Vec::new(),
            disappearing: Default::default(),
            soft_edges: Vec::new(),
            frame_link: crate::animation::frame_link(&target_for_link),
            frame_requested: Cell::new(false),
            shaders,
            gpu: crate::gpu::SurfaceGpu::new(&target_for_link),
            text_colors: crate::interaction::TextColors::new(&target_for_link),
            nav_shaders: rustc_hash::FxHashMap::default(),
            leaving_screens: rustc_hash::FxHashMap::default(),
            alert_tint: None,
            dialogs: Default::default(),
            share: Default::default(),
            auth_session: Default::default(),
            hosts: Default::default(),
            dirty_stacks: Vec::new(),
            untransformed: Vec::new(),
            bottom_bar_dirty: false,
            deferred_stacks: Vec::new(),
            orientations: None,
            orientations_waiting: false,
            dirty_headers: Vec::new(),
            following_scroll: Vec::new(),
            dirty_modals: Vec::new(),
            modal_attached: Vec::new(),
            tree_changed: false,
            waiting_modals: Vec::new(),
            dismissed_now: Vec::new(),
            closing_taken: Vec::new(),
            asset_base: asset_base.clone(),
            sticky: Default::default(),
            touch_trackers: Vec::new(),
            touch_listeners: 0,
            blocked_gestures: Vec::new(),
            content_sizes: Default::default(),
            narrowed: Vec::new(),
            frames_applied: false,
            rtl: false,
            components,
            scroll_watchers: crate::ScrollWatchers::default(),
            scrolls,
            areas: Vec::new(),
            fps: None,
            splits: Default::default(),
            handoff: None,
            mtm,
        }
    }

    /// Gives the app's addresses to the system from now on
    /// ([`crate::SurfaceOptions::handoff`]).
    pub(crate) fn hand_off(&mut self) {
        self.handoff.get_or_insert_default();
    }

    /// Measures the surface's frames and commits with a performance
    /// monitor ([`crate::fps`]) from now on.
    pub(crate) fn measure(&mut self) {
        if self.fps.is_some() {
            return;
        }
        let fps = crate::fps::Fps::start(self.mtm);
        self.control.set_perf_monitor(Some(fps.monitor.clone()));
        self.fps = Some(fps);
    }

    /// Stops measuring ([`Mounter::measure`]).
    fn stop_measuring(&mut self) {
        if self.fps.take().is_some() {
            self.control.set_perf_monitor(None);
        }
    }

    pub(crate) fn apply(&mut self, batch: MountBatch) {
        let start = self.fps.is_some().then(Instant::now);
        self.apply_batch(batch);
        if let (Some(fps), Some(start)) = (&self.fps, start) {
            fps.drained(start.elapsed());
        }
    }

    fn apply_batch(&mut self, batch: MountBatch) {
        let initial_inputs = initial_input_layouts(&batch.items);
        let mut animation_changed = false;
        let mut backdrop_changed = false;
        for item in batch.items {
            backdrop_changed = backdrop_changed || self.affects_backdrop(&item);
            animation_changed |= self.apply_item(item, &initial_inputs);
        }
        if let Some(animation) = self.layout_animation.take() {
            self.animate_appearing(&animation);
        }
        self.created.clear();
        self.finish_navigation();
        self.apply_orientations();
        if backdrop_changed {
            self.animated_backdrop = None;
            self.backdrop_waiting = None;
        }
        if animation_changed {
            self.apply_animations();
        }
        self.lay_out_untransformed();
        self.report_finished();
        self.start_image_loads();
        for (_, area) in &self.areas {
            area.batch_applied();
        }
        self.focused_caret_moved();
        self.settle_content_sizes();
        // The app moved things: the focused input may be clear of the
        // keyboard now, or covered again. (Without focus, what moved stays
        // until the keyboard hides, to move back with it.)
        if !self.keyboard_pending && self.keyboard > 0.0 && self.focused.is_some() {
            self.pan_for_keyboard(self.keyboard_motion);
        }
        if backdrop_changed {
            self.follow_background();
        }
    }

    fn affects_backdrop(&self, item: &MountItem) -> bool {
        let id = match *item {
            MountItem::Insert { parent, child, .. } => {
                if parent == nsh_core::ROOT_ID {
                    return true;
                }
                child
            }
            MountItem::Remove { id }
            | MountItem::Delete { id }
            | MountItem::Frame { id, .. }
            | MountItem::AnimationBindings { id, .. }
            | MountItem::ViewStyle { id, .. } => id,
            _ => return false,
        };
        id == nsh_core::ROOT_ID
            || self
                .slot(id)
                .is_some_and(|s| s.parent == Some(nsh_core::ROOT_ID))
    }

    /// Keep the standalone backdrop in sync with the first mounted child
    /// when it paints the whole viewport, not with overlays above it.
    fn follow_background(&mut self) {
        let Some(root) = self.slot(nsh_core::ROOT_ID) else {
            return;
        };
        let view = root.native.view();
        let Some((controller, window)) = crate::app::RootController::for_surface(view) else {
            self.animated_backdrop = None;
            self.backdrop_waiting = None;
            return;
        };
        let viewport = view.bounds().size;
        if viewport_size(viewport) != self.mounted_viewport {
            return;
        }
        let candidate = root
            .decor
            .container(view)
            .subviews()
            .iter()
            .find_map(|view| {
                let id = view.tag() as NodeId;
                let slot = self.slot(id)?;
                (slot.parent == Some(nsh_core::ROOT_ID) && std::ptr::eq(slot.native.view(), &*view))
                    .then_some((id, slot))
            });
        let (color, waiting) = candidate.map_or((None, None), |(id, slot)| {
            let (color, pending) = backdrop_color(slot, viewport, &self.animator);
            (color, pending.then_some(id))
        });
        self.animated_backdrop = candidate
            .filter(|(_, slot)| {
                slot.bindings.iter().any(|(prop, _)| {
                    matches!(
                        prop,
                        AnimationProp::BackgroundColor
                            | AnimationProp::Opacity
                            | AnimationProp::Transform(_)
                    )
                })
            })
            .map(|(id, _)| (id, color));
        self.wait_for_backdrop(waiting);
        controller.set_backdrop(&window, color);
    }

    fn follow_animated_background(&mut self, id: NodeId, previous: Option<Color>) {
        let Some(root) = self.slot(nsh_core::ROOT_ID) else {
            return;
        };
        let view = root.native.view();
        let viewport = view.bounds().size;
        if viewport_size(viewport) != self.mounted_viewport {
            return;
        }
        let (color, pending) = self.slot(id).map_or((None, false), |slot| {
            backdrop_color(slot, viewport, &self.animator)
        });
        let owner = (color != previous)
            .then(|| crate::app::RootController::for_surface(view))
            .flatten();
        self.wait_for_backdrop(pending.then_some(id));
        if let Some((controller, window)) = owner {
            self.animated_backdrop = Some((id, color));
            controller.set_backdrop(&window, color);
        }
    }

    fn wait_for_backdrop(&mut self, candidate: Option<NodeId>) {
        if self.backdrop_waiting != candidate && candidate.is_some() {
            self.frame_link.setPaused(false);
        }
        self.backdrop_waiting = candidate;
    }

    pub(crate) fn resized(&mut self, viewport: Size<Points>) {
        self.mounted_viewport = viewport;
        self.follow_background();
    }

    /// Narrows the content size of a vertical scroll view to its width when
    /// nothing inside reaches past it — a stale extent left by an earlier
    /// layout makes the page pan sideways over nothing. Judged here, after
    /// the batch put every child's frame in place: a first mount sends the
    /// size before its children exist, and asking then would narrow a row
    /// that really is wider than the viewport.
    fn settle_content_sizes(&mut self) {
        let frames_applied = std::mem::take(&mut self.frames_applied);
        for id in std::mem::take(&mut self.content_sizes) {
            let mut narrowed = None;
            if let Some(slot) = self.slot(id)
                && let Native::Scroll(scroll) = &slot.native
                && still_judged(slot.horizontal, slot.zoom_view().is_some())
            {
                let viewport = scroll.bounds().size.width;
                let size = scroll.contentSize();
                let content = size.width;
                // Content that fits cannot be narrowed; walking the subtree
                // to learn that would cost the page on every batch.
                if viewport > 0.0 && content > viewport {
                    let width = settled_content_width(
                        viewport,
                        content,
                        reaches_beyond(scroll, viewport + 0.5),
                    );
                    if width != content {
                        scroll.setContentSize(CGSize::new(width, size.height));
                        narrowed = Some(content);
                    }
                }
            }
            self.narrowed.retain(|&(n, ..)| n != id);
            if let Some(width) = narrowed {
                self.narrowed.push((id, width));
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
            let (id, core) = self.narrowed[i];
            let mut done = true;
            if let Some(slot) = self.slot(id)
                && let Native::Scroll(scroll) = &slot.native
                && still_judged(slot.horizontal, slot.zoom_view().is_some())
            {
                let viewport = scroll.bounds().size.width;
                let reaches = reaches_beyond(scroll, viewport + 0.5);
                let width = narrowed_width(viewport, core, reaches);
                let size = scroll.contentSize();
                if width != size.width {
                    scroll.setContentSize(CGSize::new(width, size.height));
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

    /// Node `id`'s view (the root's window for the orientations;
    /// `nsh test --target ios`).
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

    /// How far scroll view `id` can still scroll back towards its start
    /// and on towards its end along its axis (`None`: it is no scroll
    /// view).
    #[cfg(feature = "dev")]
    pub(crate) fn scroll_room(&self, id: NodeId, horizontal: bool) -> Option<(CGFloat, CGFloat)> {
        let Native::Scroll(scroll) = &self.slot(id)?.native else {
            return None;
        };
        let inset = scroll.adjustedContentInset();
        let (offset, content, size) = (
            scroll.contentOffset(),
            scroll.contentSize(),
            scroll.bounds().size,
        );
        let (start, end) = if horizontal {
            (
                offset.x + inset.left,
                content.width + inset.right - size.width - offset.x,
            )
        } else {
            (
                offset.y + inset.top,
                content.height + inset.bottom - size.height - offset.y,
            )
        };
        Some((start.max(0.0), end.max(0.0)))
    }

    /// What the content insets of scroll view `id` keep clear at its start
    /// and its end along its axis, as UIKit adjusts them: the room kept for
    /// the keyboard and for a refresh, the app's own insets, and a large
    /// title's bar (`None`: it is no scroll view).
    #[cfg(feature = "dev")]
    pub(crate) fn scroll_insets(&self, id: NodeId, horizontal: bool) -> Option<(CGFloat, CGFloat)> {
        let Native::Scroll(scroll) = &self.slot(id)?.native else {
            return None;
        };
        let inset = scroll.adjustedContentInset();
        Some(if horizontal {
            (inset.left, inset.right)
        } else {
            (inset.top, inset.bottom)
        })
    }

    /// Whether `view` is inside one of the app's component elements: the
    /// app's own view (a `TabBar` draws its `UITabBar` there), not one
    /// UIKit draws over the app.
    #[cfg(feature = "dev")]
    pub(crate) fn in_component(&self, view: &UIView) -> bool {
        self.views.iter().flatten().any(|s| match &s.native {
            Native::Component(c) => view.isDescendantOfView(&c.container),
            _ => false,
        })
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

    /// Whether a native animation runs that ends by itself (not one
    /// looping forever, which no test step waits for).
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.animator.finishing()
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
    fn apply_item(
        &mut self,
        item: MountItem,
        initial_inputs: &rustc_hash::FxHashMap<NodeId, InitialInputLayout>,
    ) -> bool {
        match item {
            MountItem::Create { id, kind } => {
                let native = match kind {
                    ViewKind::View => Native::View(NshView::new(self.mtm)),
                    ViewKind::Text => Native::Text(TextView::new(self.mtm)),
                    ViewKind::Image => Native::Image(NshView::new(self.mtm)),
                    ViewKind::Input => {
                        let mut input = Box::new(Input::new(self.mtm, id, &self.target));
                        if let Some(initial) = initial_inputs.get(&id) {
                            if let Some(frame) = initial.frame {
                                set_frame(input.view(), frame);
                            }
                            if let Some(content) = initial.content {
                                input.set_content(content);
                            }
                        }
                        Native::Input(input)
                    }
                    ViewKind::Stack => {
                        Native::Stack(Box::new(StackHost::new(self.mtm, id, self.shared.clone())))
                    }
                    ViewKind::Screen => Native::Screen(Box::new(ScreenHost::new(
                        self.mtm,
                        id,
                        self.control.clone(),
                    ))),
                    ViewKind::Modal => {
                        Native::Modal(Box::new(ModalHost::new(self.mtm, id, self.control.clone())))
                    }
                    ViewKind::HeaderItem => Native::HeaderItem(NshView::new(self.mtm)),
                    ViewKind::InputAccessory => Native::InputAccessory(NshView::new(self.mtm)),
                    ViewKind::Canvas => Native::Canvas(crate::canvas::CanvasView::new(self.mtm)),
                    ViewKind::WebView => Native::Web(Box::new(WebHost::new(
                        self.mtm,
                        id,
                        self.control.clone(),
                        self.access.clone(),
                    ))),
                    ViewKind::Native => Native::Component(Box::new(
                        crate::component::ComponentHost::new(NshView::new(self.mtm)),
                    )),
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
                if modal {
                    self.modal_attached.push((id, false));
                    if self.touch_listeners > 0 {
                        self.add_touch_tracker(id);
                    }
                }
                if self.layout_animation.is_some() {
                    self.created.push(id);
                }
            }
            MountItem::Insert {
                parent,
                child,
                before,
            } => {
                if let Some(s) = self.slot_mut(child) {
                    s.parent = Some(parent);
                }
                self.tree_changed = true;
                if self.insert_hosted(parent, child, before) {
                    return false;
                }
                if self.disappearing.remove(&child)
                    && let Some(c) = self.slot(child)
                {
                    // Back before its removal finished animating.
                    c.native.view().layer().removeAllAnimations();
                    if apply_dynamic(c, &self.animator) {
                        self.untransformed.push(child);
                    }
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
                    // New cells must not cover the pinned ones.
                    self.front_sticky(parent);
                }
            }
            MountItem::Remove { id } => {
                if let Some(s) = self.slot_mut(id) {
                    s.parent = None;
                }
                self.tree_changed = true;
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
                // A focused view removed with its node leaves no first
                // responder; the root takes the keys back once the removal
                // is done and no other view took the focus.
                let restore = self
                    .views
                    .get(id as usize)
                    .and_then(Option::as_ref)
                    .and_then(|s| {
                        let view = s.native.view();
                        if !view.isFirstResponder() {
                            return None;
                        }
                        Some((self.root_view_of(view)?, view.window()?))
                    });
                self.remove_hosted(id);
                self.tree_changed = true;
                self.sticky.remove(&id);
                self.split_deleted(id);
                // A removal animation it was running ends with it: its end
                // must not find the id, which a new view may take.
                self.disappearing.remove(&id);
                self.target.scroll_deleted(id);
                self.scrolls.remove(&self.scroll_watchers, id);
                if let Some(i) = self.areas.iter().position(|(a, _)| *a == id) {
                    self.areas.remove(i).1.delete();
                }
                if let Some(mut s) = self.views.get_mut(id as usize).and_then(Option::take) {
                    // The scroll view edge it named, or its own named edges,
                    // go back to their automatic style.
                    self.edges_deleted(id, s.edge_named);
                    // A modal deleted while presented (the app closed it and
                    // released it, or released its subtree without a
                    // remove) goes away too, as on Android: through its
                    // shader (from the picture held when it was removed) or
                    // with its own motion, and its close is reported once
                    // it is gone. JS releases a node it removes at once:
                    // this is how a dialog the app closes goes.
                    if let Native::Modal(modal) = &mut s.native {
                        self.modal_attached.retain(|&(m, _)| m != id);
                        self.waiting_modals.retain(|&m| m != id);
                        // Taken along by a dismissal under it: reported
                        // closed once that one ends.
                        match modal.hidden_after_taken() {
                            Some(true) => self.control.dispatch_event(
                                id,
                                EventKind::Dismiss,
                                EventPayload::None,
                            ),
                            Some(false) => self.closing_taken.push((id, modal.controller.clone())),
                            None => {}
                        }
                        let changes = modal.changes(false);
                        let at_once = changes && self.dialog_overlay(id, false);
                        // The modals over it go with it: those the app
                        // still shows come back once it is gone.
                        if changes {
                            for above in modal.modals_above() {
                                if self.modal_mut(above).is_some_and(|m| m.dismissed_under()) {
                                    self.waiting_modals.push(above);
                                }
                            }
                        }
                        if changes {
                            self.dismissed_now.push(id);
                        }
                        let control = self.control.clone();
                        let shared = self.shared.clone();
                        modal.dismiss(at_once, move || {
                            control.dispatch_event(id, EventKind::Dismiss, EventPayload::None);
                            Self::present_waiting(&shared);
                        });
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
                let was_screen = self.shaders.draws_screen(id);
                self.shaders.remove(id);
                if was_screen {
                    self.release_root_effect();
                }
                self.gpu.deleted(id);
                self.nav_shaders.remove(&id);
                if let Some((root, window)) = restore {
                    self.target.restore_root_focus(root, window);
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
                    view.set_layout_size(CGSize::new(
                        frame.size.width.0 as CGFloat,
                        frame.size.height.0 as CGFloat,
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
                    if old.size.height != height {
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
                    if let Some(Refresh::Custom {
                        spinner: Some(spinner),
                        ..
                    }) = &s.gestures.refresh
                    {
                        place_spinner(spinner, frame.size.width.0, refresh_inset(s));
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
                if self.shaders.has(id) {
                    self.layout_shader(id);
                }
                self.layout_gpu(id);
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
                // The views alone: the texts' transitions are borrowed too.
                if let Some(Some(Slot {
                    native: Native::Text(view),
                    events,
                    style,
                    ..
                })) = self.views.get(id as usize)
                {
                    let links = !text.links.is_empty() || view.has_links();
                    let events = *events;
                    if let Some(old) = view.text() {
                        // Its color moves to the new one over the
                        // transition, drawn over the new lines.
                        self.text_colors.text_changed(view, &old, &text, style);
                    }
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
                pull_value,
                keyboard_dismiss,
                mirrored,
                ..
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
                    if let Some(s) = self.slot(id)
                        && apply_dynamic(s, &self.animator)
                    {
                        self.untransformed.push(id);
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
                    s.pull_value = pull_value.filter(|_| !horizontal);
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
                        self.content_sizes.insert(id);
                    }
                    self.scrolls.resized(id);
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
                    scroll.setScrollsToTop(b.scrolls_to_top);
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
                    if let Some(Refresh::Custom {
                        refreshing: true, ..
                    }) = s.gestures.refresh
                    {
                        inset.top += (b.refresh_inset().0 - refresh_inset(s).0) as CGFloat;
                    }
                    inset.left += new.left - old.left;
                    inset.bottom += new.bottom - old.bottom;
                    inset.right += new.right - old.right;
                    // UIKit keeps the offset when the inset changes: content
                    // resting at its start would end up under the new inset
                    // (a page's first rows under a header it scrolls under),
                    // or short of it. It rests at the new start instead.
                    let horizontal = s.horizontal;
                    let start = |scroll: &UIScrollView| {
                        let inset = scroll.adjustedContentInset();
                        if horizontal { -inset.left } else { -inset.top }
                    };
                    let along = |offset: CGPoint| if horizontal { offset.x } else { offset.y };
                    let at_start =
                        !scroll.isDragging() && along(scroll.contentOffset()) <= start(scroll);
                    scroll.setContentInset(inset);
                    if at_start && along(scroll.contentOffset()) != start(scroll) {
                        let mut offset = scroll.contentOffset();
                        if horizontal {
                            offset.x = start(scroll);
                        } else {
                            offset.y = start(scroll);
                        }
                        scroll.setContentOffset(offset);
                    }
                    // The indicators' insets by the same change, keeping the
                    // keyboard's room (`set_bottom_inset`) in the bottom one.
                    let old = ui_insets(
                        s.behavior
                            .as_ref()
                            .map(|b| b.scrollbar_inset)
                            .unwrap_or_default(),
                    );
                    let new = ui_insets(b.scrollbar_inset);
                    let moved = |mut i: objc2_ui_kit::UIEdgeInsets| {
                        i.top += new.top - old.top;
                        i.left += new.left - old.left;
                        i.bottom += new.bottom - old.bottom;
                        i.right += new.right - old.right;
                        i
                    };
                    scroll.setVerticalScrollIndicatorInsets(moved(
                        scroll.verticalScrollIndicatorInsets(),
                    ));
                    scroll.setHorizontalScrollIndicatorInsets(moved(
                        scroll.horizontalScrollIndicatorInsets(),
                    ));
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
                self.sync_refresh(id);
            }
            MountItem::Refreshing { id, refreshing } => self.set_refreshing(id, refreshing),
            MountItem::Canvas { id, drawing } => self.set_drawing(id, drawing),
            MountItem::ShaderTransition { id, duration } => {
                self.shaders.start_transition(id, duration);
            }
            MountItem::ShaderInput { id } => self.shaders.input_changed(id),
            MountItem::NavShader { id, shader } => match shader {
                Some(shader) => {
                    self.nav_shaders.insert(id, shader);
                }
                None => {
                    self.nav_shaders.remove(&id);
                }
            },
            MountItem::GpuView { id, source } => {
                let scale = self.display_scale();
                if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref) {
                    self.gpu.set(id, s.native.view(), &s.style, scale, source);
                    // Bindings that came before it, for the new renderer.
                    self.gpu.rebound(id, &s.bindings, &self.animator);
                }
            }
            MountItem::Shader { id, layer } => {
                let scale = self.display_scale();
                let was_screen = self.shaders.draws_screen(id);
                let role = layer.as_ref().map(|l| l.role);
                let mounted = layer.is_some();
                let screen = matches!(
                    role,
                    Some(ShaderRole::Screen | ShaderRole::ScreenTransition)
                );
                // The children it draws: its own (an effect's or a
                // transition's), or the root's (a screen's).
                let own = matches!(role, Some(ShaderRole::Effect | ShaderRole::Transition));
                let mut children = None;
                if let Some(s) = self.slot_mut(id) {
                    let view = s.native.view().retain();
                    children = s.decor.set_effect(&view, own);
                }
                let host = if screen {
                    let root = self.slot_mut(nsh_core::ROOT_ID);
                    root.map(|r| {
                        let view = r.native.view().retain();
                        children = r.decor.set_effect(&view, true);
                        view
                    })
                } else {
                    self.slot(id).map(|s| s.native.view().retain())
                };
                if let (Some(s), Some(host)) =
                    (self.views.get(id as usize).and_then(Option::as_ref), host)
                {
                    self.shaders
                        .set(id, &host, children, &s.style, scale, layer);
                    // No GPU: the app hears it (`shadersAvailable()`); the
                    // engine takes the first report only.
                    if mounted && self.shaders.without_device() {
                        self.control.shaders_unavailable();
                    }
                }
                if was_screen && !screen {
                    self.release_root_effect();
                }
                // Bindings that came before it.
                self.push_shader_args(id);
            }
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
                    if let Some(s) = self.slot(id)
                        && apply_dynamic(s, &self.animator)
                    {
                        self.untransformed.push(id);
                    }
                    self.push_shader_args(id);
                    // A component gets what is bound again.
                    if let Some(Some(s)) = self.views.get_mut(id as usize)
                        && let Native::Component(host) = &mut s.native
                    {
                        host.forget();
                        host.push(&s.bindings, &self.animator);
                    }
                    // A GPU view's renderer too.
                    if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref) {
                        self.gpu.rebound(id, &s.bindings, &self.animator);
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
                    let hides = config.hides_bottom_bar_when_pushed;
                    screen.config = *config;
                    // Before the push that shows it: `willShow` reads this the
                    // moment the screen goes on the stack.
                    screen.set_hides_bottom_bar(hides);
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
                let accessory = config.accessory.and_then(|a| match self.slot(a) {
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
            MountItem::Component { id, name }
                if &*name == nsh_core::platform::SPLIT_VIEW_COMPONENT =>
            {
                // NSH's own split: the mounter keeps it, as it does stacks.
                let split = crate::split::SplitHost::new(self.mtm, id, self.shared.clone());
                if let Some(Slot {
                    native: Native::Component(host),
                    ..
                }) = self.slot_mut(id)
                {
                    host.attach(Box::new(SplitHolder(split.holder.clone())));
                }
                self.splits.insert(id, split);
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
                // Bindings may have come first: the new component gets them.
                if let Some(Some(s)) = self.views.get_mut(id as usize)
                    && let Native::Component(host) = &mut s.native
                {
                    host.forget();
                    host.push(&s.bindings, &self.animator);
                }
            }
            MountItem::ComponentPropSlots { id, names } => {
                if !self.gpu.prop_slots(id, &names)
                    && let Some(Slot {
                        native: Native::Component(host),
                        ..
                    }) = self.slot_mut(id)
                {
                    host.bound.slots = names;
                    host.forget();
                }
            }
            MountItem::ComponentProps { id, props } if self.splits.contains_key(&id) => {
                if let Some(split) = self.splits.get_mut(&id) {
                    for (name, value) in &props {
                        split.set_prop(name, value.as_ref());
                    }
                }
            }
            MountItem::ComponentProps { id, props } => {
                if !self.gpu.props(id, &props)
                    && let Some(Slot {
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
            MountItem::TreeOrder(_) | MountItem::ProjectStates { .. } => {}
        }
        false
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
        if let Command::ClearSelection = command {
            let within = |mut inner: NodeId, outer: NodeId| loop {
                if inner == outer {
                    return true;
                }
                match self.slot(inner).and_then(|s| s.parent) {
                    Some(parent) => inner = parent,
                    None => return false,
                }
            };
            for (area_id, area) in &self.areas {
                if within(*area_id, id) || within(id, *area_id) {
                    area.clear();
                }
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
                | Command::Evaluate { .. }
                | Command::CancelEvaluate { .. }
                | Command::InjectJavaScript(_)
                | Command::PostMessage(_)
                | Command::Load(_)),
                Native::Web(web),
            ) => web.command(&c),
            (Command::WebViewRequest(request), Native::Web(web)) => web.web_request(&request),
            (Command::Seek(seconds), Native::Video(video)) => video.seek(seconds),
            (Command::Focus, Native::Input(input)) => {
                input.editor_view().becomeFirstResponder();
                crate::keyboard::request_focus(input.editor_view());
            }
            (Command::Blur, Native::Input(input)) => {
                input.editor_view().resignFirstResponder();
            }
            // `ref.focus()` / `ref.blur()` on a view that is not an input:
            // the keyboard focus moves to it as Tab does, if it is a stop.
            (Command::Focus, native) if id != nsh_core::ROOT_ID => {
                if let Some(view) = native.focus_view()
                    && view.becomeFirstResponder()
                {
                    crate::keyboard::request_focus(view);
                }
            }
            (Command::Blur, native) if id != nsh_core::ROOT_ID => {
                if let Some(view) = native.focus_view() {
                    view.resignFirstResponder();
                }
            }
            // On the root: whatever is focused, also in the modals this
            // surface presents (UIKit hosts them outside the root view). Not
            // the window's: that is the embedding app's too.
            (Command::Blur, native) if id == nsh_core::ROOT_ID => {
                native.view().endEditing(true);
                for slot in self.views.iter().flatten() {
                    if let Native::Modal(modal) = &slot.native
                        && modal.presented
                    {
                        modal.view.endEditing(true);
                    }
                }
                self.restore_root_focus();
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
            (Command::ScrollTo { y, animated, .. }, Native::Input(input)) => {
                input.scroll_to(y, animated);
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
                crate::system::show_dialog(
                    &dialog,
                    self.alert_tint,
                    native.view(),
                    &self.control,
                    &self.dialogs,
                );
            }
            (Command::CloseDialog(dialog), _) if id == nsh_core::ROOT_ID => {
                crate::system::close_dialog(&self.dialogs, dialog);
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
            (
                Command::FileRequest {
                    id: request_id,
                    request,
                },
                native,
            ) if id == nsh_core::ROOT_ID => match *request {
                nsh_core::file_dialog::FileRequest::OpenDialog(dialog) => {
                    crate::picker::pick_paths(request_id, dialog, native.view(), &self.control);
                }
                _ => self.control.dispatch_event(
                    nsh_core::ROOT_ID,
                    nsh_core::EventKind::FileRequest,
                    nsh_core::EventPayload::file_failed(request_id, "not supported on iOS"),
                ),
            },
            (Command::Notification(command), _) if id == nsh_core::ROOT_ID => {
                crate::notifications::command(&self.control, &command);
            }
            (
                Command::PickFiles {
                    id: request,
                    request: asked,
                },
                native,
            ) if id == nsh_core::ROOT_ID => {
                crate::picker::pick_files(request, asked, native.view(), &self.control);
            }
            (Command::AuthSession { id: request, page }, native) if id == nsh_core::ROOT_ID => {
                crate::auth_session::open(
                    request,
                    &page,
                    native.view(),
                    &self.auth_session,
                    &self.control,
                );
            }
            (Command::CloseAuthSession(request), _) if id == nsh_core::ROOT_ID => {
                crate::auth_session::close(request, &self.auth_session);
            }
            (Command::Share { id: request, sheet }, native) if id == nsh_core::ROOT_ID => {
                let anchor = sheet.anchor.and_then(|anchor| self.ui_view(anchor));
                crate::share::show(
                    request,
                    &sheet,
                    native.view(),
                    anchor.as_deref(),
                    &self.share,
                    &self.control,
                );
            }
            (
                Command::RenderCanvas {
                    id: request,
                    drawing,
                    width,
                    height,
                    scale,
                    format,
                },
                _,
            ) if id == nsh_core::ROOT_ID => {
                let display_scale = self.display_scale();
                self.offscreen.render(
                    crate::canvas::RenderRequest {
                        id: request,
                        drawing,
                        width,
                        height,
                        scale,
                        format,
                    },
                    &mut self.images,
                    display_scale,
                    &self.control,
                );
            }
            (Command::Audio(command), _) if id == nsh_core::ROOT_ID => {
                use nsh_core::image::loader::AssetBase as Base;
                let base = self.images.asset_base().map(|base| match base {
                    crate::image::AssetBase::Http(url) => Base::Http(url.clone()),
                    crate::image::AssetBase::Directory(dir) => Base::Directory(dir.clone()),
                });
                crate::audio::command(&self.audio, &self.control, &command, base.as_ref());
            }
            (Command::SetJsResponder { block }, _) => self.set_js_responder(id, block),
            (Command::SetSelection { start, end }, Native::Input(input)) => {
                input.select(start, end)
            }
            (Command::InsertText(text), Native::Input(input)) => input.insert_text(&text),
            (Command::OpenEditMenu { bounds, actions }, Native::Input(input)) => {
                let view = input.editor_view();
                let rect = CGRect::new(
                    CGPoint::new(bounds.origin.x.0.into(), bounds.origin.y.0.into()),
                    CGSize::new(bounds.size.width.0.into(), bounds.size.height.0.into()),
                );
                // The bounds are in the root view (the surface's, or the
                // modal's the input is in).
                let rect = match self.root_view_of(view) {
                    Some(root) => view.convertRect_fromView(rect, Some(&root)),
                    None => rect,
                };
                crate::input::open_edit_menu(view, rect, actions);
            }
            (Command::CloseEditMenu, Native::Input(input)) => {
                crate::input::close_edit_menu(input.editor_view())
            }
            (Command::ClearJsResponder, _) => self.clear_js_responder(),
            (Command::Announce(text), _) => crate::system::announce(&text),
            (Command::Haptic(haptic), _) => self.target.haptics().play(haptic, self.mtm),
            (Command::Orientations(bits), _) if id == nsh_core::ROOT_ID => {
                self.orientations = Some(bits);
            }
            (Command::SetAppUrl(url) | Command::PushAppUrl(url), _) if id == nsh_core::ROOT_ID => {
                if let Some(activity) = &mut self.handoff {
                    activity.publish(&url);
                }
            }
            (Command::PerfMonitor(true), _) => self.measure(),
            (Command::PerfMonitor(false), _) => self.stop_measuring(),
            (Command::Tokens(tokens), _) => self.alert_tint = crate::system::alert_tint(&tokens),
            (Command::TextLocale(locale), _) => self.target.set_text_locale(locale),
            (Command::ImageInfo { id, uri }, _) => self.images.info(id, &uri),
            (Command::SetClipboard(text), _) => crate::system::set_clipboard(&text),
            (Command::SetClipboardItem(item), _) => match &item.html {
                Some(html) => crate::system::set_clipboard_html(&item.text, html),
                None => crate::system::set_clipboard(&item.text),
            },
            (Command::OpenUrl { id, url }, _) => crate::system::open_url(id, &url, &self.control),
            (Command::OpenAppSettings { id }, _) => {
                crate::system::open_app_settings(id, &self.control)
            }
            (Command::ReadClipboard { id, has_only }, _) => {
                let (has, text, denied) = crate::system::read_clipboard(has_only);
                let mut fields = vec![
                    ("id", PayloadValue::Number(id as f64)),
                    ("has", PayloadValue::Bool(has)),
                ];
                if let Some(text) = text {
                    fields.push(("text", PayloadValue::Str(text)));
                }
                if denied {
                    fields.push(("denied", PayloadValue::Bool(true)));
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
                self.pan_for_keyboard(KeyboardMotion::now(0.25));
            }
        } else if self.focused == Some(id) {
            self.focused = None;
        }
        if !focused
            && let Some(view) = self.slot(id).map(|s| s.native.view().retain())
            && let Some(window) = view.window()
            && let Some(root) = self.root_view_of(&view)
        {
            // Another view or input may take the focus in this turn: the
            // target checks the window again then, and restores the root
            // only where no responder is left.
            self.target.restore_root_focus(root, window);
        }
    }

    /// The keyboard focus entered or left custom view `id`: its `focus:`
    /// styles follow (`onFocus` / `onBlur` are dispatched by the target).
    pub(crate) fn view_focused(&mut self, id: NodeId, focused: bool) {
        self.report_state(id, nsh_core::tailwind::state::FOCUSED, focused);
    }

    /// Whether `id` or a logical ancestor listens to raw key events or
    /// mounts a capture rule. Walks the core's ancestry, preferring a
    /// portaled node's `key_parent` over the native Insert parent, so a
    /// scroll view or any other managed node counts and an Overlay keeps
    /// its app parent. Stops at the modal's own window boundary as the
    /// core's bubbling does.
    pub(crate) fn listens_keys(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        let mut seen = rustc_hash::FxHashSet::default();
        while let Some(id) = current {
            if !seen.insert(id) {
                break;
            }
            let Some(slot) = self.slot(id) else { break };
            if slot.events.contains(EventKind::KeyDown)
                || slot.events.contains(EventKind::KeyUp)
                || !slot.key_capture.is_none()
            {
                return true;
            }
            if matches!(&slot.native, Native::Modal(_)) {
                break;
            }
            current = slot.key_parent.or(slot.parent);
        }
        false
    }

    /// Whether the enabled `id` or a logical ancestor captures `stroke`
    /// (the keymap's canonical keystroke) with its mounted `capture_keys`.
    pub(crate) fn captures_stroke(
        &self,
        id: NodeId,
        stroke: Option<&nsh_core::keymap::Keystroke>,
    ) -> bool {
        let mut current = Some(id);
        let mut seen = rustc_hash::FxHashSet::default();
        while let Some(id) = current {
            if !seen.insert(id) {
                break;
            }
            let Some(slot) = self.slot(id) else { break };
            if !slot.disabled && slot.key_capture.captures_key(stroke) {
                return true;
            }
            if matches!(&slot.native, Native::Modal(_)) {
                break;
            }
            current = slot.key_parent.or(slot.parent);
        }
        false
    }

    /// The native view whose subtree Tab walks from `view`: the modal view
    /// it is in, else the surface's root, so Tab never enters the stops a
    /// presented modal covers. `None` when the view is in neither.
    pub(crate) fn focus_scope(&self, view: &UIView) -> Option<Retained<UIView>> {
        let mut current: Option<Retained<UIView>> = Some(view.retain());
        while let Some(v) = current {
            let tag = v.tag();
            if tag > 0
                && let Some(slot) = self.slot(tag as NodeId)
                && matches!(&slot.native, Native::Modal(_) | Native::Root(_))
            {
                return Some(v);
            }
            current = v.superview();
        }
        None
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
        if height <= 0.0 {
            // Hiding: what moved up comes back down with the keyboard.
            self.avoid_keyboard(motion);
            self.pan_for_keyboard(motion);
        } else {
            // Showing: the app may make room for the keyboard itself, in
            // the batch it answers with ([`Mounter::keyboard_settled`]). A
            // scroll view it lifts above the keyboard (a panel padded by
            // the keyboard's height) needs no inset: measured before that
            // batch, it would keep one as tall as the keyboard and scroll
            // its content up for nothing.
            self.keyboard_pending = true;
        }
    }

    /// The engine handled the keyboard's change: the batch the app
    /// answered with, if any, is applied. What the keyboard still covers
    /// of the focused input's scroll view gets a bottom inset; if the
    /// input is in no scroll view and still under the keyboard, its
    /// content moves up.
    pub(crate) fn keyboard_settled(&mut self) {
        if std::mem::take(&mut self.keyboard_pending) {
            self.avoid_keyboard(self.keyboard_motion);
            self.pan_for_keyboard(self.keyboard_motion);
        }
    }

    /// Where the keyboard's top is, in window coordinates.
    fn keyboard_top(&self) -> Option<CGFloat> {
        let root = self.slot(nsh_core::ROOT_ID)?.native.view();
        // The bottom of the root's bounds: its origin moves when the root
        // itself is panned.
        let bounds = root.bounds();
        let bottom = root.convertPoint_toView(
            CGPoint::new(0.0, bounds.origin.y + bounds.size.height),
            None,
        );
        Some(bottom.y - self.keyboard as CGFloat)
    }

    /// The view that moves to keep input `id` clear of the keyboard when
    /// no scroll view holds it: its screen's or modal's content, else the
    /// surface's root (as Android's `adjustPan` moves the window).
    fn pan_container(&self, id: NodeId) -> Option<NodeId> {
        let mut view = self.slot(id)?.native.view().superview();
        while let Some(v) = view {
            if let Some(
                slot @ Slot {
                    native: Native::Screen(_) | Native::Modal(_) | Native::Root(_),
                    ..
                },
            ) = self.slot(v.tag() as NodeId)
                && std::ptr::eq::<UIView>(slot.native.view(), &*v)
            {
                return Some(v.tag() as NodeId);
            }
            view = v.superview();
        }
        Some(nsh_core::ROOT_ID)
    }

    /// Keeps the focused input clear of the keyboard when no scroll view
    /// holds it: moves the content of its screen (or modal, or the
    /// surface) up by what the keyboard still covers of it after the app
    /// laid out, with a margin, along `motion`; moves it back when the
    /// keyboard hides, the input loses focus, or the app made room itself.
    fn pan_for_keyboard(&mut self, motion: KeyboardMotion) {
        let target = self.focused.filter(|_| self.keyboard > 0.0).and_then(|id| {
            let Some(Slot {
                native: Native::Input(input),
                ..
            }) = self.slot(id)
            else {
                return None;
            };
            if self.scroll_around(id).is_some() {
                return None;
            }
            let container = self.pan_container(id)?;
            let view = self.slot(container)?.native.view();
            let rect = laid_out_in_window(input.editor_view());
            // Where it would be unmoved.
            let bottom = rect.origin.y + rect.size.height + view.bounds().origin.y;
            let margin = 12.0;
            let covered =
                (bottom + margin - self.keyboard_top()?).clamp(0.0, self.keyboard as CGFloat);
            Some((container, covered))
        });
        if let Some((previous, _)) = self.panned
            && target.is_none_or(|(id, _)| id != previous)
        {
            self.panned = None;
            if let Some(slot) = self.slot(previous) {
                set_pan(slot.native.view(), 0.0, motion, self.mtm);
            }
        }
        let Some((container, shift)) = target else {
            return;
        };
        let Some(slot) = self.slot(container) else {
            return;
        };
        let view = slot.native.view();
        if (view.bounds().origin.y - shift).abs() > 0.5 {
            set_pan(view, shift, motion, self.mtm);
        }
        self.panned = (shift > 0.0).then_some((container, shift));
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
            let (base, bar) = (
                self.base_inset(previous).bottom,
                self.base_bar_inset(previous).bottom,
            );
            set_bottom_inset(view, base, bar, None, motion, self.mtm);
        }
        let Some((scroll_id, scroll)) = scroll else {
            return;
        };
        if self.keyboard <= 0.0 {
            return;
        }
        if scroll.superview().is_none() {
            return;
        }
        // In window coordinates: the scroll view may be in a modal, which
        // is not inside the surface's root view.
        let frame = laid_out_in_window(&scroll);
        let Some(keyboard_top) = self.keyboard_top() else {
            return;
        };
        let covered = (frame.origin.y + frame.size.height - keyboard_top).max(0.0);
        let base = self.base_inset(scroll_id).bottom;
        let bar = self.base_bar_inset(scroll_id).bottom;
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
        set_bottom_inset(
            &scroll,
            base + covered,
            bar + covered,
            reveal,
            motion,
            self.mtm,
        );
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

    /// The `scrollbarInset` the app set on scroll view `id`.
    fn base_bar_inset(&self, id: NodeId) -> objc2_ui_kit::UIEdgeInsets {
        ui_insets(
            self.slot(id)
                .and_then(|s| s.behavior.as_ref())
                .map(|b| b.scrollbar_inset)
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
        // Ensure the root view and every modal still carry a tracker while
        // touches are listened to. Gating this on `touch_trackers.is_empty()`
        // left a modal opened after the first tracker set (the root's tracker
        // outlives every modal) without one, so a modal reopened later never
        // delivered its JS touch gestures. `add_touch_tracker` dedupes by
        // node, so re-ensuring here each time is idempotent.
        if on {
            self.add_touch_tracker(nsh_core::ROOT_ID);
            let modals: Vec<NodeId> = self.modal_attached.iter().map(|&(id, _)| id).collect();
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
            if let Some(c) = self.slot(id)
                && apply_dynamic(c, &self.animator)
            {
                self.untransformed.push(id);
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
    /// views around it stop scrolling and the stacks around it take no
    /// swipe back until it lets go, and the presses of the views around it
    /// end without a press (the finger is the responder's: a drag of a
    /// selection handle is no tap on the text).
    fn set_js_responder(&mut self, id: NodeId, block: bool) {
        self.clear_js_responder();
        if !block {
            return;
        }
        let Some(s) = self.slot(id) else { return };
        let mut current = s.native.view().superview();
        while let Some(v) = current {
            for recognizer in v.gestureRecognizers().iter().flat_map(|r| r.iter()) {
                if recognizer.downcast_ref::<PressRecognizer>().is_some() && recognizer.isEnabled()
                {
                    // Turning a recognizer off cancels its gesture.
                    recognizer.setEnabled(false);
                    recognizer.setEnabled(true);
                }
            }
            let scroll = v
                .downcast_ref::<UIScrollView>()
                .map(|scroll| Retained::into_super(scroll.panGestureRecognizer()));
            // A stack's view: its controller is the next responder.
            let swipes = v
                .nextResponder()
                .and_then(|r| r.downcast::<UINavigationController>().ok())
                .map(|nav| crate::navigation::back_swipes(&nav))
                .unwrap_or_default();
            for gesture in scroll.into_iter().chain(swipes) {
                if gesture.isEnabled() {
                    // Turning it off also cancels a gesture that began.
                    gesture.setEnabled(false);
                    self.blocked_gestures.push(gesture);
                }
            }
            current = v.superview();
        }
    }

    fn clear_js_responder(&mut self) {
        for gesture in self.blocked_gestures.drain(..) {
            gesture.setEnabled(true);
        }
    }

    /// Restore hardware-key delivery after a window or root-wide blur,
    /// including when the root itself was the only first responder.
    fn restore_root_focus(&self) {
        // A presented modal owns its responder scope, even with no input
        // focused. Do not route its keys to the background surface.
        if self
            .views
            .iter()
            .flatten()
            .any(|slot| matches!(&slot.native, Native::Modal(modal) if modal.presented))
        {
            return;
        }
        if let Some(root) = self.slot(nsh_core::ROOT_ID)
            && let Some(window) = root.native.view().window()
        {
            self.target
                .restore_root_focus(root.native.view().retain(), window);
        }
    }

    pub(crate) fn dismiss_keyboard(&self) {
        if let Some(root) = self.slot(nsh_core::ROOT_ID) {
            root.native.view().window().map(|w| w.endEditing(true));
        }
        self.restore_root_focus();
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
        if self
            .slot(id)
            .is_some_and(|s| s.style.hidden != style.hidden)
        {
            self.bottom_bar_dirty = true;
        }
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
        // Transitions apply to changes of a view already on screen, not to
        // its first style: there is nothing to transition from (`nsh_core`'s
        // `transition::restyle` and Android's mounter skip it the same way).
        let transition = style
            .transition
            .filter(|t| t.run_ms() > 0.0 && s.styled && view.window().is_some());
        if let Some(nsh) = s.native.nsh() {
            nsh.set_clip_path(style.clip_path().copied());
        }
        s.style = style;
        s.styled = true;
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
                    if let Some(s) = this.slot(id)
                        && apply_dynamic(s, &this.animator)
                    {
                        this.untransformed.push(id);
                    }
                });
            }
            None => {
                self.decorate(id);
                if let Some(s) = self.slot(id)
                    && apply_dynamic(s, &self.animator)
                {
                    self.untransformed.push(id);
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
        // Its corners clip the shader, or a GPU view's frames.
        if self.shaders.has(id) {
            self.layout_shader(id);
        }
        self.layout_gpu(id);
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
            background,
            mtm,
        );
        if bound.is_some() {
            apply_bound_decor(s, animator);
        }
    }

    /// The core asked for the states of `id` it reads (`active:`, ...).
    fn track_states(&mut self, id: NodeId, states: u16) {
        let Some(s) = self.slot_mut(id) else { return };
        if s.tracked == states {
            return;
        }
        s.tracked = states;
        let events = s.events;
        self.set_events(id, events);
    }

    /// An interaction state of `id` changed: tells the core if it reads it
    /// (the focus always: `nsh_core::input::reported_states`).
    fn report_state(&mut self, id: NodeId, bit: u16, on: bool) {
        let Some(s) = self.slot_mut(id) else { return };
        let states = if on { s.states | bit } else { s.states & !bit };
        if states == s.states {
            return;
        }
        s.states = states;
        let reported = nsh_core::input::reported_states(s.tracked);
        if reported & bit != 0 {
            self.control.set_states(id, states & reported);
        }
    }

    /// A pointer (an iPad's, a Mac's mouse) entered (`Began`), moved over
    /// (`Changed`) or left view `id`, at `in_window` (the window's
    /// coordinates): `onMouseEnter`, `onMouseMove`, `onMouseLeave`.
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
        // The movement that brings the pointer in is a move too, as on the
        // desktops and in the DOM.
        let kinds: &[EventKind] = match state {
            UIGestureRecognizerState::Began => &[EventKind::MouseEnter, EventKind::MouseMove],
            UIGestureRecognizerState::Changed => &[EventKind::MouseMove],
            UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled => {
                &[EventKind::MouseLeave]
            }
            _ => return,
        };
        if !kinds.iter().any(|&k| events.contains(k)) {
            return;
        }
        let Some(view) = self.slot(id).map(|s| s.native.view().retain()) else {
            return;
        };
        let (position, page_position) = self.pointer_positions(&view, in_window);
        // A hover recognizer only reports a pointer with no button down.
        let event =
            nsh_core::MouseEvent::new(position, page_position, key_modifiers(modifiers), None);
        for &kind in kinds.iter().filter(|&&k| events.contains(k)) {
            self.control
                .dispatch_event(id, kind, EventPayload::Mouse(event));
        }
    }

    /// A secondary click on view `id`, at `in_window` (the window's
    /// coordinates).
    pub(crate) fn context_menu(&mut self, id: NodeId, in_window: CGPoint, modifiers: isize) {
        let Some(view) = self.slot(id).map(|s| s.native.view().retain()) else {
            return;
        };
        let (position, page_position) = self.pointer_positions(&view, in_window);
        let event = nsh_core::ContextMenuEvent::new(
            position,
            page_position,
            key_modifiers(modifiers),
            Some(nsh_core::PointerType::Mouse),
        );
        self.control
            .dispatch_event(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
    }

    /// A drag of files entered (`entered`) or left listener `id`
    /// ([`crate::file_drop`]): its URLs are not known before the drop.
    pub(crate) fn file_drag(&mut self, id: NodeId, entered: bool) {
        let kind = if entered {
            EventKind::FileDragEnter
        } else {
            EventKind::FileDragLeave
        };
        if self.slot(id).is_some_and(|s| s.events.contains(kind)) {
            let payload = if entered {
                EventPayload::FileDrop(Vec::new())
            } else {
                EventPayload::None
            };
            self.control.dispatch_event(id, kind, payload);
        }
    }

    /// Files `uris` were dropped on listener `id` at `in_window` (the
    /// window's coordinates), then the drag is over: `onFileDrop`, then
    /// `onFileDragLeave`, as the desktop backends report them.
    pub(crate) fn files_dropped(&mut self, id: NodeId, in_window: CGPoint, uris: Vec<String>) {
        let Some(slot) = self.slot(id) else { return };
        let events = slot.events;
        let view = slot.native.view().retain();
        if !uris.is_empty() && events.contains(EventKind::FileDrop) {
            let (_, page_position) = self.pointer_positions(&view, in_window);
            self.control.dispatch_event(
                id,
                EventKind::FileDrop,
                EventPayload::FileDropAt {
                    uris,
                    page_position,
                },
            );
        }
        self.file_drag(id, false);
    }

    /// Text (`text`, and `html` when the drag had some) was dropped on view
    /// `id` at `in_window` (the window's coordinates).
    pub(crate) fn text_dropped(
        &mut self,
        id: NodeId,
        in_window: CGPoint,
        text: String,
        html: String,
    ) {
        let Some(slot) = self.slot(id) else { return };
        if (text.is_empty() && html.is_empty()) || !slot.events.contains(EventKind::TextDrop) {
            return;
        }
        let view = slot.native.view().retain();
        let (_, page_position) = self.pointer_positions(&view, in_window);
        self.control.dispatch_event(
            id,
            EventKind::TextDrop,
            EventPayload::TextDrop(Box::new(nsh_core::TextDrop::new(text, html, page_position))),
        );
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
    pub(crate) fn root_view_of(&self, view: &UIView) -> Option<Retained<UIView>> {
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
        let background = dynamic_background(s, animator);
        let kind = s.native.kind();
        let bound = bound_style(s, animator);
        s.decor.apply(
            s.native.view(),
            kind,
            bound.as_ref().unwrap_or(&s.style),
            background,
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

    /// The surface moved to a window (or out of one): the shaders in it
    /// take the pictures they missed, the GPU views render.
    pub(crate) fn window_changed(&mut self) {
        self.shaders.revisit();
        self.gpu.reveal();
        self.restore_root_focus();
        self.follow_background();
    }

    /// The surface's traits changed: on a screen of another scale (an
    /// external display, Catalyst), images decode again for it.
    pub(crate) fn traits_changed(&mut self) {
        let scale = self.display_scale();
        self.shaders.rescale(scale);
        self.gpu.rescale(scale);
        if scale == self.image_scale {
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
                Request::Ready(decoded) => view.set_image(image.uri.clone(), decoded.image),
                Request::Pending => {}
            }
        }
    }

    /// What the image loader reports.
    /// The disk cache the images it loads go through.
    /// The scroll views the embedding app watches ([`crate::AppView::watch_scroll`]).
    pub(crate) fn watch_scrolls(&mut self, watchers: crate::ScrollWatchers) {
        self.scroll_watchers = watchers;
    }

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
        self.offscreen.image_loaded(key, &result, &self.control);
        for id in self.images.finish(key, &result) {
            if let Some(Slot {
                native: Native::Canvas(view),
                ..
            }) = self.slot(id)
            {
                // Canvas images are requested at their natural size.
                match (&result, key.strip_prefix("0@")) {
                    (Ok(decoded), Some(uri)) => view.set_image(uri.into(), decoded.image.clone()),
                    (Err(message), _) => log::warn!("canvas image failed: {message}"),
                    _ => {}
                }
                continue;
            }
            let video_poster = match self.slot(id) {
                Some(s)
                    if s.poster_key.as_deref() == Some(key)
                        && matches!(&s.native, Native::Video(_)) =>
                {
                    match &s.native {
                        Native::Video(v) => Some(v.poster_mode()),
                        _ => None,
                    }
                }
                _ => None,
            };
            if let Some(mode) = video_poster {
                if let Some(s) = self.slot_mut(id) {
                    s.poster_key = None;
                    if let (Native::Video(v), Ok(decoded)) = (&mut s.native, &result) {
                        v.show_poster(decoded.image.clone(), mode);
                    }
                }
                if let Err(message) = &result {
                    log::warn!("video poster failed: {message}");
                }
                continue;
            }
            if self.shaders.pictured()
                && let Some(s) = self.views.get(id as usize).and_then(Option::as_ref)
            {
                self.shaders.ui_changed(s.native.view());
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
        if let Some((_, area)) = self.areas.iter().find(|(a, _)| *a == id) {
            area.set_listens(events.contains(EventKind::SelectionChange));
        }
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
        let mtm = self.mtm;
        let Some(slot) = self.views.get_mut(id as usize).and_then(Option::as_mut) else {
            return;
        };
        slot.events = events;
        if let Native::Web(web) = &slot.native {
            web.set_events(events);
        }
        if let Native::Input(input) = &mut slot.native {
            input.set_paste_listens(events.contains(EventKind::Paste));
        }
        let v = slot.values;
        let handoff = slot.pan_scroll_handoff;
        let activation = slot.pan_activation;
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
                new_pan(mtm, &target, activation, handoff)
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
        let gated = nsh_core::input::gate_activation(&v, events, activation);
        sync_gate(&mut g.gate, view, gated, mtm);
        if let Some(press) = &g.press {
            press.set_long_press(events.contains(EventKind::LongPress) || links_long_press);
            press.set_own(own_press, handles_press, nsh_core::input::has_tap(events));
            press.set_long_press_delay(slot.long_press_delay);
        }
        let wants_hover = nsh_core::input::hoverable(slot.tracked, events);
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
        let wants_drop =
            events.contains(EventKind::FileDrop) || events.contains(EventKind::TextDrop);
        match (&slot.gestures.file_drop, wants_drop) {
            (None, true) => {
                if let Some(i) = crate::file_drop::interaction(&target) {
                    // SAFETY: UIView's `addInteraction:` with a UIInteraction.
                    let _: () = unsafe { objc2::msg_send![view, addInteraction: &*i] };
                    slot.gestures.file_drop = Some(i);
                }
            }
            (Some(i), false) => {
                // SAFETY: UIView's `removeInteraction:` with its interaction.
                let _: () = unsafe { objc2::msg_send![view, removeInteraction: &**i] };
                slot.gestures.file_drop = None;
            }
            _ => {}
        }
        let wants_touch = events.contains(EventKind::Touch);
        if wants_drop
            || wants_press
            || wants_pan
            || wants_pinch
            || wants_rotation
            || wants_touch
            || wants_hover
            || wants_context
        {
            view.setUserInteractionEnabled(true);
        }
        if wants_touch || wants_pinch || wants_rotation {
            view.setMultipleTouchEnabled(true);
        }
        if let Some(nsh) = slot.native.nsh() {
            nsh.set_target(&target);
            nsh.set_events(events);
            nsh.set_pressable(events.contains(EventKind::Press), &control);
            nsh.update_focus_tap(&target);
        }
        self.sync_refresh(id);
    }

    /// Gives scroll view `id` the pull to refresh its events and behavior
    /// ask for: `UIRefreshControl`, or a pull detected here (Mac idiom, or
    /// the app's own indicator) with a spinner unless the app draws its
    /// own. Swapping keeps a refresh that runs.
    fn sync_refresh(&mut self, id: NodeId) {
        let target = self.target.clone();
        let (mtm, mac_idiom) = (self.mtm, self.mac_idiom);
        let Some(slot) = self.views.get_mut(id as usize).and_then(Option::as_mut) else {
            return;
        };
        let Native::Scroll(scroll) = &slot.native else {
            return;
        };
        let behavior = slot.behavior.as_deref().cloned().unwrap_or_default();
        // None: off; Some(None): UIRefreshControl; Some(Some(spinner)): custom.
        let wanted = slot.events.contains(EventKind::Refresh).then(|| {
            let own = behavior.refresh_indicator.is_some();
            (mac_idiom || own).then_some(!own)
        });
        let current = slot.gestures.refresh.as_ref().map(|r| match r {
            Refresh::Native(_) => None,
            Refresh::Custom { spinner, .. } => Some(spinner.is_some()),
        });
        if wanted == current {
            return;
        }
        let refreshing = match slot.gestures.refresh.take() {
            Some(Refresh::Native(control)) => {
                let refreshing = control.isRefreshing();
                scroll.setRefreshControl(None);
                refreshing
            }
            Some(Refresh::Custom {
                spinner,
                refreshing,
            }) => {
                if let Some(spinner) = spinner {
                    spinner.removeFromSuperview();
                }
                if refreshing {
                    let mut inset = scroll.contentInset();
                    inset.top = behavior.content_inset.top.0 as CGFloat;
                    scroll.setContentInset(inset);
                }
                refreshing
            }
            None => false,
        };
        match wanted {
            Some(Some(shows)) => {
                let spinner = shows.then(|| {
                    let spinner = UIActivityIndicatorView::initWithActivityIndicatorStyle(
                        UIActivityIndicatorView::alloc(mtm),
                        UIActivityIndicatorViewStyle::Medium,
                    );
                    spinner.setHidesWhenStopped(true);
                    place_spinner(
                        &spinner,
                        scroll.bounds().size.width as f32,
                        behavior.refresh_inset(),
                    );
                    scroll.addSubview(&spinner);
                    spinner
                });
                slot.gestures.refresh = Some(Refresh::Custom {
                    spinner,
                    refreshing: false,
                });
            }
            Some(None) => {
                let control = refresh_control(id, mtm);
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
            None => {}
        }
        if refreshing && wanted.is_some() {
            self.set_refreshing(id, true);
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
            Native::Screen(_) => {
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
            // Inputs show it (`MountItem::Input`).
            Native::InputAccessory(_) => {}
            _ => return false,
        }
        self.hosts.insert(child, parent);
        true
    }

    /// The counterpart of [`Mounter::insert_hosted`] for removals.
    fn remove_hosted(&mut self, id: NodeId) -> bool {
        let Some(parent) = self.hosts.remove(&id) else {
            return false;
        };
        match self.slot(id).map(|s| &s.native) {
            Some(Native::Screen(screen)) => {
                let animation = screen.config.animation;
                let shader = self
                    .nav_shaders
                    .get(&id)
                    .filter(|_| !reduce_motion())
                    .cloned();
                // A collapsed split shows its columns' pages in its compact
                // stack: the page leaves that one, keyed by the split.
                let shown_in = match self.collapsed_split_of(parent) {
                    Some(split) => self
                        .splits
                        .get(&split)
                        .map(|host| (split, host.compact.nav.clone())),
                    None => match self.slot(parent) {
                        Some(Slot {
                            native: Native::Stack(stack),
                            ..
                        }) => Some((parent, stack.nav.clone())),
                        _ => None,
                    },
                };
                let Some((key, nav)) = shown_in else {
                    return true;
                };
                let shown = nav
                    .topViewController()
                    .and_then(|c| c.downcast::<crate::navigation::ScreenController>().ok())
                    .is_some_and(|c| c.screen_id() == id);
                if let Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) = self.slot_mut(parent)
                {
                    stack.screens.retain(|&s| s != id);
                    stack.popped.retain(|&s| s != id);
                }
                let view = nav.view();
                self.dirty_stacks.push(parent);
                if !shown {
                    return true;
                }
                // The app may release it in this batch, its views first:
                // what the stack's change needs of it is kept, and what
                // showed is pictured now when it leaves through a shader.
                let through = shader.is_some();
                self.leaving_screens.insert(
                    key,
                    LeavingScreen {
                        id,
                        shader,
                        animation,
                    },
                );
                if through
                    && let Some(view) = view
                    && let Some(window) = view.window()
                {
                    let rect = view.convertRect_toView(view.bounds(), Some(&window));
                    let scale = self.display_scale();
                    self.shaders.hold(key, &window, rect, scale);
                }
            }
            Some(Native::HeaderItem(view)) => {
                view.removeFromSuperview();
                self.dirty_headers.push(parent);
            }
            Some(Native::Modal(modal)) => {
                let closes = modal.changes(false);
                self.dirty_modals.push(id);
                // Pictured with its content, which the app may release
                // before it closes.
                if closes
                    && !reduce_motion()
                    && self.nav_shaders.contains_key(&id)
                    && let Some(root) = self
                        .slot(nsh_core::ROOT_ID)
                        .map(|s| s.native.view().retain())
                    && let Some(window) = root.window()
                {
                    let rect = root.convertRect_toView(root.bounds(), Some(&window));
                    let scale = self.display_scale();
                    self.shaders.hold(nsh_core::ROOT_ID, &window, rect, scale);
                }
            }
            _ => {}
        }
        true
    }

    /// Starts dialog `id` coming (`shown`) or going through its
    /// `transitionShader`, over the window's part where the surface is;
    /// whether it does (the dialog then changes at once). Not where less
    /// motion is asked for, nor where the shader cannot draw: the dialog
    /// keeps its own motion.
    fn dialog_overlay(&mut self, id: NodeId, shown: bool) -> bool {
        if reduce_motion() {
            return false;
        }
        let Some(root) = self
            .slot(nsh_core::ROOT_ID)
            .map(|s| s.native.view().retain())
        else {
            return false;
        };
        let Some(window) = root.window() else {
            return false;
        };
        let rect = root.convertRect_toView(root.bounds(), Some(&window));
        let scale = self.display_scale();
        let Some(shader) = self.nav_shaders.get(&id) else {
            return false;
        };
        self.shaders
            .nav_overlay(nsh_core::ROOT_ID, &window, rect, scale, shader, !shown)
    }

    /// Applies the navigation changes of a batch once all its views exist
    /// and are laid out: pushes and pops screens, updates headers, presents
    /// and dismisses modals.
    fn finish_navigation(&mut self) {
        // Splits first: they adopt their columns' stacks and take their
        // pages into the compact stack, or give them back.
        let splits: Vec<NodeId> = self.splits.keys().copied().collect();
        for id in splits {
            self.sync_split(id);
        }
        let mut stacks = std::mem::take(&mut self.dirty_stacks);
        // A collapsed split's column shows in the split's compact stack.
        for id in &mut stacks {
            if let Some(split) = self.collapsed_split_of(*id) {
                *id = split;
            }
        }
        stacks.sort_unstable();
        stacks.dedup();
        for id in stacks {
            if self.splits.contains_key(&id) {
                self.reconcile_compact(id);
                continue;
            }
            let Some(Slot {
                native: Native::Stack(stack),
                ..
            }) = self.slot(id)
            else {
                continue;
            };
            if let Some(coordinator) = stack.nav.transitionCoordinator() {
                if !self.deferred_stacks.contains(&id) {
                    self.deferred_stacks.push(id);
                    // A modal presented or dismissed over the stack sets the
                    // coordinator too, and its end never reaches `didShow`.
                    let shared = self.shared.clone();
                    let done = RcBlock::new(
                        move |_: NonNull<
                            ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
                        >| { Self::finish_deferred(&shared, id) },
                    );
                    // Refused when the transition is already ending.
                    if !coordinator.animateAlongsideTransition_completion(None, Some(&done)) {
                        Self::finish_deferred(&self.shared, id);
                    }
                }
                continue;
            }
            let screens: Vec<_> = stack
                .screens
                .iter()
                .filter(|s| !stack.popped.contains(s))
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
            let top = screens.last().map(|s| s.0);
            let leaving_id = stack
                .nav
                .topViewController()
                .and_then(|c| c.downcast::<crate::navigation::ScreenController>().ok())
                .map(|c| c.screen_id());
            // The screen the app removed and released keeps its animation
            // and shader ([`Mounter::remove_hosted`]).
            let recorded = self
                .leaving_screens
                .remove(&id)
                .filter(|l| Some(l.id) == leaving_id);
            let leaving = leaving.or(recorded.as_ref().map(|l| l.animation));
            // Less motion asked for: UIKit's own (reduced) motion instead.
            let shaders = if reduce_motion() {
                (None, None)
            } else {
                (
                    top.and_then(|id| self.nav_shaders.get(&id)),
                    leaving_id
                        .and_then(|id| self.nav_shaders.get(&id))
                        .or(recorded.as_ref().and_then(|l| l.shader.as_ref())),
                )
            };
            let scale = self.display_scale();
            let Some(Slot {
                native: Native::Stack(stack),
                ..
            }) = self.views.get(id as usize).and_then(Option::as_ref)
            else {
                continue;
            };
            let overlays = &mut self.shaders;
            // Pictured before the change, which then happens at once.
            stack.reconcile(&screens, leaving, shaders, |view, shader, pops| {
                let Some(window) = view.window() else {
                    return false;
                };
                let rect = view.convertRect_toView(view.bounds(), Some(&window));
                overlays.nav_overlay(id, &window, rect, scale, shader, pops)
            });
            // A page whose options arrive while it is already on screen: the
            // stack itself does not change, and the bar still has to follow.
            stack.sync_bottom_bar();
            if let Some(Slot {
                native: Native::Stack(stack),
                ..
            }) = self.slot_mut(id)
            {
                stack.contain();
            }
        }
        if std::mem::take(&mut self.bottom_bar_dirty) {
            for slot in self.views.iter().flatten() {
                if let Native::Stack(stack) = &slot.native {
                    stack.sync_bottom_bar();
                }
            }
            // A collapsed split's pages are in its compact stack.
            for split in self.splits.values() {
                split.compact.sync_bottom_bar();
            }
        }
        let mut headers = std::mem::take(&mut self.dirty_headers);
        headers.sort_unstable();
        headers.dedup();
        let mut follows = Vec::new();
        for id in headers {
            let Some(Slot {
                native: Native::Screen(screen),
                ..
            }) = self.slot(id)
            else {
                continue;
            };
            let press = Some(self.shared.clone());
            screen.apply_header(
                |item| match self.slot(item).map(|s| &s.native) {
                    Some(Native::HeaderItem(v)) => Some(Retained::into_super(v.clone())),
                    _ => None,
                },
                press,
            );
            follows.push((
                id,
                screen.config.header_transparent && screen.config.header_background_on_scroll,
            ));
            if screen.config.large_title {
                // Large titles collapse as the content scrolls under them.
                if let Some(scroll) = first_scroll_view(&screen.view)
                    && scroll.contentInsetAdjustmentBehavior()
                        != UIScrollViewContentInsetAdjustmentBehavior::Automatic
                {
                    // UIKit keeps a scroll view at its top when its safe area
                    // changes, not when it starts to adjust for it. One
                    // already on screen (new content, or a header that turned
                    // large in place) would keep its offset: its content
                    // under the header, read as scrolled, the title collapsed.
                    let at_top =
                        scroll.contentOffset().y <= -scroll.adjustedContentInset().top + 0.5;
                    scroll.setContentInsetAdjustmentBehavior(
                        UIScrollViewContentInsetAdjustmentBehavior::Automatic,
                    );
                    if at_top {
                        let mut offset = scroll.contentOffset();
                        offset.y = -scroll.adjustedContentInset().top;
                        scroll.setContentOffset(offset);
                    }
                }
            } else if let Some(scroll) = first_scroll_view(&screen.view)
                && scroll.contentInsetAdjustmentBehavior()
                    != UIScrollViewContentInsetAdjustmentBehavior::Never
            {
                let at_top = scroll.contentOffset().y <= -scroll.adjustedContentInset().top + 0.5;
                scroll.setContentInsetAdjustmentBehavior(
                    UIScrollViewContentInsetAdjustmentBehavior::Never,
                );
                if at_top {
                    let mut offset = scroll.contentOffset();
                    offset.y = -scroll.contentInset().top;
                    scroll.setContentOffset(offset);
                }
            }
            screen.controller.follow_large_title();
            // A header changed under a transform is laid out for where the
            // stack is, not for the picture the transform shows.
            if let Some(nav) = screen.controller.navigationController() {
                crate::navigation::lay_out_header_in_place(&nav);
            }
        }
        for (id, follows) in follows {
            self.following_scroll.retain(|&other| other != id);
            if follows {
                self.following_scroll.push(id);
            }
        }
        self.finish_modals();
        let views = &self.views;
        self.following_scroll.retain(
            |&id| match views.get(id as usize).and_then(Option::as_ref) {
                Some(Slot {
                    native: Native::Screen(screen),
                    ..
                }) => {
                    screen.controller.follow_content_scroll();
                    true
                }
                _ => false,
            },
        );
        // What no change used goes, but for stacks whose change waits for
        // UIKit's transition to end.
        let deferred = &self.deferred_stacks;
        self.leaving_screens
            .retain(|stack, _| deferred.contains(stack));
        self.shaders.release_held(|key| deferred.contains(&key));
    }

    /// Presents and dismisses the modals whose place in the tree changed.
    fn finish_modals(&mut self) {
        if std::mem::take(&mut self.tree_changed) {
            for i in 0..self.modal_attached.len() {
                let (id, was) = self.modal_attached[i];
                let now = self.in_tree(id);
                if now != was {
                    self.modal_attached[i].1 = now;
                    self.dirty_modals.push(id);
                }
            }
        }
        // Taken along by a dismissal and hidden (or deleted) since: closed
        // once it ends.
        let control = self.control.clone();
        self.closing_taken.retain(|(id, controller)| {
            let gone = controller.presentingViewController().is_none();
            if gone {
                control.dispatch_event(*id, EventKind::Dismiss, EventPayload::None);
            }
            !gone
        });
        if self.dirty_modals.is_empty() {
            self.dismissed_now.clear();
            return;
        }
        let mut modals = std::mem::take(&mut self.dirty_modals);
        let mut seen = 0;
        while seen < modals.len() {
            let id = modals[seen];
            if modals[..seen].contains(&id) {
                modals.remove(seen);
            } else {
                seen += 1;
            }
        }
        let (shown, mut hidden): (Vec<NodeId>, Vec<NodeId>) =
            modals.into_iter().partition(|&id| self.in_tree(id));
        // Dismissals first, the lowest first: UIKit dismisses everything
        // above the modal it dismisses, so the ones the app hides over it
        // go with it, those it shows come back once it is gone, and one
        // presented now waits for it.
        hidden.sort_by_cached_key(|&id| self.modal(id).map_or(0, ModalHost::depth));
        // Taken along by a dismissal under it (its presentation was
        // UIKit's undoing, not the app's): reported closed when gone.
        for &id in &hidden {
            let Some(modal) = self.modal_mut(id) else {
                continue;
            };
            match modal.hidden_after_taken() {
                Some(true) => {
                    self.control
                        .dispatch_event(id, EventKind::Dismiss, EventPayload::None)
                }
                Some(false) => {
                    let controller = modal.controller.clone();
                    self.closing_taken.push((id, controller));
                }
                None => {}
            }
        }
        let mut handled = Vec::new();
        for &id in &hidden {
            if handled.contains(&id) {
                continue;
            }
            let Some(modal) = self.modal(id) else {
                continue;
            };
            let changes = modal.changes(false);
            let above = if changes {
                modal.modals_above()
            } else {
                Vec::new()
            };
            // Through its shader, pictured before it goes at once (where
            // the shader cannot draw, with its own motion).
            let at_once = changes && self.dialog_overlay(id, false);
            let mut gone = vec![id];
            for other in above {
                let hides = hidden.contains(&other);
                let Some(modal) = self.modal_mut(other) else {
                    continue;
                };
                if modal.dismissed_under() {
                    if hides {
                        gone.push(other);
                    } else {
                        self.waiting_modals.push(other);
                    }
                } else if hides {
                    // Closed by the user already (and reported).
                    modal.dismiss(false, || {});
                }
                if hides {
                    handled.push(other);
                }
            }
            let control = self.control.clone();
            let shared = self.shared.clone();
            if changes {
                self.dismissed_now.push(id);
            }
            let Some(modal) = self.modal_mut(id) else {
                continue;
            };
            modal.dismiss(at_once, move || {
                for &id in &gone {
                    control.dispatch_event(id, EventKind::Dismiss, EventPayload::None);
                }
                Self::present_waiting(&shared);
            });
        }
        let dismissed = std::mem::take(&mut self.dismissed_now);
        let Some(root) = self
            .slot(nsh_core::ROOT_ID)
            .map(|s| s.native.view().retain())
        else {
            return;
        };
        for id in shown {
            let Some(modal) = self.modal(id) else {
                continue;
            };
            if !modal.changes(true) {
                continue;
            }
            if let Some(awaited) = crate::navigation::transition_over(&root, &dismissed) {
                self.wait_for(id, &awaited);
                continue;
            }
            // Through its shader, pictured before it comes at once (where
            // the shader cannot draw, with its own motion).
            let at_once = self.dialog_overlay(id, true);
            if let Some(modal) = self.modal_mut(id) {
                modal.present(&root, at_once);
            }
        }
    }

    /// Whether `id` is in the tree: its parents lead to the root. A view
    /// whose parent was deleted keeps its id until its own deletion, and a
    /// new view may take that id: the walk stops after as many steps as
    /// there are views.
    fn in_tree(&self, mut id: NodeId) -> bool {
        for _ in 0..self.views.len() {
            if id == nsh_core::ROOT_ID {
                return true;
            }
            match self.slot(id).and_then(|s| s.parent) {
                Some(parent) => id = parent,
                None => return false,
            }
        }
        false
    }

    fn modal(&self, id: NodeId) -> Option<&ModalHost> {
        match self.slot(id) {
            Some(Slot {
                native: Native::Modal(modal),
                ..
            }) => Some(modal),
            _ => None,
        }
    }

    fn modal_mut(&mut self, id: NodeId) -> Option<&mut ModalHost> {
        match self.slot_mut(id) {
            Some(Slot {
                native: Native::Modal(modal),
                ..
            }) => Some(modal),
            _ => None,
        }
    }

    /// Modal `id` is presented once the transition of `awaited` ends
    /// ([`Mounter::present_waiting`]), and NSH's dismissal presents the
    /// waiting modals when it is done. One NSH just dismissed with no
    /// transition yet, or whose dismissal waited for a transition that
    /// ended, is looked at again on the main queue's next turn: by then its
    /// transition runs, or it is gone, or UIKit refused it.
    fn wait_for(&mut self, id: NodeId, awaited: &objc2_ui_kit::UIViewController) {
        if !self.waiting_modals.contains(&id) {
            self.waiting_modals.push(id);
        }
        // Presented once that modal is gone: its dismissal's end does so.
        if crate::navigation::held_under_system_ui(awaited) {
            return;
        }
        let Some(coordinator) = awaited.transitionCoordinator() else {
            return Self::present_waiting(&self.shared);
        };
        let shared = self.shared.clone();
        let done = RcBlock::new(
            move |_: NonNull<ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>>| {
                Self::present_waiting(&shared)
            },
        );
        // Refused when the transition is already ending.
        if !coordinator.animateAlongsideTransition_completion(None, Some(&done)) {
            Self::present_waiting(&self.shared);
        }
    }

    /// Presents the modals waiting for a transition to end
    /// ([`Mounter::wait_for`]) and reports the taken ones hidden since
    /// (`closing_taken`), on the main queue's next turn: the controller
    /// that left is out of the presentation by then. One still in the way
    /// of another transition waits again.
    fn present_waiting(shared: &SharedMounter) {
        let shared = shared.clone();
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue");
            if let Some(m) = shared.get(mtm).borrow_mut().as_mut()
                && !(m.waiting_modals.is_empty() && m.closing_taken.is_empty())
            {
                let waiting = std::mem::take(&mut m.waiting_modals);
                m.dirty_modals.extend(waiting);
                m.finish_navigation();
            }
        });
    }

    /// A stack is about to show a screen: its header options apply.
    pub(crate) fn stack_will_show(
        &mut self,
        nav: &objc2_ui_kit::UINavigationController,
        controller: &objc2_ui_kit::UIViewController,
        animated: bool,
    ) {
        // A page shown again is back in the window: the shaders in it take
        // the pictures they missed, the GPU views render.
        self.shaders.revisit();
        self.gpu.reveal();
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
        self.shaders.revisit();
        self.gpu.reveal();
        if self.splits.contains_key(&id) {
            self.compact_did_show(id);
        } else {
            self.report_popped(id);
        }
        if self.deferred_stacks.contains(&id) {
            Self::finish_deferred(&self.shared, id);
        }
    }

    /// Applies the orientations the root was last given, once no stack is
    /// pushing or popping and nothing is being presented: UIKit can cancel
    /// a push the screen starts turning during, which reads as the user
    /// going back.
    fn apply_orientations(&mut self) {
        let Some(bits) = self.orientations else {
            return;
        };
        if self.orientations_waiting {
            return;
        }
        let Some(root) = self.ui_view(nsh_core::ROOT_ID) else {
            return;
        };
        let presenting = root
            .window()
            .and_then(|w| w.rootViewController())
            .and_then(|c| c.transitionCoordinator());
        let moving = presenting.or_else(|| {
            self.views
                .iter()
                .flatten()
                .find_map(|slot| match &slot.native {
                    Native::Stack(stack) => stack.nav.transitionCoordinator(),
                    _ => None,
                })
        });
        if let Some(coordinator) = moving {
            self.orientations_waiting = true;
            let shared = self.shared.clone();
            let done = RcBlock::new(
                move |_: NonNull<
                    ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
                >| {
                    // On the next turn, as the stacks catch up
                    // (`finish_deferred`): the coordinator outlives this
                    // callback, and a push they make waits its turn too.
                    let shared = shared.clone();
                    DispatchQueue::main().exec_async(move || {
                        let mtm = MainThreadMarker::new().expect("main queue");
                        if let Some(m) = shared.get(mtm).borrow_mut().as_mut() {
                            m.orientations_waiting = false;
                            m.apply_orientations();
                        }
                    });
                },
            );
            // Refused when the transition is already ending.
            if coordinator.animateAlongsideTransition_completion(None, Some(&done)) {
                return;
            }
            self.orientations_waiting = false;
        }
        self.orientations = None;
        crate::system::set_orientations(bits, &root);
    }

    /// Applies the changes stack `id` deferred during a transition, on the
    /// next main-queue turn (the transition coordinator outlives the
    /// callbacks that end it), unless another callback already did.
    fn finish_deferred(shared: &SharedMounter, id: NodeId) {
        let shared = shared.clone();
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue");
            if let Some(m) = shared.get(mtm).borrow_mut().as_mut()
                && let Some(i) = m.deferred_stacks.iter().position(|&s| s == id)
            {
                m.deferred_stacks.swap_remove(i);
                m.dirty_stacks.push(id);
                m.finish_navigation();
            }
        });
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
        let top = match self.splits.get(&id) {
            // The compact stack's top page, whichever column it is of.
            Some(split) => compact_top(split)?,
            None => {
                let Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) = self.slot(id)
                else {
                    return None;
                };
                *stack
                    .screens
                    .iter()
                    .rev()
                    .find(|s| !stack.popped.contains(s))?
            }
        };
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
        if let Some(split) = self.splits.get(&id) {
            return self.compact_can_pop(split);
        }
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
            .find(|s| !stack.popped.contains(s))
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

    // --- Split views (`crate::split`) -------------------------------------

    /// The split whose compact stack shows stack `id`'s pages, while it is
    /// collapsed.
    fn collapsed_split_of(&self, id: NodeId) -> Option<NodeId> {
        let Some(Slot {
            native: Native::Stack(stack),
            ..
        }) = self.slot(id)
        else {
            return None;
        };
        let split = stack.split?;
        self.splits
            .get(&split)
            .filter(|s| s.collapsed)
            .map(|_| split)
    }

    /// The stacks of split `id`'s columns: in the column wrappers, the
    /// views before its container in column order (`nsh-base`'s
    /// `split_view.rs` renders them so), each its wrapper's first stack.
    fn split_column_stacks(&self, id: NodeId, triple: bool) -> [Option<NodeId>; 3] {
        let mut columns = [None; 3];
        let Some(container) = self.slot(id).map(|s| s.native.view().retain()) else {
            return columns;
        };
        let Some(parent) = container.superview() else {
            return columns;
        };
        let wrappers: Vec<Retained<UIView>> = parent
            .subviews()
            .iter()
            .take_while(|v| !std::ptr::eq::<UIView>(&**v, &*container))
            .filter(|v| v.tag() > 0 && self.slot(v.tag() as NodeId).is_some())
            .collect();
        let order: &[usize] = if triple { &[0, 1, 2] } else { &[0, 2] };
        for (wrapper, &column) in wrappers.iter().zip(order) {
            columns[column] = self.first_stack(wrapper);
        }
        columns
    }

    /// The first stack in `view`, breadth first.
    fn first_stack(&self, view: &UIView) -> Option<NodeId> {
        let mut pending = std::collections::VecDeque::from([view.retain()]);
        while let Some(view) = pending.pop_front() {
            let id = view.tag();
            if id > 0
                && let Some(Slot {
                    native: Native::Stack(_),
                    ..
                }) = self.slot(id as NodeId)
            {
                return Some(id as NodeId);
            }
            pending.extend(view.subviews().iter());
        }
        None
    }

    /// Brings split `id` up to date: its controller (made for the number of
    /// columns) and its parent, the stacks of its columns, where the
    /// columns' pages are (in the columns, or in its compact stack while it
    /// is collapsed), the app's visibility and the columns' sizes.
    fn sync_split(&mut self, id: NodeId) {
        let Some(mut split) = self.splits.remove(&id) else {
            return;
        };
        let controller = split.controller_for_columns(self.mtm, id, &self.shared);
        split.contain();
        // The columns: each the navigation controller of its stack.
        let wanted = self.split_column_stacks(id, split.triple);
        for column in 0..3 {
            if column == 1 && !split.triple {
                continue;
            }
            if wanted[column] == split.columns[column] {
                continue;
            }
            let old = split.columns[column].take();
            let nav = wanted[column].and_then(|new| match self.slot_mut(new) {
                Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) => {
                    stack.join_split(id);
                    Some(stack.nav.clone())
                }
                _ => None,
            });
            let vc = nav
                .as_deref()
                .map(|nav| -> &objc2_ui_kit::UIViewController { nav });
            controller.setViewController_forColumn(vc, crate::split::column(column));
            split.columns[column] = wanted[column];
            // The stack the column showed takes its navigation controller
            // back once the split let it go (not before: letting it go takes
            // the controller's view out of where it is).
            if let Some(old) = old
                && !wanted.contains(&Some(old))
            {
                if let Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) = self.slot_mut(old)
                {
                    stack.leave_split();
                }
                // Its pages go back to it, out of the compact stack too.
                self.dirty_stacks.push(old);
                self.dirty_stacks.push(id);
            }
            if let Some(new) = wanted[column] {
                // Its pages go where the split shows them.
                if split.collapsed
                    && let Some(Slot {
                        native: Native::Stack(stack),
                        ..
                    }) = self.slot(new)
                {
                    stack.detach_screens();
                }
                self.dirty_stacks.push(new);
                self.dirty_stacks.push(id);
            }
        }
        // Collapsed or expanded: the pages move between the columns and the
        // compact stack.
        let collapsed = controller.isCollapsed();
        if collapsed != split.collapsed {
            split.collapsed = collapsed;
            if collapsed {
                for &stack_id in split.columns.iter().flatten() {
                    if let Some(Slot {
                        native: Native::Stack(stack),
                        ..
                    }) = self.slot(stack_id)
                    {
                        stack.detach_screens();
                    }
                }
                split.compact_columns =
                    crate::split::compact_columns(split.requested, split.triple);
                split.applied = Some((split.requested, split.revision));
            } else {
                split.compact.detach_screens();
                // The expanded split shows the app's visibility again.
                split.applied = None;
                self.dirty_stacks
                    .extend(split.columns.iter().flatten().copied());
            }
            self.dirty_stacks.push(id);
        }
        // The app's visibility: the columns of the compact stack, or the
        // display mode.
        if split.collapsed {
            let request = (split.requested, split.revision);
            if split.applied != Some(request) {
                split.applied = Some(request);
                split.compact_columns =
                    crate::split::compact_columns(split.requested, split.triple);
                self.dirty_stacks.push(id);
            }
        } else {
            split.apply_visibility();
        }
        self.splits.insert(id, split);
        self.report_split_sizes(id);
    }

    /// Split `id` collapsed or expanded (its delegate, or a layout pass
    /// that found it so): the pages move, and the stacks follow.
    pub(crate) fn split_settle(&mut self, id: NodeId) {
        let Some(split) = self.splits.get(&id) else {
            return;
        };
        let moved = split
            .controller
            .as_ref()
            .is_some_and(|c| c.isCollapsed() != split.collapsed);
        if moved {
            self.finish_navigation();
        } else {
            self.report_split_sizes(id);
        }
    }

    /// Split `id` is about to show `mode`: what the user or the system
    /// shows is reported, not the app's own visibility applied, nor the
    /// system's choice while the window changes (or first shows the split)
    /// when the app leaves it to the system (`automatic`).
    pub(crate) fn split_display_mode(
        &mut self,
        id: NodeId,
        mode: objc2_ui_kit::UISplitViewControllerDisplayMode,
        system: bool,
    ) {
        let Some(split) = self.splits.get_mut(&id) else {
            return;
        };
        if split.collapsed {
            return;
        }
        let Some(shown) = crate::split::visibility_of(mode, split.triple) else {
            return;
        };
        if split.shown.replace(shown) == Some(shown) || shown == split.requested {
            return;
        }
        if system && split.requested == nsh_base::ColumnVisibility::Automatic {
            return;
        }
        self.control.dispatch_event(
            id,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: "columnVisibilityChange".into(),
                data: shown.name().into(),
            },
        );
    }

    /// The display mode split `id` expands to (`None`: the one UIKit
    /// proposes).
    pub(crate) fn split_expanding_mode(
        &self,
        id: NodeId,
    ) -> Option<objc2_ui_kit::UISplitViewControllerDisplayMode> {
        self.splits.get(&id)?.expanding_mode()
    }

    /// A column of a split (stack `id`), or a split's compact stack (`id`
    /// the split), was laid out: the columns' sizes are reported.
    pub(crate) fn split_column_laid_out(&mut self, id: NodeId) {
        let split = if self.splits.contains_key(&id) {
            Some(id)
        } else {
            match self.slot(id) {
                Some(Slot {
                    native: Native::Stack(stack),
                    ..
                }) => stack.split,
                _ => None,
            }
        };
        if let Some(split) = split {
            self.report_split_sizes(split);
        }
    }

    /// Reports the size each column of split `id` lays its stack's pages
    /// out at (the compact stack's for each, while it is collapsed), when
    /// it changed.
    fn report_split_sizes(&mut self, id: NodeId) {
        let Some(split) = self.splits.get(&id) else {
            return;
        };
        let size_of = |nav: &objc2_ui_kit::UINavigationController| {
            nav.viewIfLoaded()
                .map(|v| v.bounds().size)
                .filter(|s| s.width > 0.0 && s.height > 0.0)
                .map(|s| (s.width as f32, s.height as f32))
        };
        let mut sizes = [None; 3];
        for (column, stack) in split.columns.iter().enumerate() {
            let Some(stack) = stack else { continue };
            sizes[column] = if split.collapsed {
                size_of(&split.compact.nav)
            } else {
                match self.slot(*stack) {
                    Some(Slot {
                        native: Native::Stack(stack),
                        ..
                    }) => size_of(&stack.nav),
                    _ => None,
                }
            };
        }
        if sizes == split.sizes {
            return;
        }
        let mut data = serde_json::Map::new();
        for (key, size) in ["sidebar", "content", "detail"].into_iter().zip(sizes) {
            if let Some((width, height)) = size {
                data.insert(
                    key.into(),
                    serde_json::json!({ "width": width, "height": height }),
                );
            }
        }
        if let Some(split) = self.splits.get_mut(&id) {
            split.sizes = sizes;
        }
        self.control.dispatch_event(
            id,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: "layout".into(),
                data: nsh_core::JsonValue::Object(data),
            },
        );
    }

    /// Shows the pages of the columns collapsed split `id` shows in its
    /// compact stack: the sidebar's, then the content's and the detail's
    /// as far as the visibility (or the user's way back) goes. A change
    /// waits for a running transition, as a stack's does.
    fn reconcile_compact(&mut self, id: NodeId) {
        let Some(split) = self.splits.get(&id) else {
            return;
        };
        if !split.collapsed {
            return;
        }
        if let Some(coordinator) = split.compact.nav.transitionCoordinator() {
            if !self.deferred_stacks.contains(&id) {
                self.deferred_stacks.push(id);
                let shared = self.shared.clone();
                let done = RcBlock::new(
                    move |_: NonNull<
                        ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
                    >| { Self::finish_deferred(&shared, id) },
                );
                if !coordinator.animateAlongsideTransition_completion(None, Some(&done)) {
                    Self::finish_deferred(&self.shared, id);
                }
            }
            return;
        }
        let order: &[usize] = if split.triple { &[0, 1, 2] } else { &[0, 2] };
        let mut screens = Vec::new();
        for &column in order.iter().take(split.compact_columns) {
            let Some(Slot {
                native: Native::Stack(stack),
                ..
            }) = split.columns[column].and_then(|s| self.slot(s))
            else {
                continue;
            };
            for &s in stack.screens.iter().filter(|s| !stack.popped.contains(s)) {
                if let Some(Slot {
                    native: Native::Screen(screen),
                    ..
                }) = self.slot(s)
                {
                    screens.push((s, screen.controller.clone(), screen.config.animation));
                }
            }
        }
        // As a stack's change: the leaving page's animation and the
        // pages' transition shaders, the removed page's kept by
        // [`Mounter::remove_hosted`] under the split's id.
        let top = screens.last().map(|s| s.0);
        let leaving_id = compact_top(split);
        let leaving = leaving_id.and_then(|s| match self.slot(s).map(|s| &s.native) {
            Some(Native::Screen(screen)) => Some(screen.config.animation),
            _ => None,
        });
        let recorded = self
            .leaving_screens
            .remove(&id)
            .filter(|l| Some(l.id) == leaving_id);
        let leaving = leaving.or(recorded.as_ref().map(|l| l.animation));
        let shaders = if reduce_motion() {
            (None, None)
        } else {
            (
                top.and_then(|id| self.nav_shaders.get(&id)),
                leaving_id
                    .and_then(|id| self.nav_shaders.get(&id))
                    .or(recorded.as_ref().and_then(|l| l.shader.as_ref())),
            )
        };
        let scale = self.display_scale();
        let overlays = &mut self.shaders;
        split
            .compact
            .reconcile(&screens, leaving, shaders, |view, shader, pops| {
                let Some(window) = view.window() else {
                    return false;
                };
                let rect = view.convertRect_toView(view.bounds(), Some(&window));
                overlays.nav_overlay(id, &window, rect, scale, shader, pops)
            });
        split.compact.sync_bottom_bar();
    }

    /// Split `id`'s compact stack finished a transition: a page the user
    /// left that is not its stack's first is reported to it as a native
    /// pop; going back past a column's first page shows the column before
    /// (`compactColumnChange`), and its stack keeps its pages.
    fn compact_did_show(&mut self, id: NodeId) {
        let Some(split) = self.splits.get(&id) else {
            return;
        };
        let shown: Vec<NodeId> = split
            .compact
            .nav
            .viewControllers()
            .iter()
            .filter_map(|c| c.downcast::<crate::navigation::ScreenController>().ok())
            .map(|c| c.screen_id())
            .collect();
        let gone: Vec<NodeId> = split
            .compact
            .applied
            .borrow()
            .iter()
            .copied()
            .filter(|s| !shown.contains(s))
            .collect();
        if gone.is_empty() {
            return;
        }
        *split.compact.applied.borrow_mut() = shown.clone();
        let first_of = |stack: NodeId| match self.slot(stack) {
            Some(Slot {
                native: Native::Stack(stack),
                ..
            }) => stack
                .screens
                .iter()
                .find(|s| !stack.popped.contains(s))
                .copied(),
            _ => None,
        };
        let popped: Vec<(NodeId, NodeId)> = gone
            .iter()
            .filter_map(|&s| {
                let stack = *self.hosts.get(&s)?;
                (first_of(stack) != Some(s)).then_some((stack, s))
            })
            .collect();
        // The columns still shown: those whose first page is.
        let order: &[usize] = if split.triple { &[0, 1, 2] } else { &[0, 2] };
        let still = order
            .iter()
            .take(split.compact_columns)
            .take_while(|&&column| {
                split.columns[column]
                    .and_then(first_of)
                    .is_none_or(|first| shown.contains(&first))
            })
            .count();
        let went_back = still < split.compact_columns && still > 0;
        for &(stack, screen) in &popped {
            if let Some(Slot {
                native: Native::Stack(stack),
                ..
            }) = self.slot_mut(stack)
            {
                stack.popped.push(screen);
            }
            self.control
                .dispatch_event(screen, EventKind::Dismiss, EventPayload::None);
        }
        if went_back {
            if let Some(split) = self.splits.get_mut(&id) {
                split.compact_columns = still;
            }
            self.control.dispatch_event(
                id,
                EventKind::NativeEvent,
                EventPayload::Native {
                    name: "compactColumnChange".into(),
                    data: nsh_core::JsonValue::from(still - 1),
                },
            );
        }
    }

    /// Whether the user may go back in `split`'s compact stack: below its
    /// top page there is one, no transition runs, and the page allows it.
    fn compact_can_pop(&self, split: &crate::split::SplitHost) -> bool {
        let nav = &split.compact.nav;
        let allowed = compact_top(split).and_then(|s| match self.slot(s).map(|s| &s.native) {
            Some(Native::Screen(screen)) => {
                Some(screen.config.gesture_enabled && !screen.config.prevent_back)
            }
            _ => None,
        });
        nav.viewControllers().count() > 1
            && nav.transitionCoordinator().is_none()
            && allowed.unwrap_or(true)
    }

    /// Node `id` was deleted: if it was a split's, the split lets its
    /// columns go (their stacks take back their navigation controllers and
    /// pages).
    fn split_deleted(&mut self, id: NodeId) {
        let Some(mut split) = self.splits.remove(&id) else {
            return;
        };
        split.compact.detach_screens();
        for &stack in split.columns.iter().flatten() {
            if let Some(Slot {
                native: Native::Stack(host),
                ..
            }) = self.slot_mut(stack)
            {
                host.leave_split();
            }
            self.dirty_stacks.push(stack);
        }
        split.release();
        self.deferred_stacks.retain(|&s| s != id);
    }

    /// Properties of a web view or video.
    fn set_native_props(&mut self, id: NodeId, props: nsh_core::NativeProps) {
        use nsh_core::NativeProps as P;
        let mut poster = None;
        {
            let Some(s) = self.slot_mut(id) else { return };
            match (&mut s.native, props) {
                (Native::Web(v), P::WebView(p)) => v.configure(*p),
                (Native::Video(v), P::Video(p)) => {
                    v.configure(*p);
                    poster = v.take_poster_request();
                }
                _ => {}
            }
        }
        if let Some(uri) = poster {
            self.load_video_poster(id, &uri);
        }
    }

    /// Loads video `id`'s poster at the video's display size.
    fn load_video_poster(&mut self, id: NodeId, uri: &str) {
        let (size, mode) = {
            let Some(s) = self.slot(id) else { return };
            let Native::Video(v) = &s.native else { return };
            (v.view.bounds().size, v.poster_mode())
        };
        let scale = self.display_scale();
        let max_pixels = (size.width.max(size.height) * scale).ceil() as u32;
        let key = crate::image::ImageLoader::key(uri, max_pixels, Default::default());
        match self
            .images
            .request(id, uri, None, max_pixels, scale, Default::default())
        {
            crate::image::Request::Ready(decoded) => {
                if let Some(s) = self.slot_mut(id)
                    && let Native::Video(v) = &mut s.native
                {
                    v.show_poster(decoded.image, mode);
                }
            }
            crate::image::Request::Pending => {
                if let Some(s) = self.slot_mut(id) {
                    s.poster_key = Some(key);
                }
            }
        }
    }

    /// Touch, accessibility and test properties.
    fn set_view_props(&mut self, id: NodeId, props: ViewProps) {
        let (control, mtm, target) = (self.control.clone(), self.mtm, self.target.clone());
        let native_id = props.native_id.clone();
        let edge_element = props.scroll_edge_element;
        let Some(s) = self.slot_mut(id) else { return };
        s.key_capture = props.key_capture.clone();
        s.disabled = props.accessibility.state.disabled;
        s.key_parent = props.key_parent;
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
        // The view's own pan follows the activation: a different one may
        // need a different recognizer.
        if s.pan_activation != activation {
            s.pan_activation = activation;
            if let Some(old) = s.gestures.pan.take() {
                let view = s.native.view();
                view.removeGestureRecognizer(&old);
                let pan = new_pan(mtm, &target, activation, s.pan_scroll_handoff);
                view.addGestureRecognizer(&pan);
                s.gestures.pan = Some(pan);
            }
        }
        let gated = nsh_core::input::gate_activation(&s.values, s.events, activation);
        sync_gate(&mut s.gestures.gate, s.native.view(), gated, mtm);
        if let Some(press) = &s.gestures.press {
            press.set_long_press_delay(props.long_press_delay);
        }
        // Only views that keep their props (which texts below look up).
        let area =
            (props.selectable_view && s.native.nsh().is_some()).then(|| s.native.view().retain());
        let was_area = self.areas.iter().any(|(a, _)| *a == id);
        let Some(s) = self.slot_mut(id) else { return };
        match s.native.nsh() {
            Some(view) => {
                view.set_props(props, &control);
                view.set_target(&target);
                view.update_focus_tap(&target);
            }
            None => {
                // Scroll views and inputs: only what UIKit offers directly.
                use objc2_ui_kit::{NSObjectUIAccessibility, UIAccessibilityIdentification};
                let view = s.native.view();
                let accessibility_view = match &s.native {
                    Native::Input(input) => input.editor_view(),
                    _ => view,
                };
                let test_id = props
                    .test_id
                    .as_deref()
                    .map(objc2_foundation::NSString::from_str);
                accessibility_view.setAccessibilityIdentifier(test_id.as_deref());
                let label = props
                    .accessibility
                    .label
                    .as_deref()
                    .map(objc2_foundation::NSString::from_str);
                accessibility_view.setAccessibilityLabel(label.as_deref(), mtm);
                view.setAccessibilityElementsHidden(props.accessibility.hidden, mtm);
                // An input that is no target lets touches through to the
                // views below it (an editor's hidden input at its caret,
                // over the selection's handles); it stays able to become
                // the first responder and take typed text.
                if matches!(s.native, Native::Input(_)) {
                    view.setUserInteractionEnabled(!matches!(
                        props.pointer_events,
                        nsh_core::PointerEvents::None | nsh_core::PointerEvents::BoxNone
                    ));
                }
            }
        }
        // After the props: the texts below read whether they are in an area.
        match (area, was_area) {
            (Some(view), false) => {
                let listens = self
                    .slot(id)
                    .is_some_and(|s| s.events.contains(EventKind::SelectionChange));
                let area = crate::selectable_view::AreaResponder::attach(
                    &view,
                    mtm,
                    self.control.clone(),
                    id,
                    listens,
                );
                self.areas.push((id, area));
            }
            (None, true) => {
                if let Some(i) = self.areas.iter().position(|(a, _)| *a == id) {
                    self.areas.remove(i).1.detach();
                }
            }
            _ => {}
        }
        // A scroll view the host may watch by its `nativeID`.
        if let Some(Slot {
            native: Native::Scroll(scroll),
            ..
        }) = self.slot(id)
        {
            let scroll = scroll.clone();
            self.scrolls
                .props(&self.scroll_watchers, id, &scroll, &self.target, native_id);
        }
        self.set_scroll_edge_element(id, edge_element);
    }

    /// `ios={{ scrollEdgeElement }}`: the view shapes the edge effect of
    /// the scroll view it names (`crate::scroll_edge`).
    fn set_scroll_edge_element(
        &mut self,
        id: NodeId,
        element: Option<nsh_core::ScrollEdgeElement>,
    ) {
        let scroll = element.and_then(|e| match self.slot(e.scroll_view) {
            Some(Slot {
                native: Native::Scroll(scroll),
                ..
            }) => Some((e.scroll_view, scroll.clone(), e.edge)),
            _ => None,
        });
        let named = scroll.as_ref().map(|&(node, _, edge)| (node, edge));
        let Some(s) = self.slot_mut(id) else { return };
        if named == s.edge_named {
            return;
        }
        let old = std::mem::replace(&mut s.edge_named, named);
        let view = s.native.view().retain();
        crate::scroll_edge::set(
            &view,
            &mut s.edge_element,
            scroll.as_ref().map(|(_, scroll, edge)| (&**scroll, *edge)),
        );
        if let Some((node, edge)) = old {
            self.unname_edge(node, edge);
        }
        if let Some((node, edge)) = named {
            self.name_edge(node, edge);
        }
    }

    /// One more view names `edge` of scroll view `node`: the first makes it
    /// soft.
    fn name_edge(&mut self, node: NodeId, edge: nsh_core::ScrollEdge) {
        if let Some(named) = self
            .soft_edges
            .iter_mut()
            .find(|(n, e, _)| (*n, *e) == (node, edge))
        {
            named.2 += 1;
            return;
        }
        self.soft_edges.push((node, edge, 1));
        if let Some(Slot {
            native: Native::Scroll(scroll),
            ..
        }) = self.slot(node)
        {
            crate::scroll_edge::set_style(scroll, edge, true);
        }
    }

    /// A view stops naming `edge` of scroll view `node`: once none does,
    /// the edge gets its automatic style back.
    fn unname_edge(&mut self, node: NodeId, edge: nsh_core::ScrollEdge) {
        let Some(i) = self
            .soft_edges
            .iter()
            .position(|(n, e, _)| (*n, *e) == (node, edge))
        else {
            return;
        };
        self.soft_edges[i].2 -= 1;
        if self.soft_edges[i].2 > 0 {
            return;
        }
        self.soft_edges.swap_remove(i);
        if let Some(Slot {
            native: Native::Scroll(scroll),
            ..
        }) = self.slot(node)
        {
            crate::scroll_edge::set_style(scroll, edge, false);
        }
    }

    /// Deleted node `id` no longer names an edge, and nothing names the
    /// edges of it any more (a new view may take its id).
    fn edges_deleted(&mut self, id: NodeId, named: Option<(NodeId, nsh_core::ScrollEdge)>) {
        if let Some((node, edge)) = named {
            self.unname_edge(node, edge);
        }
        if self.soft_edges.iter().any(|(n, ..)| *n == id) {
            self.soft_edges.retain(|(n, ..)| *n != id);
            for s in self.views.iter_mut().flatten() {
                if s.edge_named.is_some_and(|(n, _)| n == id) {
                    s.edge_named = None;
                }
            }
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
                let view = match &s.native {
                    Native::Input(input) => input.editor_view(),
                    _ => s.native.view(),
                };
                view.setAccessibilityLabel(label.as_deref(), mtm);
            }
        }
    }

    /// Give a tapped `focusable` view that takes no presses keyboard focus.
    /// An input using the software keyboard keeps focus so the layout stays
    /// in place under the finger.
    pub(crate) fn focus_node(&mut self, id: NodeId) {
        if !self.typing()
            && let Some(view) = self.slot(id).and_then(|s| s.native.focus_view())
            && view.is_focus_stop()
            && view.becomeFirstResponder()
        {
            crate::keyboard::request_focus(view);
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
        // A tap gives a control (a button, a select's trigger, a switch) no
        // keyboard focus, as UIKit's controls and Safari give none: with a
        // hardware keyboard, Return and Space stay the app's shortcuts
        // instead of pressing the control last tapped. A `focusable` view
        // that takes no presses takes it from its focus tap
        // (`handleFocusTap:`).
        if s.events.contains(event) {
            let payload = self.press_payload(id, at);
            self.control.dispatch_event(id, event, payload);
        }
    }

    /// Whether the software keyboard is up for the focused input: a touch
    /// on a control leaves it there, as UIKit's controls do, so the
    /// keyboard stays and the layout does not move under the finger.
    fn typing(&self) -> bool {
        self.focused.is_some() && self.keyboard > 0.0
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

    /// Presses the element the app put in a header slot (`leading`: the
    /// left one), as a tap on a system bar button does: the first view
    /// inside the slot that takes a press (the one made first), resolved now
    /// (the slot's content arrives after the button is made). A slot with
    /// none takes no press.
    pub(crate) fn press_header(&mut self, screen: NodeId, leading: bool) {
        let Some(Slot {
            native: Native::Screen(host),
            ..
        }) = self.slot(screen)
        else {
            return;
        };
        let Some(slot_node) = (if leading {
            host.config.left
        } else {
            host.config.right
        }) else {
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

    /// A trailing `ios.headerRightItems` press or menu action: the root's
    /// [`EventKind::Menu`] with the item's numeric id.
    pub(crate) fn menu_id_event(&self, id: u32) {
        self.control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", nsh_core::PayloadValue::Number(id as f64))]),
        );
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
    /// horizontal (vertical) movement, so it coexists with scrolling. A pan
    /// with a `panActivation` begins as the activation activates instead.
    pub(crate) fn pan_should_begin(&self, id: NodeId, velocity: CGPoint) -> bool {
        let Some(s) = self.slot(id) else { return true };
        if s.pan_activation.is_some() {
            return true;
        }
        match (s.values.pan_x.is_some(), s.values.pan_y.is_some()) {
            (true, false) => velocity.x.abs() > velocity.y.abs(),
            (false, true) => velocity.y.abs() > velocity.x.abs(),
            _ => true,
        }
    }

    /// A cooperating pan sees only scrolls between its view and the touch,
    /// never a scroll elsewhere in the sheet or behind its backdrop. `down`
    /// is where the pan's first finger goes down (window points), when this
    /// touch is that finger.
    pub(crate) fn pan_touch(&mut self, id: NodeId, touched: &UIView, down: Option<CGPoint>) {
        let Some(s) = self.slot_mut(id) else { return };
        if let Some(down) = down {
            s.pan_down = down;
        }
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
                    started: false,
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
                if t.y as f32 > touched.offset {
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
        let origin = self.pointer_positions(s.native.view(), s.pan_down).1;
        let payload = |m: &Self| {
            if state == UIGestureRecognizerState::Cancelled {
                EventPayload::PanCancelled {
                    translation: point(Points(t.x as f32), Points(t.y as f32)),
                    velocity_x: v.x as f32,
                    velocity_y: v.y as f32,
                    value_x: values.pan_x.map(|n| Points(m.animator.value(n))),
                    value_y: values.pan_y.map(|n| Points(m.animator.value(n))),
                    origin,
                }
            } else {
                EventPayload::Pan {
                    translation: point(Points(t.x as f32), Points(t.y as f32)),
                    velocity_x: v.x as f32,
                    velocity_y: v.y as f32,
                    value_x: values.pan_x.map(|n| Points(m.animator.value(n))),
                    value_y: values.pan_y.map(|n| Points(m.animator.value(n))),
                    origin,
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
            let deferred = self.slot(id).is_some_and(|s| s.pan_scroll.is_some());
            if events.contains(EventKind::PanStart) && !deferred {
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
                let y = self.slot(id).and_then(|s| s.pan_scroll.as_ref()).map_or(
                    start[1] + t.y as f32,
                    |scroll| {
                        // From where the value was (a sheet resting at a
                        // detent stands below 0): only the downward
                        // distance the scroll left over moves it.
                        start[1] + (t.y as f32 - scroll.offset).max(0.0)
                    },
                );
                let begins = y != start[1]
                    && self
                        .slot_mut(id)
                        .and_then(|s| s.pan_scroll.as_mut())
                        .is_some_and(|scroll| !std::mem::replace(&mut scroll.started, true));
                if begins && events.contains(EventKind::PanStart) {
                    self.control
                        .dispatch_event(id, EventKind::PanStart, payload(self));
                }
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
        self.frame_requested.set(true);
        self.frame_link.setPaused(false);
    }

    #[cfg(test)]
    pub(crate) fn frame_link_paused(&self) -> bool {
        self.frame_link.isPaused()
    }

    /// The frame link fired.
    pub(crate) fn frame(&mut self) {
        self.frame_link.setPaused(true);
        if self.frame_requested.replace(false) {
            self.control.frame();
        }
        if let Some(id) = self.backdrop_waiting.take()
            && let Some(slot) = self.slot(id)
            && slot.parent == Some(nsh_core::ROOT_ID)
        {
            let layer = slot.native.view().layer();
            if coverage_animation(&layer) == Some(CoverageAnimation::Finite) {
                self.wait_for_backdrop(Some(id));
            } else {
                self.follow_background();
            }
        }
    }

    /// The shaders' display link fired.
    pub(crate) fn shader_frame(&mut self) {
        self.shaders.frame();
    }

    /// The GPU views' display link fired.
    pub(crate) fn gpu_frame(&mut self) {
        self.gpu.frame(&self.control);
    }

    /// The GPU device the shaders asked for opened (`None`: there is none,
    /// which the app hears: `shadersAvailable()`).
    pub(crate) fn shaders_opened(&mut self, renderer: Option<nsh_engine::shader::Renderer>) {
        if self.shaders.opened(renderer) {
            self.control.shaders_unavailable();
        }
    }

    /// The display link of texts whose color transitions fired.
    pub(crate) fn text_color_frame(&mut self) {
        self.text_colors.frame();
    }

    /// Shader view `id` follows its frame and corners.
    fn layout_shader(&mut self, id: NodeId) {
        let scale = self.display_scale();
        if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref) {
            self.shaders.layout(id, &s.style, scale);
        }
    }

    /// GPU view `id` (if it is one) follows its frame and corners.
    fn layout_gpu(&mut self, id: NodeId) {
        if !self.gpu.has(id) {
            return;
        }
        let scale = self.display_scale();
        if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref) {
            self.gpu.resized(id, &s.style, scale);
        }
    }

    /// The root's children leave the container screen shaders draw them
    /// from once no screen shader is left.
    fn release_root_effect(&mut self) {
        if self.shaders.any_screen() {
            return;
        }
        if let Some(root) = self.slot_mut(nsh_core::ROOT_ID) {
            let view = root.native.view().retain();
            root.decor.set_effect(&view, false);
        }
    }

    /// The bound uniforms of shader view `id` onto its shader.
    fn push_shader_args(&mut self, id: NodeId) {
        if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref)
            && self.shaders.has(id)
        {
            self.shaders.set_args(id, shader_args(s, &self.animator));
        }
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
        let room = refresh_inset(s).0 as CGFloat;
        let own = s
            .behavior
            .as_ref()
            .is_some_and(|b| b.refresh_indicator.is_some());
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
            }) if *refreshing != on => {
                *refreshing = on;
                let mut inset = scroll.contentInset();
                let base = s
                    .behavior
                    .as_ref()
                    .map_or(0.0, |b| b.content_inset.top.0 as CGFloat);
                // The app's indicator is revealed below what UIKit adds; the
                // Mac idiom's spinner where it always was.
                let lead = if own { rest_top(scroll, base) } else { 0.0 };
                inset.top = base + if on { room } else { 0.0 };
                if on {
                    if let Some(spinner) = spinner {
                        spinner.startAnimating();
                    }
                    scroll.setContentInset(inset);
                    // Reveal the spinner if the list rests at its top. On the
                    // next turn: a release past the top has already started
                    // its bounce towards the old inset, which this replaces.
                    let scroll = MainThreadBound::new(scroll.clone(), mtm);
                    DispatchQueue::main().exec_async(move || {
                        let mtm = MainThreadMarker::new().expect("main queue");
                        let scroll = scroll.get(mtm);
                        let offset = scroll.contentOffset();
                        if offset.y <= -lead && !scroll.isDragging() {
                            scroll.setContentOffset_animated(
                                CGPoint::new(offset.x, -(lead + room)),
                                true,
                            );
                        }
                    });
                } else {
                    if let Some(spinner) = spinner {
                        spinner.stopAnimating();
                    }
                    let scroll = scroll.clone();
                    let block = block2::RcBlock::new(move || scroll.setContentInset(inset));
                    UIView::animateWithDuration_animations(0.25, &block, mtm);
                }
            }
            _ => {}
        }
    }

    /// The user released a drag: a far enough pull past the top starts a
    /// custom refresh (the app's indicator measures it from where the
    /// content rests).
    pub(crate) fn drag_ended(&mut self, id: NodeId, offset: CGPoint) {
        let Some(s) = self.slot(id) else { return };
        let Native::Scroll(scroll) = &s.native else {
            return;
        };
        let behavior = s.behavior.as_deref().cloned().unwrap_or_default();
        let pulled = if behavior.refresh_indicator.is_some() {
            offset.y + rest_top(scroll, behavior.content_inset.top.0 as CGFloat)
        } else {
            offset.y
        };
        if let Some(Refresh::Custom {
            refreshing: false, ..
        }) = s.gestures.refresh
            && behavior.refreshes(Points(pulled as f32))
        {
            self.set_refreshing(id, true);
            self.control
                .dispatch_event(id, EventKind::Refresh, EventPayload::None);
        }
    }

    /// UIKit's refresh control `control`, made for scroll view `id`, was
    /// pulled. Only the control that scroll view holds now refreshes it: one
    /// left over from a deleted view (whose id a new view may take) or
    /// replaced by another indicator reports nothing.
    pub(crate) fn refresh_pulled(&self, id: NodeId, control: &UIRefreshControl) {
        let held = self.slot(id).and_then(|s| s.gestures.refresh.as_ref());
        if holds_refresh(held, control) {
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
        // Shader and GPU views scrolled back into sight render what fell
        // due.
        self.shaders.revisit();
        self.gpu.reveal();
        if self.shaders.pictured()
            && let Some(s) = self.views.get(id as usize).and_then(Option::as_ref)
        {
            self.shaders.ui_changed(s.native.view());
        }
        for (_, area) in &self.areas {
            area.scrolled();
        }
        let Some(s) = self.slot(id) else { return };
        let mut fed = false;
        if let Some(node) = s.scroll_value {
            let value = if s.horizontal { offset.x } else { offset.y };
            self.animator.set(node, value as f32);
            fed = true;
        }
        if let Some(s) = self.slot_mut(id)
            && let Some(node) = s.pull_value
            && let Native::Scroll(scroll) = &s.native
        {
            let base = s
                .behavior
                .as_ref()
                .map_or(0.0, |b| b.content_inset.top.0 as CGFloat);
            let pull = (-offset.y - rest_top(scroll, base)).max(0.0);
            if pull != s.pull {
                s.pull = pull;
                self.animator.set(node, pull as f32);
                fed = true;
            }
        }
        if fed {
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

    /// Lays the stacks inside [`Mounter::untransformed`] out again.
    ///
    /// UIKit lays a stack out through the transforms around it: a header
    /// that changes while a container shows the stack moved or scaled (a
    /// push drawer) gets its bar laid out for that picture, which puts a bar
    /// the device keeps along one side of the screen (the iPhone Duo's
    /// vertical bar) on the side the picture is nearest. A transform going
    /// back to the identity starts no layout pass, so the bar would stay
    /// there, and the stack's safe area with what it was measured through
    /// the transform, until something else lays it out.
    fn lay_out_untransformed(&mut self) {
        if self.untransformed.is_empty() {
            return;
        }
        let views: Vec<Retained<UIView>> = std::mem::take(&mut self.untransformed)
            .into_iter()
            .filter_map(|id| self.slot(id).map(|s| s.native.view().retain()))
            .collect();
        let inside = |nav: &UINavigationController| {
            nav.viewIfLoaded()
                .is_some_and(|v| views.iter().any(|t| v.isDescendantOfView(t)))
        };
        for slot in self.views.iter().flatten() {
            if let Native::Stack(stack) = &slot.native
                && inside(&stack.nav)
            {
                crate::navigation::lay_out_in_place(&stack.nav);
            }
        }
        // A collapsed split's pages are in its compact stack.
        for split in self.splits.values() {
            if inside(&split.compact.nav) {
                crate::navigation::lay_out_in_place(&split.compact.nav);
            }
        }
    }

    fn apply_animations(&mut self) {
        let animator = &self.animator;
        for &id in &self.animated {
            if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref)
                && apply_dynamic(s, animator)
            {
                self.untransformed.push(id);
            }
        }
        // Shaders get their bound uniforms; those that picture the views
        // take them again.
        let pictured = self.shaders.pictured();
        for &id in &self.animated {
            if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref) {
                if self.shaders.has(id) {
                    self.shaders.set_args(id, shader_args(s, animator));
                }
                if pictured {
                    self.shaders.ui_changed(s.native.view());
                }
            }
        }
        // GPU views' renderers get their bound props' changes.
        for &id in &self.animated {
            if let Some(s) = self.views.get(id as usize).and_then(Option::as_ref) {
                self.gpu.animated(id, &s.bindings, animator);
            }
        }
        // Components get their bound props' changes (no view borrowed while
        // they run but their own slot).
        for &id in &self.animated {
            if let Some(Some(s)) = self.views.get_mut(id as usize)
                && let Native::Component(host) = &mut s.native
            {
                host.push(&s.bindings, animator);
            }
        }
        // Sticky cells that stick an animated value further in follow it.
        for (&id, cells) in &self.sticky {
            if cells.iter().any(|c| c.offset.is_some()) {
                self.pin_sticky(id);
            }
        }
        self.lay_out_untransformed();
        if let Some((id, previous)) = self.animated_backdrop {
            self.follow_animated_background(id, previous);
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
        // The app stopped: the host's handles to its scroll views die.
        self.scrolls.clear(&self.scroll_watchers);
        // The link retains its target; invalidating breaks the cycle.
        self.frame_link.invalidate();
    }
}

/// The first scroll view in `view`'s subtree (breadth first).
pub(crate) fn first_scroll_view(view: &UIView) -> Option<Retained<UIScrollView>> {
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
/// A view's own pan, as its `panActivation` asks: an edge pan is the
/// system's screen edge pan (which waits for a stack's swipe back, see
/// `gestureRecognizer:shouldRequireFailureOfGestureRecognizer:`); a pan
/// along a way or past offsets begins as the activation activates.
fn new_pan(
    mtm: MainThreadMarker,
    target: &Retained<EventTarget>,
    activation: Option<nsh_core::PanActivation>,
    handoff: bool,
) -> Retained<UIPanGestureRecognizer> {
    use nsh_core::PanEdge;
    use objc2_ui_kit::{UIRectEdge, UIScreenEdgePanGestureRecognizer};
    let action = sel!(handlePan:);
    let r: Retained<UIPanGestureRecognizer> = match activation {
        Some(nsh_core::PanActivation {
            edge: Some(edge), ..
        }) => {
            // SAFETY: `EventTarget` implements `handlePan:` and outlives
            // the recognizer (the mounter keeps both).
            let r = unsafe {
                UIScreenEdgePanGestureRecognizer::initWithTarget_action(
                    UIScreenEdgePanGestureRecognizer::alloc(mtm),
                    Some(target),
                    Some(action),
                )
            };
            r.setEdges(match edge {
                PanEdge::Left => UIRectEdge::Left,
                PanEdge::Right => UIRectEdge::Right,
                PanEdge::Top => UIRectEdge::Top,
                PanEdge::Bottom => UIRectEdge::Bottom,
                // An edge this backend does not know starts no pan.
                _ => UIRectEdge::None,
            });
            Retained::into_super(r)
        }
        Some(a) => Retained::into_super(crate::touch::ActivatedPan::new(mtm, a, target, action)),
        // SAFETY: as above.
        None => unsafe {
            UIPanGestureRecognizer::initWithTarget_action(
                UIPanGestureRecognizer::alloc(mtm),
                Some(target),
                Some(action),
            )
        },
    };
    r.setDelegate(Some(ProtocolObject::from_ref(&**target)));
    if handoff {
        r.setMaximumNumberOfTouches(1);
    }
    r
}

/// Adds or removes the gate of a view's `panActivation` (`PanGate`), which
/// decides with `activation` (`nsh_core::input::gate_activation`): none
/// while neither the view's native pan nor its responder follows the
/// activation, so that a view whose pan is off leaves the drags to its
/// content, among them a stack's swipe back from the middle of its page,
/// which the gate would otherwise prevent.
fn sync_gate(
    gate: &mut Option<Retained<crate::touch::PanGate>>,
    view: &UIView,
    activation: Option<nsh_core::PanActivation>,
    mtm: MainThreadMarker,
) {
    toggle(gate, activation.is_some(), view, || {
        crate::touch::PanGate::new(mtm, activation.unwrap_or_default())
    });
    if let (Some(gate), Some(a)) = (gate.as_ref(), activation) {
        gate.set_activation(a);
    }
}

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
        alt_graph: false,
    }
}

fn viewport_size(size: CGSize) -> Size<Points> {
    Size::new(Points(size.width as f32), Points(size.height as f32))
}

/// The backdrop color and whether a finite native animation temporarily blocks it.
fn backdrop_color(slot: &Slot, viewport: CGSize, animator: &Animator) -> (Option<Color>, bool) {
    let view = slot.native.view();
    if !slot.style.radii().is_zero()
        || slot.style.clip_path().is_some()
        || slot
            .style
            .effects
            .as_ref()
            .is_some_and(|e| !e.mask_images.is_empty())
        || slot.style.animation.is_some()
        || view.isHidden()
        || view.alpha() != 1.0
    {
        return (None, false);
    }
    let layer = view.layer();
    if !layer.transform().is_identity() {
        return (None, false);
    }
    let color = opaque_backdrop(view.frame(), viewport, dynamic_background(slot, animator));
    match color.and_then(|_| coverage_animation(&layer)) {
        Some(CoverageAnimation::Finite) => (None, true),
        Some(CoverageAnimation::Persistent) => (None, false),
        None => (color, false),
    }
}

fn opaque_backdrop(frame: CGRect, viewport: CGSize, color: Color) -> Option<Color> {
    let (width, height) = (viewport.width, viewport.height);
    (color.0 & 0xff == 0xff
        && width > 0.0
        && height > 0.0
        && frame.origin.x <= 0.0
        && frame.origin.y <= 0.0
        && frame.origin.x + frame.size.width >= width
        && frame.origin.y + frame.size.height >= height)
        .then_some(color)
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
fn dynamic_background(slot: &Slot, animator: &Animator) -> Color {
    let mut background = slot.style.background_color;
    for &(prop, node) in &slot.bindings {
        if prop == AnimationProp::BackgroundColor
            && let AnimationValue::Color(c) = animator.eval(node)
        {
            background = Color(c);
        }
    }
    background
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

/// The style to shape a view's decoration by when its border color is
/// bound: the bound color in place of the static one, and the layers for it
/// made even while it is transparent (it may not stay so).
fn bound_style(slot: &Slot, animator: &Animator) -> Option<ViewStyle> {
    let node = slot
        .bindings
        .iter()
        .find_map(|&(p, node)| (p == AnimationProp::BorderColor).then_some(node))?;
    let mut style = slot.style.clone();
    if let AnimationValue::Color(c) = animator.eval(node) {
        style.borders.colors = [Color(c | 0xff); 4];
    }
    Some(style)
}

/// Bound border colors onto the layers made for them.
fn apply_bound_decor(slot: &Slot, animator: &Animator) {
    let view = slot.native.view();
    for &(prop, node) in &slot.bindings {
        if prop == AnimationProp::BorderColor
            && let AnimationValue::Color(c) = animator.eval(node)
        {
            slot.decor.set_border_color(view, Color(c))
        }
    }
}

/// The values of a shader view's animated uniforms (its slots).
fn shader_args<'a>(
    slot: &'a Slot,
    animator: &'a Animator,
) -> impl Iterator<Item = (u16, AnimationValue)> + 'a {
    slot.bindings.iter().filter_map(|&(prop, node)| match prop {
        AnimationProp::CanvasArg(k) => Some((k, animator.eval(node))),
        _ => None,
    })
}

/// Opacity, background color and transform: static values overridden by
/// animated bindings. True when the view's transform went back to the
/// identity, which UIKit lays nothing out for ([`Mounter::untransformed`]).
fn apply_dynamic(slot: &Slot, animator: &Animator) -> bool {
    if let Native::Canvas(canvas) = &slot.native {
        canvas.set_values(slot.bindings.iter().filter_map(|&(prop, node)| match prop {
            AnimationProp::CanvasArg(k) => Some((k, animator.eval(node))),
            _ => None,
        }));
    }
    let view = slot.native.view();
    view.setAlpha(dynamic_opacity(slot, animator) as CGFloat);
    slot.decor
        .set_background(view, dynamic_background(slot, animator));
    let layer = view.layer();
    let transform = dynamic_transform(slot, animator);
    let untransformed = transform.is_identity() && !layer.transform().is_identity();
    layer.setTransform(transform);
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
    untransformed
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
    let (duration, delay) = (t.run_ms() as f64 / 1000.0, t.delay_ms as f64 / 1000.0);
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
        LayoutCurve::FittedSpring { damping_ratio } => {
            UIView::animateWithDuration_delay_usingSpringWithDamping_initialSpringVelocity_options_animations_completion(
                duration,
                delay,
                damping_ratio as CGFloat,
                0.0,
                base,
                &block,
                None,
                mtm,
            )
        }
        // UIKit's own spring of the same physics, which UIKit times by the
        // physics (`duration`, the time it settles in, is left aside).
        LayoutCurve::Spring(spring) => {
            let timing = UISpringTimingParameters::initWithMass_stiffness_damping_initialVelocity(
                UISpringTimingParameters::alloc(mtm),
                spring.mass as CGFloat,
                spring.stiffness as CGFloat,
                spring.damping as CGFloat,
                CGVector { dx: 0.0, dy: 0.0 },
            );
            let animator = UIViewPropertyAnimator::initWithDuration_timingParameters(
                UIViewPropertyAnimator::alloc(mtm),
                duration,
                ProtocolObject::from_ref(&*timing),
            );
            animator.addAnimations(&block);
            animator.startAnimationAfterDelay(delay);
        }
        // UIKit's cubic timing of the same control points.
        LayoutCurve::Bezier([x1, y1, x2, y2]) => {
            let timing = UICubicTimingParameters::initWithControlPoint1_controlPoint2(
                UICubicTimingParameters::alloc(mtm),
                CGPoint::new(x1 as CGFloat, y1 as CGFloat),
                CGPoint::new(x2 as CGFloat, y2 as CGFloat),
            );
            let animator = UIViewPropertyAnimator::initWithDuration_timingParameters(
                UIViewPropertyAnimator::alloc(mtm),
                duration,
                ProtocolObject::from_ref(&*timing),
            );
            animator.addAnimations(&block);
            animator.startAnimationAfterDelay(delay);
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
        t.run_ms() as f64 / 1000.0,
        t.delay_ms as f64 / 1000.0,
        UIViewAnimationOptions::BeginFromCurrentState,
        &block,
        Some(&done),
        mtm,
    );
}

/// The user asked for less motion: pages and dialogs come and go with
/// UIKit's own motion, not through their `transitionShader`.
/// What a split's native component shows: the view its controller's view
/// fills ([`crate::split::SplitHost::holder`]).
struct SplitHolder(Retained<UIView>);

impl crate::component::NativeComponent for SplitHolder {
    fn view(&self) -> &UIView {
        &self.0
    }

    fn set_prop(&mut self, _name: &str, _value: Option<&nsh_core::JsonValue>) {}
}

/// The page on top of `split`'s compact stack.
fn compact_top(split: &crate::split::SplitHost) -> Option<NodeId> {
    split
        .compact
        .nav
        .topViewController()
        .and_then(|c| c.downcast::<crate::navigation::ScreenController>().ok())
        .map(|c| c.screen_id())
}

pub(crate) fn reduce_motion() -> bool {
    objc2_ui_kit::UIAccessibilityIsReduceMotionEnabled()
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::px;

    use super::*;

    #[test]
    fn only_an_opaque_view_covering_the_viewport_supplies_a_backdrop() {
        let viewport = CGSize::new(390.0, 844.0);
        let full = CGRect::new(CGPoint::ZERO, viewport);
        for color in [Color::BLACK, Color::rgba(242, 242, 247, 255)] {
            assert_eq!(opaque_backdrop(full, viewport, color), Some(color));
        }
        assert_eq!(opaque_backdrop(full, viewport, Color::TRANSPARENT), None);
        assert_eq!(
            opaque_backdrop(full, viewport, Color::rgba(0, 0, 0, 254)),
            None
        );
        let shifted = CGRect::new(CGPoint::new(1.0, 0.0), full.size);
        assert_eq!(opaque_backdrop(shifted, viewport, Color::BLACK), None);
        assert_eq!(
            opaque_backdrop(full, CGSize::new(844.0, 390.0), Color::BLACK),
            None
        );
    }

    #[test]
    fn a_new_input_has_its_layout_before_insertion() {
        let frame = Bounds::new(point(px(12.0), px(20.0)), size(px(240.0), px(36.0)));
        let content = Bounds::new(point(px(12.0), px(8.0)), size(px(216.0), px(20.0)));
        let items = vec![
            MountItem::Create {
                id: 2,
                kind: ViewKind::Input,
            },
            MountItem::Insert {
                parent: nsh_core::ROOT_ID,
                child: 2,
                before: None,
            },
            MountItem::Frame { id: 2, frame },
            MountItem::InputContent { id: 2, content },
        ];

        assert_eq!(
            initial_input_layouts(&items).get(&2),
            Some(&InitialInputLayout {
                frame: Some(frame),
                content: Some(content),
            })
        );
    }

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

    /// iOS 26 moves a scroll view's refresh control under a large title into
    /// an untagged container: the control still names its own scroll view,
    /// never node 0 from the container.
    #[test]
    #[ignore = "requires a UIKit main-thread harness"]
    fn a_reparented_refresh_control_names_its_scroll_view() {
        let mtm = MainThreadMarker::new().expect(
            "UIKit views need the main thread: run this test from a UIKit main-thread harness, not a plain `cargo test` thread",
        );
        let scroll = UIScrollView::new(mtm);
        scroll.setTag(6);
        let control = refresh_control(6, mtm);
        scroll.setRefreshControl(Some(&control));
        assert_eq!(refresh_owner(&control), 6);

        let container = UIView::new(mtm);
        scroll.addSubview(&container);
        container.addSubview(&control);
        assert_eq!(control.superview().map(|v| v.tag()), Some(0));
        assert_eq!(refresh_owner(&control), 6);
    }

    /// Only the control a scroll view holds now refreshes it: one it replaced,
    /// or one of a deleted view whose id a new view took, is not it.
    #[test]
    #[ignore = "requires a UIKit main-thread harness"]
    fn only_the_held_refresh_control_refreshes() {
        let mtm = MainThreadMarker::new().expect(
            "UIKit views need the main thread: run this test from a UIKit main-thread harness, not a plain `cargo test` thread",
        );
        let (old, new) = (refresh_control(6, mtm), refresh_control(6, mtm));
        let held = Refresh::Native(new.clone());
        assert!(holds_refresh(Some(&held), &new));
        assert!(!holds_refresh(Some(&held), &old));
        // Deleted, or switched to a pull detected here.
        assert!(!holds_refresh(None, &new));
        let custom = Refresh::Custom {
            spinner: None,
            refreshing: false,
        };
        assert!(!holds_refresh(Some(&custom), &new));
    }
}
