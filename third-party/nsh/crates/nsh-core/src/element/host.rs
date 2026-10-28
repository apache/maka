//! The host elements beyond views, texts and images: inputs, scroll views,
//! navigation stacks and their screens, modals, canvases, web views, videos
//! and the embedder's native components, with their props and typed events. Their props are the
//! core's [`Prop`]s, kept per element and diffed by kind: a prop an
//! element's binding (or a region's element made again) no longer sets
//! goes back to its default, as when JS clears it.

use std::sync::Arc;

use super::{
    Accessible, AnyElement, Interactive, IntoReactive,
    builder::{ElNode, Element, IntoElement, IntoListener, Listener, ParentElement},
    events::{
        self, CaretEvent, Composition, NativeEvent, OverlayPosition, Selection, VideoInfo,
        VideoProgress, WebNavigation,
    },
};
use crate::{
    AudioSession, AutoCapitalize, AutoFill, Color, EventKind, HeaderSlot, Hsla, JsonValue,
    KeyboardAppearance, KeyboardType, ModalAnimation, ModalPresentation, ModalProp, NativeProp,
    OverlayProp, PasteBehavior, PasteEvent, Points, Prop, ResizeMode, ReturnKeyType, Rgba,
    ScreenAnimation, ScreenProp, ScrollProp, Size, StatusBarSetting, SubmitBehavior, Tag,
    WebSource,
    canvas::{
        CanvasFont, CanvasGradient, CanvasImage, CanvasOp, CanvasTextAlign, CanvasTextBaseline,
        Composite, Drawing, FillRule, LineCap, LineJoin, Num, Paint, Path, PathOp, ViewPaint,
    },
    geometry::{Bounds, Corners, Point, Radians, ScaledPixels},
    js::host::HostProps,
    overlay::{Align, OverlayAnchor, Placement},
    style::SvgPaint,
};

/// Whether `a` and `b` set the same property (their values aside).
pub(crate) fn same_kind(a: &Prop, b: &Prop) -> bool {
    match (a, b) {
        (Prop::ComponentProp(a, _), Prop::ComponentProp(b, _)) => a == b,
        (Prop::ComponentPropBinding(a, _), Prop::ComponentPropBinding(b, _)) => a == b,
        (Prop::RustProp(a, _), Prop::RustProp(b, _)) => a == b,
        _ => HostProps::same_kind(a, b),
    }
}

/// `prop`'s property at its default (what clearing it from JS sets), for
/// the props elements set; `None` for those set once.
pub(crate) fn reset(prop: &Prop) -> Option<Prop> {
    match prop {
        Prop::ComponentProp(name, _) => Some(Prop::ComponentProp(name.clone(), None)),
        Prop::ComponentPropBinding(name, _) => Some(Prop::ComponentPropBinding(name.clone(), None)),
        Prop::RustProp(name, _) => Some(Prop::RustProp(name, None)),
        _ => HostProps::reset(prop),
    }
}

/// Sets `prop` on `node`, replacing the value of the same property.
pub(crate) fn set(node: &mut ElNode, prop: Prop) {
    set_in(&mut node.attrs.props, prop);
}

crate::static_reactive!(Color: Color);
crate::static_reactive!(Hsla: Hsla, Rgba, Color);
crate::static_reactive!(crate::AccessibilityRole: crate::AccessibilityRole);
crate::static_reactive!(AutoCapitalize: AutoCapitalize);
crate::static_reactive!(AutoFill: AutoFill);
crate::static_reactive!(crate::HeaderSystemItem: crate::HeaderSystemItem);
crate::static_reactive!(KeyboardAppearance: KeyboardAppearance);
crate::static_reactive!(KeyboardType: KeyboardType);
crate::static_reactive!(ModalAnimation: ModalAnimation);
crate::static_reactive!(ModalPresentation: ModalPresentation);
crate::static_reactive!(ResizeMode: ResizeMode);
crate::static_reactive!(ReturnKeyType: ReturnKeyType);
crate::static_reactive!(SubmitBehavior: SubmitBehavior);
crate::static_reactive!(PasteBehavior: PasteBehavior);
crate::static_reactive!(Vec<crate::input_tokens::InputTokenRule>: Vec<crate::input_tokens::InputTokenRule>);
crate::static_reactive!(crate::EllipsizeMode: crate::EllipsizeMode);
crate::static_reactive!(JsonValue: JsonValue);
crate::static_reactive!(StatusBarSetting: StatusBarSetting, crate::StatusBarStyle);
crate::static_reactive!(Placement: Placement);
crate::static_reactive!(Align: Align);
crate::static_reactive!(OverlayAnchor: OverlayAnchor);

/// Sets `prop` among `props`, replacing one of its kind.
pub(crate) fn set_in(props: &mut Vec<Prop>, prop: Prop) {
    match props.iter_mut().find(|p| same_kind(p, &prop)) {
        Some(p) => *p = prop,
        None => props.push(prop),
    }
}

/// Sets the prop `prop` makes of `value`: now when it is static, else as a
/// bound part.
pub(crate) fn bind_prop<T: 'static>(
    node: &mut ElNode,
    value: impl IntoReactive<T>,
    prop: impl Fn(T) -> Prop + 'static,
) {
    node.bind_attr(value, move |attrs, v| set_in(&mut attrs.props, prop(v)));
}

/// Adds a typed listener of `kind`.
fn listen<T: ?Sized + ToOwned + 'static>(
    node: &mut ElNode,
    kind: EventKind,
    listener: Listener<T>,
    decode: events::Decode<T>,
) {
    node.handlers.push((kind, events::typed(listener, decode)));
}

macro_rules! host_element {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone)]
        pub struct $name(ElNode);

        impl Element for $name {
            fn node(&mut self) -> &mut ElNode {
                &mut self.0
            }
        }

        impl IntoElement for $name {
            fn into_element(self) -> AnyElement {
                AnyElement(self.0)
            }
        }

        impl Accessible for $name {}
        impl Interactive for $name {}

        impl super::builder::IntoTooltip for $name {
            fn apply_tooltip(self, node: &mut ElNode) {
                self.into_element().apply_tooltip(node);
            }
        }

        // Not every element has props of its own and events.
        #[allow(dead_code)]
        impl $name {
            fn set(mut self, prop: Prop) -> Self {
                set(&mut self.0, prop);
                self
            }

            fn bind_prop<T: 'static>(
                mut self,
                value: impl IntoReactive<T>,
                prop: impl Fn(T) -> Prop + 'static,
            ) -> Self {
                bind_prop(&mut self.0, value, prop);
                self
            }

            fn listen<T: ?Sized + ToOwned + 'static>(
                mut self,
                kind: EventKind,
                listener: Listener<T>,
                decode: events::Decode<T>,
            ) -> Self {
                listen(&mut self.0, kind, listener, decode);
                self
            }
        }
    };
}

host_element! {
    /// A text field (`<input>`), made by [`input`]: one line, or several
    /// with [`Input::multiline`]. Its text style comes from its styles.
    Input
}

host_element! {
    /// A scroll view (`<scroll>`), made by [`scroll`]: its children are its
    /// content.
    Scroll
}

host_element! {
    /// A native navigation stack (`<stack>`, TS: `NavStack` of `nsh/base`),
    /// made by `nsh_base::nav_stack`:
    /// UINavigationController on iOS (swipe back, native header), a stack
    /// with a toolbar and predictive back on Android. Its children are its
    /// [`Screen`]s, bottom to top.
    Stack
}

host_element! {
    /// One page of a [`Stack`] (`<screen>`, TS: `NavPage` of `nsh/base`),
    /// made by `nsh_base::nav_page`: its header options and its content (its
    /// children).
    Screen
}

host_element! {
    /// A dialog (`<modal>`, TS: `Dialog` of `nsh/base`), made by
    /// `nsh_base::dialog`: presented while it is in the view, over everything
    /// else; its children are its content.
    Modal
}

host_element! {
    /// A bar over the keyboard (`<inputaccessory>`, TS: `InputAccessoryView`
    /// of `nsh/ios`), made by [`input_accessory_view`]: its children are its
    /// content.
    InputAccessoryView
}

host_element! {
    /// A view drawn with a [`Drawing`] (`<canvas>`), made by [`canvas`].
    CanvasView
}

host_element! {
    /// A view whose box a shader draws under its children (`<shader>`, TS:
    /// `Shader` of `nsh`), made by [`shader`] ([`crate::shader`]).
    ShaderView
}

host_element! {
    /// A web page (`<webview>`), made by [`web_view`].
    WebView
}

host_element! {
    /// A video player (`<video>`), made by [`video`].
    Video
}

host_element! {
    /// A native component the embedding app registered (`<native>`), made
    /// by [`native`].
    NativeView
}

host_element! {
    /// Its children on top of the root view it is in (`<overlay>`, TS:
    /// `Overlay` of `nsh`), made by [`overlay`]: the surface, or the dialog
    /// around it; outside its parent's layout and clipping, while it stays
    /// where it is for everything else (context, events, lifetime).
    Overlay
}

impl ParentElement for Overlay {}
impl ParentElement for ShaderView {}
impl ParentElement for Scroll {}
impl ParentElement for Stack {}
impl ParentElement for Screen {}
impl ParentElement for Modal {}

/// Android has no input accessories: there the bar keeps no content.
impl ParentElement for InputAccessoryView {
    fn child<M>(mut self, child: impl super::IntoChild<M>) -> Self {
        if !cfg!(target_os = "android") {
            child.__push_into(&mut self.0.children);
        }
        self
    }

    fn children(mut self, children: impl IntoIterator<Item = impl IntoElement>) -> Self {
        if !cfg!(target_os = "android") {
            self.0
                .children
                .extend(children.into_iter().map(|c| c.into_element().0));
        }
        self
    }
}

/// An overlay: its children shown on top of the root view it is in (the
/// surface, or the dialog around it), above what that root view shows and
/// the overlays shown before it, while it is in the view (in a region:
/// [`super::If`]). Without an anchor it is laid out as a `position: fixed`
/// box of the root view (`.absolute().inset_0()` covers it); with one
/// ([`Overlay::anchor`], [`Overlay::anchor_point`]) it goes on a side of it
/// and follows it ([`crate::overlay`]).
pub fn overlay() -> Overlay {
    Overlay(ElNode::new(Tag::Overlay))
}

/// A text field.
pub fn input() -> Input {
    Input(ElNode::new(Tag::Input))
}

/// A vertical scroll view ([`Scroll::horizontal`] for a horizontal one).
pub fn scroll() -> Scroll {
    Scroll(ElNode::new(Tag::Scroll))
}

/// A native navigation stack of [`screen`]s: put a screen in to push it,
/// leave it out to pop it. Give each screen a [`Element::key`] (its route)
/// so the screens below keep their state.
///
/// The core's part of `nsh_base::nav_stack`, which apps use.
#[doc(hidden)]
pub fn stack() -> Stack {
    Stack(ElNode::new(Tag::Stack))
}

/// A screen of a [`stack`]. What it shows reads its insets below the
/// header ([`super::Scope::insets`]).
///
/// The core's part of `nsh_base::nav_page`, which apps use.
#[doc(hidden)]
pub fn screen() -> Screen {
    let mut node = ElNode::new(Tag::Screen);
    // Its insets come with this event.
    node.handlers.push((EventKind::Insets, Listener::noop()));
    Screen(node)
}

/// A modal presenting its children. Put it in the view to present it (in
/// a region: [`super::If`]), leave it out to dismiss it.
///
/// The core's part of `nsh_base::dialog`, which apps use.
#[doc(hidden)]
pub fn modal() -> Modal {
    let mut node = ElNode::new(Tag::Modal);
    // Its insets (`Scope::insets` inside it) come with this event.
    node.handlers.push((EventKind::Insets, Listener::noop()));
    Modal(node)
}

/// A bar shown over the keyboard of the inputs whose
/// [`Input::input_accessory`] is `native_id` (iOS's `inputAccessoryView`):
/// as wide as the window and as tall as its content, moving with the
/// keyboard natively. It takes no room where the view places it; on
/// Android, which has no input accessories, it is an empty hidden view.
pub fn input_accessory_view(native_id: &str) -> InputAccessoryView {
    let tag = if cfg!(target_os = "android") {
        Tag::View
    } else {
        Tag::InputAccessory
    };
    let mut node = ElNode::new(tag);
    if cfg!(target_os = "android") {
        node.style.value(
            crate::StyleKey::Display,
            crate::PropertyValue::Display(taffy::Display::None),
        );
    } else {
        set(&mut node, Prop::NativeId(Some(native_id.into())));
    }
    InputAccessoryView(node)
}

/// A canvas showing what `painter` recorded (animated values in it move
/// natively). A closure draws in a binding: `canvas(move || draw(theme()))`
/// draws again when what it read changes (a size kept from `on_layout`,
/// the appearance).
pub fn canvas(painter: impl IntoReactive<Painter>) -> CanvasView {
    let mut node = ElNode::new(Tag::Canvas);
    node.bind_attr(painter, |attrs, painter: Painter| {
        attrs.drawing = Some(Arc::new(painter.drawing));
        attrs.bound = painter.nodes;
    });
    CanvasView(node)
}

crate::static_reactive!(Painter: Painter, Drawing);

/// A view whose box a shader draws, under its children: give it the
/// program with [`ShaderView::source`] and its uniforms with
/// [`ShaderView::uniform`]. Without a program it draws nothing of its own.
pub fn shader() -> ShaderView {
    ShaderView(ElNode::new(Tag::Shader))
}

crate::static_reactive!(crate::shader::Shader: crate::shader::Shader);

/// A value [`ShaderView::uniform`] takes ([`IntoUniform`]).
pub struct Uniform(UniformSource);

enum UniformSource {
    Value(super::Reactive<crate::shader::UniformValue>),
    Animated(super::AnimatedNode),
}

/// What [`ShaderView::uniform`] takes: a number, a color or a list, bound
/// or not, or an animated value (`&AnimatedValue`, `&AnimatedNode`).
pub trait IntoUniform {
    /// As a [`Uniform`].
    fn into_uniform(self) -> Uniform;
}

impl<T: IntoReactive<crate::shader::UniformValue>> IntoUniform for T {
    fn into_uniform(self) -> Uniform {
        Uniform(UniformSource::Value(self.into_reactive()))
    }
}

impl IntoUniform for &super::AnimatedValue {
    fn into_uniform(self) -> Uniform {
        Uniform(UniformSource::Animated(super::Animated::animated_node(
            self,
        )))
    }
}

impl IntoUniform for &super::AnimatedNode {
    fn into_uniform(self) -> Uniform {
        Uniform(UniformSource::Animated(*self))
    }
}
crate::static_reactive!(
    crate::shader::UniformValue: crate::shader::UniformValue,
    f32,
    i32,
    Color,
    Hsla,
    [f32; 2],
    [f32; 3],
    [f32; 4],
    Vec<crate::shader::UniformValue>
);

impl ShaderView {
    /// The program that draws its box, compiled once with
    /// [`Shader::compile`](crate::shader::Shader::compile) (a bound one
    /// draws the new program when it changes).
    pub fn source(self, shader: impl IntoReactive<crate::shader::Shader>) -> Self {
        self.bind_prop(shader, |s| Prop::Shader(Some(s)))
    }

    /// Sets the member `name` of the shader's `struct Uniforms` to `value`
    /// ([`IntoUniform`]): a number, a color or a list (a vector, an array of
    /// `vec4f`), which a bound value (`move || …`) sets again when it
    /// changes; or an animated value (`&wave`, a number, or colors for a
    /// `vec3f` / `vec4f`), which the platform writes on every frame it
    /// changes, without the engine (one whose owner is gone counts as 0).
    pub fn uniform(mut self, name: &str, value: impl IntoUniform) -> Self {
        let name: Arc<str> = name.into();
        let value = match value.into_uniform().0 {
            UniformSource::Value(value) => value,
            UniformSource::Animated(node) => {
                let value = match node.live() {
                    Some(node) => {
                        let id = node.id();
                        self.0.attrs.bound.push(node);
                        crate::shader::UniformValue::Animated(id)
                    }
                    None => crate::shader::UniformValue::Number(0.0),
                };
                super::Reactive::Static(value)
            }
        };
        self.0.bind_attr(value, move |attrs, value| {
            let mut uniforms = attrs
                .props
                .iter()
                .find_map(|p| match p {
                    Prop::Uniforms(u) => Some(u.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            match uniforms.0.iter_mut().find(|(n, _)| *n == name) {
                Some(entry) => entry.1 = value,
                None => uniforms.0.push((name.clone(), value)),
            }
            set_in(&mut attrs.props, Prop::Uniforms(uniforms));
        });
        self
    }

    /// Stops its clock (`nsh.time` keeps its value), or starts it again.
    pub fn paused(self, paused: impl IntoReactive<bool>) -> Self {
        self.bind_prop(paused, Prop::ShaderPaused)
    }
}

/// A web view loading `url` (a bound one loads again when it changes).
pub fn web_view(url: impl IntoReactive<String>) -> WebView {
    WebView(ElNode::new(Tag::WebView)).bind_prop(url, |url: String| {
        Prop::Native(NativeProp::Source(WebSource::Uri(url.into())))
    })
}

/// A web view showing the page `html`, its relative links resolved against
/// `base_url` (TS: `html` and `baseUrl`).
pub fn web_view_html(html: impl IntoReactive<String>, base_url: Option<&str>) -> WebView {
    WebView(ElNode::new(Tag::WebView)).html(html, base_url)
}

/// A video playing the file or stream at `url` (a bound one plays the new
/// one when it changes).
pub fn video(url: impl IntoReactive<String>) -> Video {
    Video(ElNode::new(Tag::Video)).bind_prop(url, |url: String| {
        Prop::Native(NativeProp::Source(WebSource::Uri(url.into())))
    })
}

/// The embedder's native component registered as `name`.
pub fn native(name: &str) -> NativeView {
    NativeView(ElNode::new(Tag::Native)).set(Prop::Component(name.into()))
}

impl Input {
    /// The text, when the component controls it (update it from
    /// [`Self::on_change`]).
    pub fn value(self, text: impl IntoReactive<String>) -> Self {
        self.bind_prop(text, |text: String| Prop::Value(text))
    }

    /// The first text, when the input keeps its own.
    pub fn default_value(self, text: impl IntoReactive<String>) -> Self {
        self.bind_prop(text, |text: String| Prop::DefaultValue(text))
    }

    /// Shown while it is empty.
    pub fn placeholder(self, text: impl IntoReactive<String>) -> Self {
        self.bind_prop(text, |text: String| Prop::Placeholder(text))
    }

    /// The placeholder's color (`cx.color(theme.muted_foreground)`).
    pub fn placeholder_color(self, color: impl IntoReactive<Hsla>) -> Self {
        self.bind_prop(color, |color: Hsla| {
            Prop::PlaceholderColor(Some(color.into()))
        })
    }

    /// The selection highlight's color (on iOS also the caret's, unless
    /// [`Self::caret_color`] is set: UIKit tints both with one).
    pub fn selection_color(self, color: impl IntoReactive<Hsla>) -> Self {
        self.bind_prop(color, |color: Hsla| {
            Prop::SelectionColor(Some(color.into()))
        })
    }

    /// The caret's color.
    pub fn caret_color(self, color: impl IntoReactive<Hsla>) -> Self {
        self.bind_prop(color, |color: Hsla| Prop::CaretColor(Some(color.into())))
    }

    /// Hides what is typed (passwords; TS: `masked`).
    pub fn masked(self, secure: impl IntoReactive<bool>) -> Self {
        self.bind_prop(secure, |secure: bool| Prop::Secure(secure))
    }

    /// The software keyboard's layout.
    pub fn keyboard_type(self, kind: impl IntoReactive<KeyboardType>) -> Self {
        self.bind_prop(kind, |kind: KeyboardType| Prop::KeyboardType(kind))
    }

    /// The software keyboard's light or dark look (iOS; TS:
    /// `ios={{ keyboardAppearance }}`).
    pub fn keyboard_appearance(self, appearance: impl IntoReactive<KeyboardAppearance>) -> Self {
        self.bind_prop(appearance, |appearance: KeyboardAppearance| {
            Prop::KeyboardAppearance(appearance)
        })
    }

    /// The return key's label.
    pub fn return_key_type(self, kind: impl IntoReactive<ReturnKeyType>) -> Self {
        self.bind_prop(kind, |kind: ReturnKeyType| Prop::ReturnKeyType(kind))
    }

    /// Automatic capitals.
    pub fn auto_capitalize(self, mode: impl IntoReactive<AutoCapitalize>) -> Self {
        self.bind_prop(mode, |mode: AutoCapitalize| Prop::AutoCapitalize(mode))
    }

    /// Spelling correction (default on).
    pub fn auto_correct(self, on: impl IntoReactive<bool>) -> Self {
        self.bind_prop(on, |on: bool| Prop::AutoCorrect(on))
    }

    /// What it holds, for autofill and suggestions.
    pub fn auto_fill(self, kind: impl IntoReactive<AutoFill>) -> Self {
        self.bind_prop(kind, |kind: AutoFill| Prop::AutoFill(kind))
    }

    /// Several lines, growing with the text (return adds a line).
    pub fn multiline(self, multiline: impl IntoReactive<bool>) -> Self {
        self.bind_prop(multiline, |multiline: bool| Prop::Multiline(multiline))
    }

    /// Styles and atomically edits token captures in the native text input.
    pub fn tokens(
        self,
        tokens: impl IntoReactive<Vec<crate::input_tokens::InputTokenRule>>,
    ) -> Self {
        self.bind_prop(tokens, Prop::InputTokens)
    }

    /// At most `length` characters.
    pub fn max_length(self, length: impl IntoReactive<u32>) -> Self {
        self.bind_prop(length, |length: u32| Prop::MaxLength(Some(length)))
    }

    /// The text can be selected and copied but not changed.
    pub fn readonly(self, readonly: impl IntoReactive<bool>) -> Self {
        self.bind_prop(readonly, |readonly: bool| Prop::Readonly(readonly))
    }

    /// What return does (`submitBehavior`; default: submit and unfocus for
    /// one line, a line break for several).
    pub fn submit_behavior(self, behavior: impl IntoReactive<SubmitBehavior>) -> Self {
        self.bind_prop(behavior, |behavior: SubmitBehavior| {
            Prop::SubmitBehavior(Some(behavior))
        })
    }

    /// What a paste does (`pasteBehavior`; default: insert its text).
    /// [`Self::on_paste`] hears what was pasted either way.
    pub fn paste_behavior(self, behavior: impl IntoReactive<PasteBehavior>) -> Self {
        self.bind_prop(behavior, Prop::PasteBehavior)
    }

    /// The user pasted: the text, the files with their bytes (a
    /// screenshot) and local files' URLs, before the text it inserts is
    /// reported.
    pub fn on_paste<M>(self, listener: impl IntoListener<PasteEvent, M>) -> Self {
        self.listen(EventKind::Paste, listener.into_listener(), events::paste)
    }

    /// Focused when it appears.
    pub fn auto_focus(self, focus: impl IntoReactive<bool>) -> Self {
        self.bind_prop(focus, |focus: bool| Prop::AutoFocus(focus))
    }

    /// The caret is drawn (default yes; TS: `caret`).
    pub fn caret(self, caret: impl IntoReactive<bool>) -> Self {
        self.bind_prop(caret, |caret: bool| Prop::Caret(caret))
    }

    /// Shows the input accessory with this `nativeID` over the keyboard
    /// ([`input_accessory_view`]; iOS).
    pub fn input_accessory(self, native_id: impl IntoReactive<String>) -> Self {
        self.bind_prop(native_id, |id: String| {
            Prop::InputAccessoryViewId(Some(id.into()))
        })
    }

    /// Selects `(start, end)` (UTF-16 units; a caret when equal) when the
    /// input is made and whenever the value changes (TS: the controlled
    /// `selectedRange`); the user moves it on from there
    /// ([`Self::on_selection_change`]).
    pub fn selected_range(self, range: impl IntoReactive<(u32, u32)>) -> Self {
        self.bind_prop(range, |(start, end): (u32, u32)| {
            Prop::Selection(start, end)
        })
    }

    /// The text changed (the new text).
    pub fn on_change<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.listen(
            EventKind::ChangeText,
            listener.into_listener(),
            events::text,
        )
    }

    /// The return (enter) key was pressed (the text).
    pub fn on_submit<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.listen(
            EventKind::SubmitEditing,
            listener.into_listener(),
            events::text,
        )
    }

    /// The selection or caret moved.
    pub fn on_selection_change<M>(self, listener: impl IntoListener<Selection, M>) -> Self {
        self.listen(
            EventKind::SelectionChange,
            listener.into_listener(),
            events::selection,
        )
    }

    /// The caret moved: with the selection, or as the text scrolled or
    /// wrapped again ([`CaretEvent`]: where it is, in the input and in the
    /// root view).
    pub fn on_caret_move<M>(self, listener: impl IntoListener<CaretEvent, M>) -> Self {
        self.listen(
            EventKind::CaretMove,
            listener.into_listener(),
            events::caret,
        )
    }

    /// A key was pressed: the character, `Backspace` or `Enter`.
    pub fn on_key_press<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.listen(EventKind::KeyPress, listener.into_listener(), events::key)
    }

    /// An input method's composition started, changed or ended (the text
    /// being composed, empty once it ends): the text is the input's only
    /// once committed, reported by [`Self::on_change`] first.
    pub fn on_composition_change<M>(self, listener: impl IntoListener<Composition, M>) -> Self {
        self.listen(
            EventKind::CompositionChange,
            listener.into_listener(),
            events::composition,
        )
    }

    /// The text's size changed (multiline inputs growing).
    pub fn on_content_size_change<M>(self, listener: impl IntoListener<Size<Points>, M>) -> Self {
        self.listen(
            EventKind::ContentSizeChange,
            listener.into_listener(),
            events::size,
        )
    }
}

impl Scroll {
    /// Scrolls horizontally.
    pub fn horizontal(self) -> Self {
        self.set(Prop::Horizontal(true))
    }

    /// Whether the scroll indicator shows (default yes).
    pub fn scrollbar(self, shows: impl IntoReactive<bool>) -> Self {
        self.bind_prop(shows, |shows: bool| Prop::Scrollbar(shows))
    }

    /// Pinch zoom between `min` and `max`.
    pub fn zoom_range(self, min: f32, max: f32) -> Self {
        self.set(Prop::Scroll(ScrollProp::MinZoom(min)))
            .set(Prop::Scroll(ScrollProp::MaxZoom(max)))
    }

    /// The zoom.
    pub fn zoom(self, scale: impl IntoReactive<f32>) -> Self {
        self.bind_prop(scale, |scale: f32| Prop::Scroll(ScrollProp::Zoom(scale)))
    }

    /// Pinches may go past the zoom limits and spring back (default yes;
    /// TS: `bouncesZoom`).
    pub fn bounces_zoom(self, bounces: impl IntoReactive<bool>) -> Self {
        self.bind_prop(bounces, |bounces: bool| {
            Prop::Scroll(ScrollProp::BouncesZoom(bounces))
        })
    }

    /// The user can pinch to zoom (default yes; TS: `zoomable`).
    pub fn zoomable(self, enabled: impl IntoReactive<bool>) -> Self {
        self.bind_prop(enabled, |enabled: bool| {
            Prop::Scroll(ScrollProp::Pinch(enabled))
        })
    }

    /// Content smaller than the view sits in its center (zoomed images).
    pub fn center_content(self, center: impl IntoReactive<bool>) -> Self {
        self.bind_prop(center, |center: bool| {
            Prop::Scroll(ScrollProp::CenterContent(center))
        })
    }
}

impl super::Scrollable for Scroll {}

impl Screen {
    fn header_item(mut self, slot: HeaderSlot, key: &'static str, item: impl IntoElement) -> Self {
        let mut node = ElNode::new(Tag::HeaderItem);
        node.key = Some(key.into());
        set(&mut node, Prop::HeaderSlot(slot));
        node.children.push(item.into_element().0);
        self.0.children.push(node);
        self
    }

    /// The header's title.
    pub fn title(self, title: impl IntoReactive<super::SharedString>) -> Self {
        self.bind_prop(title, |t| {
            Prop::Screen(ScreenProp::Title(Some(Arc::from(t.as_str()))))
        })
    }

    /// Whether the header shows (default true).
    pub fn header_visible(self, shown: impl IntoReactive<bool>) -> Self {
        self.bind_prop(shown, |v| Prop::Screen(ScreenProp::HeaderVisible(v)))
    }

    /// A large title (iOS); the content scrolls under the header.
    pub fn header_large_title(self, large: impl IntoReactive<bool>) -> Self {
        self.bind_prop(large, |v| Prop::Screen(ScreenProp::HeaderLargeTitle(v)))
    }

    /// The content extends under the header.
    pub fn header_transparent(self, transparent: impl IntoReactive<bool>) -> Self {
        self.bind_prop(transparent, |v| {
            Prop::Screen(ScreenProp::HeaderTransparent(v))
        })
    }

    /// The header's colors: `backgroundColor`, `color` (the title's) and
    /// `tintColor` (the buttons'), as [`super::Style::from_decls`] makes
    /// them (TS: `headerStyle`); a style of typed styles applies as
    /// [`Self::header_style_with`]'s do.
    pub fn header_style(mut self, style: impl IntoReactive<super::Style>) -> Self {
        let style = match style.into_reactive() {
            // Its bound parts are read in the binding, which follows them.
            super::Reactive::Static(s) if s.1.is_bound() => {
                super::Reactive::Bound(std::rc::Rc::new(move || s.clone()))
            }
            style => style,
        };
        self.0.bind_attr(style, |a, s: super::Style| {
            set_in(&mut a.props, Prop::HeaderStyle(s.0));
            if !s.1.is_empty() {
                let typed = s.1.resolved();
                let list = (!typed.is_empty()).then(|| std::rc::Rc::new(typed.lower()));
                set_in(&mut a.props, Prop::HeaderClassList(list));
            }
        });
        self
    }

    /// The header's colors as typed styles: the background
    /// ([`super::Styled::bg`]), the title's color
    /// ([`super::Styled::text_color`]) and the buttons'
    /// ([`super::Styled::tint_color`]), theme colors following the
    /// appearance natively (TS: `headerClass`). `f` runs again when what it
    /// reads changes. [`Self::header_style`] wins over it, key by key.
    pub fn header_style_with(
        self,
        f: impl Fn(super::StyleRefinement) -> super::StyleRefinement + 'static,
    ) -> Self {
        let list = move || {
            let style = f(super::StyleRefinement::default()).resolved();
            (!style.is_empty()).then(|| std::rc::Rc::new(style.lower()))
        };
        self.bind_prop(super::Reactive::Bound(std::rc::Rc::new(list)), |list| {
            Prop::HeaderClassList(list)
        })
    }

    /// The label of the back button leading back to this screen (iOS).
    pub fn header_back_title(self, title: impl IntoReactive<super::SharedString>) -> Self {
        self.bind_prop(title, |t| {
            Prop::Screen(ScreenProp::HeaderBackTitle(Some(Arc::from(t.as_str()))))
        })
    }

    /// The trailing header button is UIKit's own, drawn instead of the
    /// `header_right` view (iOS; a press on it presses that view's first
    /// pressable view).
    pub fn header_right_system_item(
        self,
        item: impl IntoReactive<crate::HeaderSystemItem>,
    ) -> Self {
        self.bind_prop(item, |item| {
            Prop::Screen(ScreenProp::HeaderRightSystemItem(Some(item)))
        })
    }

    /// Whether the back button shows (default true).
    pub fn header_back_visible(self, visible: impl IntoReactive<bool>) -> Self {
        self.bind_prop(visible, |v| Prop::Screen(ScreenProp::HeaderBackVisible(v)))
    }

    /// The interactive back gesture pops (iOS swipe back, Android
    /// predictive back); the back buttons pop either way (default true).
    pub fn pop_on_swipe(self, enabled: impl IntoReactive<bool>) -> Self {
        self.bind_prop(enabled, |v| Prop::Screen(ScreenProp::PopOnSwipe(v)))
    }

    /// The back buttons and the swipe back pop the screen (default true);
    /// false keeps it, reporting [`Self::on_back_press`] instead. Decided
    /// natively when the system asks, so set it before the user acts.
    pub fn pop_on_back(self, pop: impl IntoReactive<bool>) -> Self {
        self.bind_prop(pop, |v| Prop::Screen(ScreenProp::PopOnBack(v)))
    }

    /// How the screen enters and leaves.
    pub fn animation(self, animation: impl IntoReactive<ScreenAnimation>) -> Self {
        self.bind_prop(animation, |a| Prop::Screen(ScreenProp::Animation(a)))
    }

    /// What the status bar shows while the screen is up (iOS and Android;
    /// TS: `statusBar`): over the screens below it and the app's default,
    /// field by field, as a view controller's `preferredStatusBarStyle`.
    pub fn status_bar(self, setting: impl IntoReactive<StatusBarSetting>) -> Self {
        self.bind_prop(setting, |s| Prop::Screen(ScreenProp::StatusBar(Some(s))))
    }

    /// An element at the header's start (instead of the back button).
    pub fn header_left(self, item: impl IntoElement) -> Self {
        self.header_item(HeaderSlot::Left, "header-left", item)
    }

    /// An element at the header's end.
    pub fn header_right(self, item: impl IntoElement) -> Self {
        self.header_item(HeaderSlot::Right, "header-right", item)
    }

    /// An element replacing the title.
    pub fn header_title(self, item: impl IntoElement) -> Self {
        self.header_item(HeaderSlot::Title, "header-title", item)
    }

    /// The app's header on platforms without a system header (desktops,
    /// the web): placed at the top of the screen, as wide as it and as tall
    /// as it lays out, with the content below it (TS: `header`).
    pub fn header(self, item: impl IntoElement) -> Self {
        self.header_item(HeaderSlot::Header, "header", item)
    }

    /// The user popped the screen natively (back button, swipe): leave it
    /// out of the view (its region).
    pub fn on_dismiss<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::Dismiss, listener.into_listener(), events::unit)
    }

    /// The user pressed back on the screen (every back press, whether or
    /// not [`Self::pop_on_back`] let it pop).
    pub fn on_back_press<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(
            EventKind::BackRequest,
            listener.into_listener(),
            events::unit,
        )
    }
}

impl Overlay {
    /// Places it against a reactive anchor: a node, its content bounds, a
    /// root-view point, or no anchor. The core follows and places it.
    pub fn anchor_target(self, anchor: impl IntoReactive<OverlayAnchor>) -> Self {
        self.bind_prop(anchor, |a| Prop::Overlay(OverlayProp::Anchor(a)))
    }

    /// Places it against the element carrying `anchor` (rendered before
    /// it), following it as it moves: on the [`Self::placement`] side, on
    /// the other when only that one has room, kept inside the safe area.
    pub fn anchor(self, anchor: &super::ElementRef) -> Self {
        let anchor = *anchor;
        self.bind_prop(
            move || match anchor.node() {
                Some(id) => OverlayAnchor::Node(id),
                None => OverlayAnchor::None,
            },
            |a| Prop::Overlay(OverlayProp::Anchor(a)),
        )
    }

    /// Places it against what the element carrying `anchor` draws: the box
    /// around its children, so a trigger in a wrapper its parent stretches
    /// is placed against what shows ([`OverlayAnchor::Content`]).
    pub fn anchor_content(self, anchor: &super::ElementRef) -> Self {
        let anchor = *anchor;
        self.bind_prop(
            move || match anchor.node() {
                Some(id) => OverlayAnchor::Content(id),
                None => OverlayAnchor::None,
            },
            |a| Prop::Overlay(OverlayProp::Anchor(a)),
        )
    }

    /// Places it against a point of the root view (a touch's `page`: a
    /// menu where the pointer is).
    pub fn anchor_point(self, point: impl IntoReactive<Point<Points>>) -> Self {
        self.bind_prop(point, |p| {
            Prop::Overlay(OverlayProp::Anchor(OverlayAnchor::Point(p)))
        })
    }

    /// Places it against a box of the root view: an input's caret
    /// ([`CaretEvent::page_bounds`]), where suggestions for what is being
    /// typed open.
    pub fn anchor_bounds(self, bounds: impl IntoReactive<Bounds<Points>>) -> Self {
        self.bind_prop(bounds, |b| {
            Prop::Overlay(OverlayProp::Anchor(OverlayAnchor::Bounds(b)))
        })
    }

    /// The side of the anchor it goes on (default below).
    pub fn placement(self, placement: impl IntoReactive<Placement>) -> Self {
        self.bind_prop(placement, |p| Prop::Overlay(OverlayProp::Placement(p)))
    }

    /// How it lines up with the anchor along that side (default centered).
    pub fn align(self, align: impl IntoReactive<Align>) -> Self {
        self.bind_prop(align, |a| Prop::Overlay(OverlayProp::Align(a)))
    }

    /// The gap between the anchor and it.
    pub fn offset(self, offset: impl IntoReactive<Points>) -> Self {
        self.bind_prop(offset, |o| Prop::Overlay(OverlayProp::Offset(o)))
    }

    /// The distance it keeps from the edges of the safe area.
    pub fn margin(self, margin: impl IntoReactive<Points>) -> Self {
        self.bind_prop(margin, |m| Prop::Overlay(OverlayProp::Margin(m)))
    }

    /// Focuses this popup's controls while it is shown and returns focus to
    /// its still-valid opener on closing (terminal and GPUI). Background
    /// presses remain available; an outside press's new focus is preserved.
    pub fn focus_return(self, enabled: impl IntoReactive<bool>) -> Self {
        self.bind_prop(enabled, |v| Prop::Overlay(OverlayProp::FocusReturn(v)))
    }

    /// A press went down outside it, its anchor and the overlays inside it
    /// (where, in the root view). Closing is the listener's: leave it out
    /// of the view.
    pub fn on_press_outside<M>(self, listener: impl IntoListener<Point<Points>, M>) -> Self {
        self.listen(
            EventKind::PressOutside,
            listener.into_listener(),
            events::page_point,
        )
    }

    /// Escape or the Android back button, while it is the top overlay
    /// listening (it takes them from those below, the pages and
    /// [`super::on_back_press`]).
    pub fn on_cancel<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::Cancel, listener.into_listener(), events::unit)
    }

    /// Makes it a hint (a tooltip): shown once the pointer rested on its
    /// anchor (its parent without one) for `delay`, until the pointer
    /// leaves or presses the anchor, on the desktops only; it is placed
    /// against the anchor and should not take the pointer
    /// ([`Interactive::pointer_events`] none). [`Self::hint_open`] decides
    /// instead of the pointer.
    pub fn hint(self, delay: impl IntoReactive<std::time::Duration>) -> Self {
        self.bind_prop(delay, |d| Prop::Overlay(OverlayProp::Hint(Some(d))))
    }

    /// Also show a hint while its anchor has native keyboard focus.
    pub fn hint_on_focus(self, enabled: impl IntoReactive<bool>) -> Self {
        self.bind_prop(enabled, |enabled| {
            Prop::Overlay(OverlayProp::HintOnFocus(enabled))
        })
    }

    /// A hint shown (`Some(true)`) or hidden (`Some(false)`) whatever the
    /// pointer does: its owner follows [`Self::on_hint_show`] /
    /// [`Self::on_hint_hide`] (a `Tooltip` controlled by the app). `None`:
    /// the pointer decides.
    pub fn hint_open(self, open: impl IntoReactive<Option<bool>>) -> Self {
        self.bind_prop(open, |o| Prop::Overlay(OverlayProp::Open(o)))
    }

    /// The pointer rested on a hint's anchor for its delay: it asks to
    /// show (and shows, unless [`Self::hint_open`] decides).
    pub fn on_hint_show<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::Show, listener.into_listener(), events::unit)
    }

    /// The pointer left or pressed a hint's anchor, or the hint left the
    /// view, after it asked to show: it asks to hide.
    pub fn on_hint_hide<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::Dismiss, listener.into_listener(), events::unit)
    }

    /// The core placed it against its anchor: the side it went on, its
    /// frame and the room on that side.
    pub fn on_position<M>(self, listener: impl IntoListener<OverlayPosition, M>) -> Self {
        self.listen(
            EventKind::Position,
            listener.into_listener(),
            events::overlay_position,
        )
    }
}

impl Modal {
    /// How it comes in (default: slides up).
    pub fn animation(self, animation: impl IntoReactive<ModalAnimation>) -> Self {
        self.bind_prop(animation, |animation: ModalAnimation| {
            Prop::Modal(ModalProp::Animation(animation))
        })
    }

    /// Full screen, or a sheet (iOS).
    pub fn presentation(self, presentation: impl IntoReactive<ModalPresentation>) -> Self {
        self.bind_prop(presentation, |presentation: ModalPresentation| {
            Prop::Modal(ModalProp::Presentation(presentation))
        })
    }

    /// What the status bar shows while it is presented (iOS and Android;
    /// TS: `statusBar`): over what is below it, field by field.
    pub fn status_bar(self, setting: impl IntoReactive<StatusBarSetting>) -> Self {
        self.bind_prop(setting, |s| Prop::Screen(ScreenProp::StatusBar(Some(s))))
    }

    /// Under the status bar (Android).
    pub fn status_bar_translucent(self, translucent: impl IntoReactive<bool>) -> Self {
        self.bind_prop(translucent, |translucent: bool| {
            Prop::Modal(ModalProp::StatusBarTranslucent(translucent))
        })
    }

    /// The orientations it allows while it is presented (iOS; default:
    /// those of what presents it).
    pub fn supported_orientations(
        self,
        orientations: impl IntoIterator<Item = Orientation>,
    ) -> Self {
        let bits = orientations.into_iter().fold(0, |bits, o| bits | o.bits());
        self.set(Prop::Modal(ModalProp::Orientations(bits)))
    }

    /// Escape and the Android back button close it natively (default
    /// true); either way they report [`Self::on_cancel`].
    pub fn close_on_escape(self, close: impl IntoReactive<bool>) -> Self {
        self.bind_prop(close, |v: bool| Prop::Modal(ModalProp::CloseOnEscape(v)))
    }

    /// A press on a backdrop the platform presents itself (a native
    /// sheet's) closes it (default true); a backdrop the app renders is
    /// the app's to handle.
    pub fn close_on_backdrop_press(self, close: impl IntoReactive<bool>) -> Self {
        self.bind_prop(close, |v: bool| {
            Prop::Modal(ModalProp::CloseOnBackdropPress(v))
        })
    }

    /// Swiping a sheet down closes it natively (default true).
    pub fn close_on_swipe(self, close: impl IntoReactive<bool>) -> Self {
        self.bind_prop(close, |v: bool| Prop::Modal(ModalProp::CloseOnSwipe(v)))
    }

    /// The user tried to close it (Escape or back, a backdrop press, a
    /// swipe down), whether or not it closed: leave it out of the view
    /// (its region) to close it.
    pub fn on_cancel<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(
            EventKind::RequestClose,
            listener.into_listener(),
            events::unit,
        )
    }

    /// It finished appearing.
    pub fn on_open<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::Show, listener.into_listener(), events::unit)
    }

    /// The user or the system closed it.
    pub fn on_close<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::Dismiss, listener.into_listener(), events::unit)
    }
}

/// An orientation of the screen ([`Modal::supported_orientations`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    /// Upright.
    Portrait,
    /// Upside down.
    PortraitUpsideDown,
    /// Either landscape.
    Landscape,
    /// Landscape, the top on the left.
    LandscapeLeft,
    /// Landscape, the top on the right.
    LandscapeRight,
}

impl Orientation {
    fn bits(self) -> u8 {
        use crate::ModalConfig as M;
        match self {
            Orientation::Portrait => M::PORTRAIT,
            Orientation::PortraitUpsideDown => M::PORTRAIT_UPSIDE_DOWN,
            Orientation::Landscape => M::LANDSCAPE_LEFT | M::LANDSCAPE_RIGHT,
            Orientation::LandscapeLeft => M::LANDSCAPE_LEFT,
            Orientation::LandscapeRight => M::LANDSCAPE_RIGHT,
        }
    }
}

impl WebView {
    /// Loads `html` (relative links against `base_url`) instead of a URL;
    /// a bound page loads again when it changes.
    pub fn html(self, html: impl IntoReactive<String>, base_url: Option<&str>) -> Self {
        let base_url: Option<Arc<str>> = base_url.map(Into::into);
        self.bind_prop(html, move |html: String| {
            Prop::Native(NativeProp::Source(WebSource::Html {
                html: html.into(),
                base_url: base_url.clone(),
            }))
        })
    }

    /// Runs after each page loads.
    pub fn injected_java_script(self, script: impl IntoReactive<String>) -> Self {
        self.bind_prop(script, |script: String| {
            Prop::Native(NativeProp::InjectedJavaScript(Some(script.into())))
        })
    }

    /// Runs before each page's own scripts.
    pub fn injected_java_script_before_content(self, script: impl IntoReactive<String>) -> Self {
        self.bind_prop(script, |script: String| {
            Prop::Native(NativeProp::InjectedJavaScriptBefore(Some(script.into())))
        })
    }

    /// The user agent it sends.
    pub fn user_agent(self, agent: impl IntoReactive<String>) -> Self {
        self.bind_prop(agent, |agent: String| {
            Prop::Native(NativeProp::UserAgent(Some(agent.into())))
        })
    }

    /// Scrolls (default yes).
    pub fn scrollable(self, enabled: impl IntoReactive<bool>) -> Self {
        self.bind_prop(enabled, |enabled: bool| {
            Prop::Native(NativeProp::Scrollable(enabled))
        })
    }

    /// Runs the pages' JavaScript (default yes).
    pub fn java_script_enabled(self, enabled: impl IntoReactive<bool>) -> Self {
        self.bind_prop(enabled, |enabled: bool| {
            Prop::Native(NativeProp::JavaScriptEnabled(enabled))
        })
    }

    /// Swipes go back and forward (iOS).
    pub fn back_forward_gestures(self, enabled: impl IntoReactive<bool>) -> Self {
        self.bind_prop(enabled, |enabled: bool| {
            Prop::Native(NativeProp::BackForwardGestures(enabled))
        })
    }

    /// A page started loading.
    pub fn on_load_start<M>(self, listener: impl IntoListener<WebNavigation, M>) -> Self {
        self.listen(
            EventKind::LoadStart,
            listener.into_listener(),
            events::navigation,
        )
    }

    /// A page loaded.
    pub fn on_load<M>(self, listener: impl IntoListener<WebNavigation, M>) -> Self {
        self.listen(
            EventKind::Load,
            listener.into_listener(),
            events::navigation,
        )
    }

    /// A page failed to load (the message).
    pub fn on_error<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.listen(EventKind::Error, listener.into_listener(), events::message)
    }

    /// The page called `window.nsh.postMessage(data)`.
    pub fn on_message<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.listen(EventKind::Message, listener.into_listener(), events::data)
    }

    /// It navigated.
    pub fn on_navigation_state_change<M>(
        self,
        listener: impl IntoListener<WebNavigation, M>,
    ) -> Self {
        self.listen(
            EventKind::NavigationStateChange,
            listener.into_listener(),
            events::navigation,
        )
    }
}

impl Video {
    /// Paused.
    pub fn paused(self, paused: impl IntoReactive<bool>) -> Self {
        self.bind_prop(paused, |paused: bool| {
            Prop::Native(NativeProp::Paused(paused))
        })
    }

    /// Without sound.
    pub fn muted(self, muted: impl IntoReactive<bool>) -> Self {
        self.bind_prop(muted, |muted: bool| Prop::Native(NativeProp::Muted(muted)))
    }

    /// 0..1.
    pub fn volume(self, volume: impl IntoReactive<f32>) -> Self {
        self.bind_prop(volume, |volume: f32| {
            Prop::Native(NativeProp::Volume(volume))
        })
    }

    /// Playback speed.
    pub fn rate(self, rate: impl IntoReactive<f32>) -> Self {
        self.bind_prop(rate, |rate: f32| Prop::Native(NativeProp::Rate(rate)))
    }

    /// Starts over at the end.
    pub fn repeat(self, repeat: impl IntoReactive<bool>) -> Self {
        self.bind_prop(repeat, |repeat: bool| {
            Prop::Native(NativeProp::Repeat(repeat))
        })
    }

    /// The platform's playback controls.
    pub fn controls(self, controls: impl IntoReactive<bool>) -> Self {
        self.bind_prop(controls, |controls: bool| {
            Prop::Native(NativeProp::Controls(controls))
        })
    }

    /// Milliseconds between [`Self::on_progress`] events (default 250).
    pub fn progress_interval(self, ms: impl IntoReactive<f32>) -> Self {
        self.bind_prop(ms, |ms: f32| Prop::Native(NativeProp::ProgressInterval(ms)))
    }

    /// What its sound does to the rest of the device's audio while it
    /// plays (default: the app's audio settings).
    pub fn audio_session(self, session: impl IntoReactive<AudioSession>) -> Self {
        self.bind_prop(session, |session: AudioSession| {
            Prop::Native(NativeProp::AudioSession(session))
        })
    }

    /// It started loading.
    pub fn on_load_start<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::LoadStart, listener.into_listener(), events::unit)
    }

    /// It loaded: length and size.
    pub fn on_load<M>(self, listener: impl IntoListener<VideoInfo, M>) -> Self {
        self.listen(EventKind::Load, listener.into_listener(), events::video)
    }

    /// It played on.
    pub fn on_progress<M>(self, listener: impl IntoListener<VideoProgress, M>) -> Self {
        self.listen(
            EventKind::Progress,
            listener.into_listener(),
            events::progress,
        )
    }

    /// It played to its end.
    pub fn on_end<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen(EventKind::End, listener.into_listener(), events::unit)
    }

    /// It started (`true`) or stopped buffering.
    pub fn on_buffer<M>(self, listener: impl IntoListener<bool, M>) -> Self {
        self.listen(
            EventKind::Buffer,
            listener.into_listener(),
            events::buffering,
        )
    }

    /// It failed (the message).
    pub fn on_error<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.listen(EventKind::Error, listener.into_listener(), events::message)
    }
}

impl NativeView {
    /// Its prop `name` (any JSON value), as JS's `nativeComponent` passes it;
    /// a bound one is passed again when it changes.
    pub fn prop(self, name: &str, value: impl IntoReactive<JsonValue>) -> Self {
        let name: Arc<str> = name.into();
        self.bind_prop(value, move |value| {
            Prop::ComponentProp(name.clone(), Some(value))
        })
    }

    /// Binds its prop `name` to an animated value: the platform hands the
    /// value (a number or a color) to the component on every frame it
    /// changes, with no engine work per frame (JS: an animated value given
    /// to a `nativeComponent` prop). A value set with [`Self::prop`] under
    /// that name waits until the binding goes.
    pub fn bind_animated_prop(mut self, name: &str, value: &impl super::Animated) -> Self {
        if let Some(node) = value.animated_node().live() {
            set(
                &mut self.0,
                Prop::ComponentPropBinding(name.into(), Some(node.id())),
            );
            self.0.attrs.bound.push(node);
        }
        self
    }

    /// It emitted an event.
    pub fn on_native_event<M>(self, listener: impl IntoListener<NativeEvent, M>) -> Self {
        self.listen(
            EventKind::NativeEvent,
            listener.into_listener(),
            events::native,
        )
    }
}

/// A number in a drawing: a constant, or an animated value the canvas reads
/// while it draws (it draws again natively as the value moves).
#[derive(Debug, Clone, PartialEq)]
pub struct CanvasArg(pub(crate) CanvasArgKind);

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CanvasArgKind {
    Const(f32),
    Node(super::LiveNode),
}

impl From<f32> for CanvasArg {
    fn from(n: f32) -> Self {
        Self(CanvasArgKind::Const(n))
    }
}

/// A length (coordinates, sizes, line widths, radii).
impl From<Points> for CanvasArg {
    fn from(n: Points) -> Self {
        Self(CanvasArgKind::Const(n.0))
    }
}

/// An angle (arcs, rotations).
impl From<Radians> for CanvasArg {
    fn from(n: Radians) -> Self {
        Self(CanvasArgKind::Const(n.0))
    }
}

/// An animated value whose owner is gone counts as 0.
impl<A: super::Animated> From<&A> for CanvasArg {
    fn from(a: &A) -> Self {
        Self(match a.animated_node().live() {
            Some(node) => CanvasArgKind::Node(node),
            None => CanvasArgKind::Const(0.0),
        })
    }
}

/// What a drawing fills or strokes with (`fillStyle` / `strokeStyle`): a
/// color, a gradient ([`CanvasGradient::linear`], `radial`, `conic`), or a
/// animated value interpolating colors
/// ([`super::AnimatedNode::interpolate_colors`]), read as it moves.
#[derive(Debug, Clone, PartialEq)]
pub struct CanvasPaint(CanvasPaintKind);

#[derive(Debug, Clone, PartialEq)]
enum CanvasPaintKind {
    Color(Color),
    Gradient(Arc<CanvasGradient>),
    Node(super::LiveNode),
}

impl From<Color> for CanvasPaint {
    fn from(color: Color) -> Self {
        Self(CanvasPaintKind::Color(color))
    }
}

impl From<Hsla> for CanvasPaint {
    fn from(color: Hsla) -> Self {
        Color::from(color).into()
    }
}

impl From<Rgba> for CanvasPaint {
    fn from(color: Rgba) -> Self {
        Color::from(color).into()
    }
}

impl From<CanvasGradient> for CanvasPaint {
    fn from(gradient: CanvasGradient) -> Self {
        Self(CanvasPaintKind::Gradient(Arc::new(gradient)))
    }
}

impl From<Arc<CanvasGradient>> for CanvasPaint {
    fn from(gradient: Arc<CanvasGradient>) -> Self {
        Self(CanvasPaintKind::Gradient(gradient))
    }
}

/// An animated value whose owner is gone paints nothing (transparent).
impl<A: super::Animated> From<&A> for CanvasPaint {
    fn from(a: &A) -> Self {
        Self(match a.animated_node().live() {
            Some(node) => CanvasPaintKind::Node(node),
            None => CanvasPaintKind::Color(Color::TRANSPARENT),
        })
    }
}

/// Records a [`Drawing`] with the HTML Canvas 2D operations (Rust names):
/// `Painter::new().fill_color(red).fill_rect(px(0.0), px(0.0), w, h).finish()`.
/// Coordinates are points from the canvas's top left. Numbers and paints
/// may be animated values (the canvas draws again natively as they move);
/// operations without a method here are built by hand with
/// [`Painter::num`], [`Painter::paint`] and [`Painter::op`]. Text is
/// measured with [`super::ambient::measure_text`].
#[derive(Debug, Clone, Default)]
pub struct Painter {
    drawing: Drawing,
    /// The nodes of the animated values the drawing reads, held with it.
    nodes: Vec<super::LiveNode>,
}

impl Painter {
    /// An empty drawing.
    pub fn new() -> Self {
        Self::default()
    }

    /// The drawing.
    pub fn finish(self) -> Drawing {
        self.drawing
    }

    /// `value` as a number of this drawing, for an operation built by hand
    /// ([`Self::op`]): an animated value becomes a slot the canvas reads while
    /// it draws, kept alive with the drawing.
    pub fn num(&mut self, value: impl Into<CanvasArg>) -> Num {
        match value.into().0 {
            CanvasArgKind::Const(n) => Num::Const(n),
            CanvasArgKind::Node(node) => Num::Slot(self.slot(node)),
        }
    }

    /// `paint` as a paint of this drawing, for an operation built by hand
    /// ([`Self::op`]).
    pub fn paint(&mut self, paint: impl Into<CanvasPaint>) -> Paint {
        match paint.into().0 {
            CanvasPaintKind::Color(color) => Paint::Color(color),
            CanvasPaintKind::Gradient(gradient) => Paint::Gradient(gradient),
            CanvasPaintKind::Node(node) => Paint::Slot(self.slot(node)),
        }
    }

    fn slot(&mut self, node: super::LiveNode) -> u16 {
        let slot = self.drawing.slot(node.id());
        self.nodes.push(node);
        slot
    }

    /// Adds `node`: a part of the drawing that assistive technologies and
    /// UI tests see as an element of its own ([`crate::canvas::CanvasNode`]).
    pub fn node(mut self, node: crate::canvas::CanvasNode) -> Self {
        self.drawing.nodes.push(node);
        self
    }

    /// Records `op` (one built by hand: its numbers and paints from
    /// [`Self::num`] and [`Self::paint`]).
    pub fn op(mut self, op: CanvasOp) -> Self {
        self.drawing.ops.push(op);
        self
    }

    fn path(self, op: PathOp) -> Self {
        self.op(CanvasOp::Path(op))
    }

    /// Whether `point` (in the canvas, as a touch's location) is inside the
    /// current path by `rule`, with the transform, as recorded so far (TS:
    /// `cx.isPointInPath(x, y, rule)`). Answered from the geometry here,
    /// with no platform round trip; a number given as an animated value
    /// counts as 0, as in TS. To find what is under a tap, build the
    /// canvas's painter in a function the press handler calls too.
    pub fn is_point_in_path(&self, point: Point<Points>, rule: FillRule) -> bool {
        crate::canvas::point_in_path(&self.drawing.ops, None, rule, point, |_| 0.0)
    }

    /// Whether `point` is on the stroke of the current path with the line
    /// width and cap recorded so far (TS: `cx.isPointInStroke(x, y)`;
    /// round joins, no dashes). See [`Self::is_point_in_path`].
    pub fn is_point_in_stroke(&self, point: Point<Points>) -> bool {
        crate::canvas::point_in_stroke(&self.drawing.ops, None, point, |_| 0.0)
    }

    /// Whether `point` is inside `path` by `rule`, with the transform
    /// recorded so far (TS: `cx.isPointInPath(path2d, x, y, rule)`): the
    /// shape [`Self::fill_path`] drew under a tap. See
    /// [`Self::is_point_in_path`].
    pub fn path_contains(&self, path: &Path, point: Point<Points>, rule: FillRule) -> bool {
        crate::canvas::point_in_path(&self.drawing.ops, Some(path), rule, point, |_| 0.0)
    }

    /// Whether `point` is on the stroke of `path` with the transform, line
    /// width and cap recorded so far (TS: `cx.isPointInStroke(path2d, x,
    /// y)`). See [`Self::is_point_in_path`].
    pub fn stroke_contains(&self, path: &Path, point: Point<Points>) -> bool {
        crate::canvas::point_in_stroke(&self.drawing.ops, Some(path), point, |_| 0.0)
    }

    /// Saves the state (styles, transform, clip).
    pub fn save(self) -> Self {
        self.op(CanvasOp::Save)
    }

    /// Restores the state saved last.
    pub fn restore(self) -> Self {
        self.op(CanvasOp::Restore)
    }

    /// Moves the origin.
    pub fn translate(mut self, x: impl Into<CanvasArg>, y: impl Into<CanvasArg>) -> Self {
        let (x, y) = (self.num(x), self.num(y));
        self.op(CanvasOp::Translate(x, y))
    }

    /// Scales the axes.
    pub fn scale(mut self, x: impl Into<CanvasArg>, y: impl Into<CanvasArg>) -> Self {
        let (x, y) = (self.num(x), self.num(y));
        self.op(CanvasOp::Scale(x, y))
    }

    /// Rotates the axes, clockwise (a [`Radians`], or an animated value of
    /// radians).
    pub fn rotate(mut self, angle: impl Into<CanvasArg>) -> Self {
        let a = self.num(angle);
        self.op(CanvasOp::Rotate(a))
    }

    /// Multiplies the transform by the matrix `[a c e; b d f]`
    /// (`transform`).
    pub fn transform(mut self, m: [impl Into<CanvasArg>; 6]) -> Self {
        let m = m.map(|n| self.num(n));
        self.op(CanvasOp::Transform(m))
    }

    /// Replaces the transform with the matrix `[a c e; b d f]`
    /// (`setTransform`).
    pub fn set_transform(mut self, m: [impl Into<CanvasArg>; 6]) -> Self {
        let m = m.map(|n| self.num(n));
        self.op(CanvasOp::SetTransform(m))
    }

    /// Back to no transform (`resetTransform`).
    pub fn reset_transform(self) -> Self {
        self.set_transform([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    }

    /// Starts a new path.
    pub fn begin_path(self) -> Self {
        self.op(CanvasOp::BeginPath)
    }

    /// Starts a subpath at (`x`, `y`).
    pub fn move_to(mut self, x: impl Into<CanvasArg>, y: impl Into<CanvasArg>) -> Self {
        let (x, y) = (self.num(x), self.num(y));
        self.path(PathOp::MoveTo(x, y))
    }

    /// A straight line to (`x`, `y`).
    pub fn line_to(mut self, x: impl Into<CanvasArg>, y: impl Into<CanvasArg>) -> Self {
        let (x, y) = (self.num(x), self.num(y));
        self.path(PathOp::LineTo(x, y))
    }

    /// A quadratic Bézier curve to `to` (`quadraticCurveTo`).
    pub fn quadratic_curve_to(self, control: Point<Points>, to: Point<Points>) -> Self {
        let c = |v: Points| Num::Const(v.0);
        self.path(PathOp::QuadTo([
            c(control.x),
            c(control.y),
            c(to.x),
            c(to.y),
        ]))
    }

    /// A cubic Bézier curve to `to` (`bezierCurveTo`).
    pub fn bezier_curve_to(self, c1: Point<Points>, c2: Point<Points>, to: Point<Points>) -> Self {
        let c = |v: Points| Num::Const(v.0);
        self.path(PathOp::CubicTo([
            c(c1.x),
            c(c1.y),
            c(c2.x),
            c(c2.y),
            c(to.x),
            c(to.y),
        ]))
    }

    /// A circular arc around (`x`, `y`); angles clockwise from the x axis
    /// ([`Radians`], or animated values of radians).
    pub fn arc(
        self,
        x: impl Into<CanvasArg>,
        y: impl Into<CanvasArg>,
        radius: impl Into<CanvasArg>,
        start: impl Into<CanvasArg>,
        end: impl Into<CanvasArg>,
    ) -> Self {
        self.arc_in(x, y, radius, start, end, false)
    }

    /// [`Self::arc`] drawn counterclockwise.
    pub fn arc_counterclockwise(
        self,
        x: impl Into<CanvasArg>,
        y: impl Into<CanvasArg>,
        radius: impl Into<CanvasArg>,
        start: impl Into<CanvasArg>,
        end: impl Into<CanvasArg>,
    ) -> Self {
        self.arc_in(x, y, radius, start, end, true)
    }

    fn arc_in(
        mut self,
        x: impl Into<CanvasArg>,
        y: impl Into<CanvasArg>,
        radius: impl Into<CanvasArg>,
        start: impl Into<CanvasArg>,
        end: impl Into<CanvasArg>,
        ccw: bool,
    ) -> Self {
        let (x, y, radius, start, end) = (
            self.num(x),
            self.num(y),
            self.num(radius),
            self.num(start),
            self.num(end),
        );
        self.path(PathOp::Arc {
            x,
            y,
            radius,
            start,
            end,
            ccw,
        })
    }

    /// An arc of `radius` tangent to the lines to `p1` and on to `p2`
    /// (`arcTo`): a rounded corner.
    pub fn arc_to(self, p1: Point<Points>, p2: Point<Points>, radius: Points) -> Self {
        let c = |v: Points| Num::Const(v.0);
        self.path(PathOp::ArcTo([
            c(p1.x),
            c(p1.y),
            c(p2.x),
            c(p2.y),
            c(radius),
        ]))
    }

    /// An elliptical arc around `center` with radii `radii` turned by
    /// `rotation`; angles clockwise (`counterclockwise` draws the other
    /// way).
    pub fn ellipse(
        self,
        center: Point<Points>,
        radii: Size<Points>,
        rotation: Radians,
        start: Radians,
        end: Radians,
        counterclockwise: bool,
    ) -> Self {
        let c = Num::Const;
        self.path(PathOp::Ellipse {
            geometry: [
                c(center.x.0),
                c(center.y.0),
                c(radii.width.0),
                c(radii.height.0),
                c(rotation.0),
            ],
            start: c(start.0),
            end: c(end.0),
            ccw: counterclockwise,
        })
    }

    /// A rectangle subpath.
    pub fn rect(self, rect: Bounds<Points>) -> Self {
        self.path(PathOp::Rect(nums(rect)))
    }

    /// A rectangle subpath with round corners (one radius for all).
    pub fn round_rect(self, rect: Bounds<Points>, radius: Points) -> Self {
        self.round_rect_corners(rect, Corners::all(radius))
    }

    /// A rectangle subpath with round corners.
    pub fn round_rect_corners(self, rect: Bounds<Points>, radii: Corners<Points>) -> Self {
        let c = |v: Points| Num::Const(v.0);
        self.path(PathOp::RoundRect(
            nums(rect),
            [
                c(radii.top_left),
                c(radii.top_right),
                c(radii.bottom_right),
                c(radii.bottom_left),
            ],
        ))
    }

    /// A straight line back to the subpath's start.
    pub fn close_path(self) -> Self {
        self.path(PathOp::Close)
    }

    /// Fills the current path.
    pub fn fill(self) -> Self {
        self.fill_with(FillRule::NonZero)
    }

    /// Fills the current path by `rule`.
    pub fn fill_with(self, rule: FillRule) -> Self {
        self.op(CanvasOp::Fill(None, rule))
    }

    /// Fills `path` (TS: `fill(path2d)`; parse SVG data once with
    /// [`crate::canvas::svg_path`]).
    pub fn fill_path(self, path: &Path, rule: FillRule) -> Self {
        self.op(CanvasOp::Fill(Some(path.clone()), rule))
    }

    /// Fills SVG path data (parsed now: [`Self::fill_path`] reuses a
    /// parsed path).
    pub fn fill_svg(self, data: &str) -> Self {
        self.fill_path(&crate::canvas::svg_path(data), FillRule::NonZero)
    }

    /// Strokes the current path.
    pub fn stroke(self) -> Self {
        self.op(CanvasOp::Stroke(None))
    }

    /// Strokes `path` (TS: `stroke(path2d)`).
    pub fn stroke_path(self, path: &Path) -> Self {
        self.op(CanvasOp::Stroke(Some(path.clone())))
    }

    /// Strokes SVG path data (parsed now).
    pub fn stroke_svg(self, data: &str) -> Self {
        self.stroke_path(&crate::canvas::svg_path(data))
    }

    /// Clips to the current path.
    pub fn clip(self) -> Self {
        self.clip_with(FillRule::NonZero)
    }

    /// Clips to the current path by `rule`.
    pub fn clip_with(self, rule: FillRule) -> Self {
        self.op(CanvasOp::Clip(None, rule))
    }

    /// Clips to `path` (TS: `clip(path2d)`).
    pub fn clip_path(self, path: &Path, rule: FillRule) -> Self {
        self.op(CanvasOp::Clip(Some(path.clone()), rule))
    }

    /// Fills a rectangle (its numbers [`Points`], or animated values).
    pub fn fill_rect(
        mut self,
        x: impl Into<CanvasArg>,
        y: impl Into<CanvasArg>,
        w: impl Into<CanvasArg>,
        h: impl Into<CanvasArg>,
    ) -> Self {
        let (x, y, w, h) = (self.num(x), self.num(y), self.num(w), self.num(h));
        self.op(CanvasOp::FillRect([x, y, w, h]))
    }

    /// Strokes a rectangle.
    pub fn stroke_rect(self, rect: Bounds<Points>) -> Self {
        self.op(CanvasOp::StrokeRect(nums(rect)))
    }

    /// Makes a rectangle transparent.
    pub fn clear_rect(self, rect: Bounds<Points>) -> Self {
        self.op(CanvasOp::ClearRect(nums(rect)))
    }

    /// Fills with `color`.
    pub fn fill_color(self, color: impl Into<Hsla>) -> Self {
        self.fill_style(color.into())
    }

    /// Strokes with `color`.
    pub fn stroke_color(self, color: impl Into<Hsla>) -> Self {
        self.stroke_style(color.into())
    }

    /// Fills with `paint`: a color, a gradient or an animated value of colors
    /// (`fillStyle`).
    pub fn fill_style(mut self, paint: impl Into<CanvasPaint>) -> Self {
        let paint = self.paint(paint);
        self.op(CanvasOp::FillStyle(paint))
    }

    /// Fills with the canvas view's `fill` style (CSS's, inherited from the
    /// views around it; `currentColor` is its text color), or `initial`
    /// where nothing sets one: shapes a component draws take the app's
    /// `fill-*` classes, and follow them and the appearance without being
    /// drawn again ([`Drawing::view_paints`]).
    pub fn fill_style_from_view(self, initial: SvgPaint) -> Self {
        self.view_paint(
            ViewPaint::Fill(initial),
            CanvasOp::FillStyle(Paint::Color(Color::TRANSPARENT)),
        )
    }

    /// Strokes with the canvas view's `stroke` style, or `initial` where
    /// nothing sets one ([`Self::fill_style_from_view`]).
    pub fn stroke_style_from_view(self, initial: SvgPaint) -> Self {
        self.view_paint(
            ViewPaint::Stroke(initial),
            CanvasOp::StrokeStyle(Paint::Color(Color::TRANSPARENT)),
        )
    }

    /// Strokes as wide as the canvas view's `strokeWidth` style (1 where
    /// nothing sets one, CSS's initial value).
    pub fn line_width_from_view(self) -> Self {
        self.view_paint(ViewPaint::StrokeWidth, CanvasOp::LineWidth(Num::Const(1.0)))
    }

    /// Dashes strokes as the canvas view's `strokeDasharray` style does
    /// (solid where nothing sets one).
    pub fn line_dash_from_view(self) -> Self {
        self.view_paint(
            ViewPaint::StrokeDasharray,
            CanvasOp::LineDash(Arc::from([])),
        )
    }

    /// Fills the current path with the canvas view's background: its
    /// `backgroundColor` and its `backgroundImage` gradients (`bg-*`,
    /// `bg-linear-*` classes, the appearance's colors), positioned over
    /// `area` (this drawing's coordinates) as over a box of that size. The
    /// view then draws no background of its own: the background shows only
    /// where the path fills, as CSS's `clip-path` shows a box's
    /// ([`ViewPaint::Background`]). The canvas's state is kept around the
    /// fill.
    pub fn fill_background_from_view(self, area: Bounds<Points>) -> Self {
        self.view_paint(
            ViewPaint::Background {
                area,
                rule: FillRule::NonZero,
            },
            CanvasOp::Fill(None, FillRule::NonZero),
        )
    }

    fn view_paint(mut self, view: ViewPaint, placeholder: CanvasOp) -> Self {
        let at = self.drawing.ops.len() as u32;
        self.drawing.view_paints.push((at, view));
        self.op(placeholder)
    }

    /// Strokes with `paint` (`strokeStyle`).
    pub fn stroke_style(mut self, paint: impl Into<CanvasPaint>) -> Self {
        let paint = self.paint(paint);
        self.op(CanvasOp::StrokeStyle(paint))
    }

    /// The stroke width.
    pub fn line_width(mut self, width: impl Into<CanvasArg>) -> Self {
        let w = self.num(width);
        self.op(CanvasOp::LineWidth(w))
    }

    /// How strokes end.
    pub fn line_cap(self, cap: LineCap) -> Self {
        self.op(CanvasOp::LineCap(cap))
    }

    /// How stroke segments join.
    pub fn line_join(self, join: LineJoin) -> Self {
        self.op(CanvasOp::LineJoin(join))
    }

    /// How far mitered joins reach, in line widths (`miterLimit`; at least
    /// 1).
    pub fn miter_limit(self, limit: f32) -> Self {
        self.op(CanvasOp::MiterLimit(limit.max(1.0)))
    }

    /// Dashes: lengths of dashes and gaps.
    pub fn line_dash(self, segments: &[Points]) -> Self {
        self.op(CanvasOp::LineDash(segments.into()))
    }

    /// Where the dashes start along the line (`lineDashOffset`; an animated
    /// value marches them).
    pub fn line_dash_offset(mut self, offset: impl Into<CanvasArg>) -> Self {
        let o = self.num(offset);
        self.op(CanvasOp::LineDashOffset(o))
    }

    /// The opacity of what is drawn next.
    pub fn global_alpha(mut self, alpha: impl Into<CanvasArg>) -> Self {
        let a = self.num(alpha);
        self.op(CanvasOp::GlobalAlpha(a))
    }

    /// How what is drawn next combines with the canvas.
    pub fn composite(self, composite: Composite) -> Self {
        self.op(CanvasOp::Composite(composite))
    }

    /// Shadows of what is drawn next.
    pub fn shadow(self, color: impl Into<Hsla>, blur: Points, offset: Point<Points>) -> Self {
        self.op(CanvasOp::ShadowColor(Color::from(color.into())))
            .op(CanvasOp::ShadowBlur(blur.max(Points::ZERO)))
            .op(CanvasOp::ShadowOffset(offset))
    }

    /// The font (CSS `font` shorthand: `"600 14px Inter"`); an invalid one
    /// keeps the previous font, as in HTML.
    pub fn font(self, font: &str) -> Self {
        match CanvasFont::parse(font) {
            Some(font) => self.op(CanvasOp::Font(font)),
            None => self,
        }
    }

    /// The number forms of text (TS: `fontVariantNumeric`): with
    /// [`crate::style::FontVariant::TABULAR_NUMS`] figures have equal widths, so changing
    /// values do not jitter; `FontVariant::default()` keeps the font's.
    pub fn font_variant_numeric(self, numeric: crate::style::FontVariant) -> Self {
        self.op(CanvasOp::FontVariantNumeric(crate::style::FontVariant(
            numeric.0 & !crate::style::FontVariant::SMALL_CAPS,
        )))
    }

    /// Where text sits relative to its x.
    pub fn text_align(self, align: CanvasTextAlign) -> Self {
        self.op(CanvasOp::TextAlign(align))
    }

    /// Where text sits relative to its y.
    pub fn text_baseline(self, baseline: CanvasTextBaseline) -> Self {
        self.op(CanvasOp::TextBaseline(baseline))
    }

    /// Fills `text` at (`x`, `y`).
    pub fn fill_text(self, text: &str, x: impl Into<CanvasArg>, y: impl Into<CanvasArg>) -> Self {
        self.text(text, x, y, None, false)
    }

    /// Fills `text` at (`x`, `y`), narrowed to fit `max_width`.
    pub fn fill_text_max_width(
        self,
        text: &str,
        x: impl Into<CanvasArg>,
        y: impl Into<CanvasArg>,
        max_width: Points,
    ) -> Self {
        self.text(text, x, y, Some(max_width), false)
    }

    /// Strokes the outline of `text` at (`x`, `y`).
    pub fn stroke_text(self, text: &str, x: impl Into<CanvasArg>, y: impl Into<CanvasArg>) -> Self {
        self.text(text, x, y, None, true)
    }

    /// Strokes the outline of `text` at (`x`, `y`), narrowed to fit
    /// `max_width`.
    pub fn stroke_text_max_width(
        self,
        text: &str,
        x: impl Into<CanvasArg>,
        y: impl Into<CanvasArg>,
        max_width: Points,
    ) -> Self {
        self.text(text, x, y, Some(max_width), true)
    }

    fn text(
        mut self,
        text: &str,
        x: impl Into<CanvasArg>,
        y: impl Into<CanvasArg>,
        max_width: Option<Points>,
        stroke: bool,
    ) -> Self {
        let (text, x, y) = (text.into(), self.num(x), self.num(y));
        self.op(if stroke {
            CanvasOp::StrokeText {
                text,
                x,
                y,
                max_width,
            }
        } else {
            CanvasOp::FillText {
                text,
                x,
                y,
                max_width,
            }
        })
    }

    /// Draws the image at `uri` (a URL or `asset:/path`) into `dest`.
    pub fn draw_image(self, uri: &str, dest: Bounds<Points>) -> Self {
        self.draw_image_part(uri, None, dest)
    }

    /// Draws the part `source` of the image at `uri` (in the image's
    /// pixels; `None`: all of it) into `dest`.
    pub fn draw_image_part(
        self,
        uri: &str,
        source: Option<Bounds<ScaledPixels>>,
        dest: Bounds<Points>,
    ) -> Self {
        self.op(CanvasOp::DrawImage {
            image: CanvasImage { uri: uri.into() },
            source,
            dest: nums(dest),
        })
    }
}

/// `[x, y, w, h]` of `rect`, as a recorded rectangle's numbers.
fn nums(rect: Bounds<Points>) -> [Num; 4] {
    [
        rect.origin.x,
        rect.origin.y,
        rect.size.width,
        rect.size.height,
    ]
    .map(|v| Num::Const(v.0))
}

impl From<Drawing> for Painter {
    fn from(drawing: Drawing) -> Self {
        Self {
            drawing,
            nodes: Vec::new(),
        }
    }
}

crate::static_reactive!(ScreenAnimation: ScreenAnimation);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        element::{
            AnimatedValue,
            reactive::{Runtime, create_root, signal},
        },
        shader::{ShaderUniforms, UniformValue},
    };

    fn uniforms(attrs: &super::super::builder::Attrs) -> ShaderUniforms {
        attrs
            .props
            .iter()
            .find_map(|p| match p {
                Prop::Uniforms(u) => Some(u.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    /// The animation nodes released since the last call.
    fn released(executor: &super::super::task::Executor) -> usize {
        executor
            .take_actions()
            .into_iter()
            .filter(|a| {
                matches!(
                    a,
                    super::super::task::Action::Animation(
                        crate::animation::AnimationOp::Release { .. }
                    )
                )
            })
            .count()
    }

    fn value(u: &ShaderUniforms, name: &str) -> Option<UniformValue> {
        u.0.iter()
            .find(|(n, _)| &**n == name)
            .map(|(_, v)| v.clone())
    }

    #[test]
    fn uniform_takes_static_bound_and_animated_values() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = std::rc::Rc::new(super::super::task::Executor::default());
        let (value_owner, wave) = create_root(|| AnimatedValue::new(&executor, 0.0));
        let speed = signal(1.0_f32);
        let view = shader()
            .uniform("center", [0.5_f32, 0.5])
            .uniform("wave", &wave)
            .uniform("speed", move || speed.get());
        let node = view.0;

        // The static and animated ones are set at once; the animated one by
        // its node, which the element holds.
        let set = uniforms(&node.attrs);
        assert_eq!(
            value(&set, "center"),
            Some(UniformValue::List(vec![
                UniformValue::Number(0.5),
                UniformValue::Number(0.5)
            ]))
        );
        let id = wave.node().live().expect("live").id();
        assert_eq!(value(&set, "wave"), Some(UniformValue::Animated(id)));
        assert_eq!(
            node.attrs.bound.len(),
            1,
            "the element holds the animated node"
        );
        assert_eq!(
            value(&set, "speed"),
            None,
            "a bound one is applied when resolved"
        );

        // The bound one follows its signal.
        assert_eq!(
            value(&uniforms(&node.resolved_attrs()), "speed"),
            Some(UniformValue::Number(1.0))
        );
        speed.set(2.0);
        assert_eq!(
            value(&uniforms(&node.resolved_attrs()), "speed"),
            Some(UniformValue::Number(2.0))
        );

        // The node outlives the owner of the handle it came from.
        value_owner.dispose();
        assert_eq!(released(&executor), 0, "the view keeps the animated node");
        drop(node);
        assert_eq!(released(&executor), 1, "and lets it go with the view");
    }

    #[test]
    fn a_later_uniform_replaces_one_of_the_same_name() {
        let view = shader().uniform("speed", 1.0_f32).uniform("speed", 3.0_f32);
        let set = uniforms(&view.0.attrs);
        assert_eq!(set.0.len(), 1);
        assert_eq!(value(&set, "speed"), Some(UniformValue::Number(3.0)));
    }
}
