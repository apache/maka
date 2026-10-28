//! Elements and the components written in Rust: `nsh`'s primitives (the host
//! elements) and the components of apps' own crates (their UI sets), run by
//! the core on the engine thread.
//!
//! A [`Component`] is a function that runs once ([`Component::view`]) and
//! makes a tree of elements ([`view`], [`text`], [`image`], other
//! components) styled with typed methods ([`Styled`]: `.px_4()`,
//! `.rounded_xl()`, `.bg(rgb(0x2563eb))`) that lower into the same rules
//! as Tailwind classes. The core expands the tree into nodes of its own and
//! lays it out in the same pass as everything else, so a component sizes
//! like any view, with no round trip. What changes is bound: a text, prop
//! or style given a signal, a memo, a [`Prop`] or a closure is a render
//! effect whose runs patch that part alone, and a region ([`dynamic`],
//! [`when`], [`each`], [`catch_error`]) makes its own elements again. State
//! is signals the view makes (under the component's owner: they go with
//! it), changed by listeners, timers and tasks ([`ambient::spawn`]); the
//! component's listeners hear its elements' events first and decide what
//! reaches JS ([`Scope::emit`]). The environment and the design tokens are
//! signals too ([`ambient::window`], [`ambient::tokens`]): reading one in a binding
//! subscribes it.
//!
//! Props are a struct (`#[derive(Props)]`), events an enum
//! (`#[derive(Event)]`); their JS face (`nsh-js`) and TypeScript
//! declarations ([`declarations`]) are made from them. In JS a component is one host node:
//! the root of its expansion. The app's `class` is appended to the root's
//! styles and its `style` stays the root's inline style. Colors have a
//! light and a dark value each ([`AdaptiveColor`]; the design [`Tokens`]).
//!
//! Node ids: JS allocates even ids, the core odd ones for the nodes it
//! expands, so both stay dense. How the core runs components:
//! `docs/dev/components.md`.

pub mod ambient;
pub(crate) mod animated;
mod asset;
mod back;
pub(crate) mod builder;
pub(crate) mod call;
mod callback;
pub(crate) mod class;
mod component;
pub mod description;
pub mod desktop;
mod element_ref;
mod engine_context;
pub(crate) mod env;
mod events;
pub(crate) mod flow;
pub(crate) mod host;
mod js;
#[cfg(test)]
pub(crate) mod json_host;
mod keyboard;
pub(crate) mod keys;
pub(crate) mod module;
mod once;
pub mod palette;
mod prop;
pub mod reactive;
pub(crate) mod renderer;
mod resource;
pub(crate) mod responder;
mod rows;
mod scrollable;
pub(crate) mod services;
pub(crate) mod status_bar;
mod style;
mod system;
pub(crate) mod task;
pub mod tokens;
mod value;
pub(crate) mod virtual_list;

/// Whether this build carries the text of declarations: the documentation
/// and TypeScript of the specs, which only make `.nsh/types`. The
/// WebAssembly runtime, which pages download and which writes no
/// declarations, goes without ([`decl!`](crate::decl)); the specs keep
/// their shape (names, kinds, whether a method returns).
pub const DECLARATIONS: bool = !cfg!(target_arch = "wasm32");

/// Declaration text: `$text` where the build carries it
/// ([`DECLARATIONS`]), `""` (a list: `&[]`) where it does not. In a
/// constant the text is then not in the binary at all.
#[macro_export]
macro_rules! decl {
    ([$($text:expr),* $(,)?]) => {
        if $crate::element::DECLARATIONS { &[$($text),*] as &[&'static str] } else { &[] }
    };
    ($text:expr) => {
        if $crate::element::DECLARATIONS { $text } else { "" }
    };
}

pub use nsh_macros::{
    Event, JsObject, PropEnum, Props, asset, assets, class, component, methods, module,
    native_module,
};

// The core's parts of `nsh_base`'s navigation and dialogs.
#[doc(hidden)]
pub use self::host::{modal, screen, stack};
pub(crate) use self::{
    animated::LiveNode,
    back::BackListener,
    builder::{ElKind, PlaceFn},
    component::{AnyInstance, caught},
    task::{Action, AnswerSlot, ClipboardRead, Executor},
};
pub use self::{
    animated::{
        Animated, AnimatedNode, AnimatedValue, Animation, AnimationEnd, AnimationOperand,
        DiffClamp, Interpolation, Motion, Spring, Timing, sample_decay, sample_decay_within,
        sample_spring,
    },
    asset::{AssetFile, AssetKind, FileAsset, FontAsset, ImageAsset, ImageSrc},
    builder::{
        __hint_tooltip, Accessible, AnyElement, Attrs, BoundListConfig, Child, Children,
        ComponentBuilder, ComponentElement, ElNode, Element, FluentBuilder, Image, Interactive,
        IntoChild, IntoElement, IntoListener, IntoTooltip, Items, ListConfig, ListElement,
        Listener, ParentElement, Position, Slot, SlotElement, Style, Text, View, image, text, view,
    },
    call::{
        AnyValue, EventToJs, JsEvent, JsResult, MethodCall, OpCall, ParkedPost, Posts, RustCall,
        RustOp, TaskStart, ToJs,
    },
    callback::{
        Callback, CallbackArgs, CallbackHandle, CallbackRet, Exception, JsCall, Trace, Tracer,
    },
    class::{
        Arg, AsyncCall, Class, ClassDef, ClassInstance, ClassRefs, ClassSpec, Instance, Member,
        MemberCall, MemberKind, MemberSpec, Ret, Thrown,
    },
    component::{
        Api, Component, ComponentError, ComponentSpec, Event, EventSpec, Method, MethodSpec,
        Methods, NoEvent, Param, PropDecode, PropKind, PropSpec, Props, Registry, Root, ValueSpec,
        declarations,
    },
    element_ref::{ComponentRef, ElementRef},
    engine_context::{EngineContext, EngineContextGuard, engine_context},
    env::Environment,
    events::{
        CaretEvent, Composition, FileDropEvent, GestureEvent, ImageProgress, NativeEvent,
        OverlayPosition, PanEvent, ScrollEvent, ScrollIntent, Selection, VideoInfo, VideoProgress,
        WebNavigation,
    },
    flow::{Each, If, IntoElements, Reset, catch_error, dynamic, each, when},
    host::{
        CanvasArg, CanvasPaint, CanvasView, Input, InputAccessoryView, IntoUniform, Modal,
        NativeView, Orientation, Overlay, Painter, Screen, Scroll, ShaderView, Stack, Uniform,
        Video, WebView, canvas, input, input_accessory_view, native, overlay, scroll, shader,
        video, web_view, web_view_html,
    },
    js::{JsHost, JsIn, JsKind, JsOwned, JsRaw},
    keyboard::Keyboard,
    module::{
        Constant, ConstantValue, Function, FunctionCall, FunctionKind, FunctionSpec, Module,
        ModuleCx, ModuleFuture, ModuleParam, ModuleSpec, Overload, OverloadSpec, SyncCall,
    },
    once::Scope,
    prop::{IntoProp, Prop},
    reactive::{
        IntoReactive, Memo, Owner, Reactive, ReadSignal, Runtime, Signal, SignalEquals, Stored,
        batch, cleanup, computed, create_root, effect, provide_context, signal, signal_with,
        stored, untracked, use_context,
    },
    renderer::{__decoding_props_of, RenderValue, Rendered, Renderer},
    resource::{Resource, ResourceInfo, ResourceState, resource, resource_with_value},
    responder::{ClaimRequest, PanGesture, ResponderEvent, TouchClaim},
    rows::{RowAccessor, RowRef, RowText, Rows},
    scrollable::Scrollable,
    services::{Fetch, HttpResponse, Prefetch},
    style::{
        AdaptiveColor, BorderCurve, FontWeight, LayoutDirection, StyleRefinement, Styled,
        WritingDirection,
    },
    system::{
        CallCx, Cleanup, ErrorClass, ErrorFields, Held, IntoThrown, JsError, Later, Local, Locals,
        Quotas, System, io_code,
    },
    task::{Answer, ClipboardImage, DialogAnswer, ImageSize, Task},
    tokens::{FONT_MONO, FONT_SANS, ThemeTokens, Token, TokenSource, Tokens},
    value::{JsValue, NodeRef, PropEnum, PropError, SharedString, TsType, TsTypes, ts_of},
    virtual_list::{ListLayout, ViewableItems, VirtualList, virtual_list},
};
/// The geometry Rust components style with (`crate::geometry`).
pub use crate::geometry::{
    AbsoluteLength, Bounds, Corners, DefiniteLength, DevicePixels, Edges, Length, Percentage,
    Point, Points, Radians, Rems, Size, auto, bounds, deg, percentage, point, px, radians,
    relative, rems, size,
};
pub use crate::{
    AccessibilityRole, AccessibilityState, AutoCapitalize, AutoFill, BackdropMaterial, BlendMode,
    BoxShadow, ContextMenuEvent, Cursor, Dialog, DialogButton, DialogButtonStyle, EdgeInsets,
    EllipsizeMode, EventKind, EventPayload, HeaderSystemItem, HoverEvent, KeyboardAppearance,
    KeyboardDismissMode, KeyboardTaps, KeyboardType, KeyframeAnimation, Keyframes, LayoutAnimation,
    LayoutCurve, LayoutProperty, LayoutTransition, ListViewport, Measurement, ModalAnimation,
    ModalPresentation, PanActivation, PasteBehavior, PasteEvent, PastedFile, PointerEvents,
    PressEvent, ResizeMode, ReturnKeyType, ScreenAnimation, SnapAlignment, StatusBarConfig,
    StatusBarSetting, StatusBarStyle, SubmitBehavior, TextShadow, TouchEvent, TransformKind,
    TransformOrigin, Viewability,
    animation::{
        Curve, EaseMode, Easing, Extrapolate, Keyframe, KeyframeTiming, MotionChannel, MotionKind,
        MotionPreset, MotionSpec, Output as AnimationOutput, PlaybackDirection, StaggerFrom,
        StepPosition, sample_easing,
    },
    color::{
        ColorParseError, Hsla, Rgba, black, blue, green, hsl, hsla, opaque_grey, red, rgb, rgba,
        transparent_black, transparent_white, white, yellow,
    },
    overlay::{Align, Placement},
    platform::{
        Appearance, HttpBody, HttpHead, HttpRequest, Idiom, Locale, Os,
        Renderer as PlatformRenderer,
    },
    style::Color,
};

/// What the macros' code and nsh's generated workspace name.
#[doc(hidden)]
pub mod __private {
    pub use serde_json::Map as JsonMap;

    /// The type of a props struct's field `I` as its setter takes it (the
    /// value of an `Option`): `#[derive(Props)]` implements it where the
    /// field's type is in scope, for the setters a `#[component]` makes on
    /// its element.
    pub trait PropField<const I: usize> {
        /// What the setter takes.
        type Value;
    }

    /// The values a render prop's function renders (`Option<Renderer<T>>`'s
    /// `T`), for the setter a `#[component]` makes for the prop.
    pub trait RendererOf {
        /// What the function renders.
        type Item;
    }

    impl<T> RendererOf for Option<super::Renderer<T>> {
        type Item = T;
    }

    /// The data of an event enum's variant `I` as its listener hears it:
    /// `#[derive(Event)]` implements it, for the listener methods a
    /// `#[component]` makes on its element.
    pub trait EventVariant<const I: usize> {
        /// What the listener hears.
        type Data: ?Sized + 'static;

        /// The data of `event`, when it is this variant.
        fn pick(event: &Self) -> Option<&Self::Data>;
    }

    pub use super::{callback::NamedArgs, class::__private::*, value::object_field};

    /// Implemented by nothing: what the generated workspace of an app
    /// calls when a crate of the app has no `#[native_module]`
    /// ([`no_native_module`]) fails the build with this message.
    #[diagnostic::on_unimplemented(
        message = "a crate of the app (nsh.json \"rust\") has no `#[native_module(\"…\")]` at its root",
        label = "the crate's UI set",
        note = "add to the crate's lib.rs, with the specifier its TSX imports the set by: `#[native_module(\"my-app/native\")] fn native(registry: &mut Registry) {{ registry.register::<MyComponent>(); }}` (`use nsh_core::prelude::*`)"
    )]
    pub trait NoNativeModule {}

    /// Implemented by nothing: `#[native_module]` in a module other than
    /// the crate's root fails with this message.
    #[diagnostic::on_unimplemented(
        message = "`#[native_module]` goes at the root of the crate (lib.rs)",
        label = "nsh's generated workspace calls the entry it makes there",
        note = "move the function with `#[native_module(\"…\")]` to the crate's lib.rs"
    )]
    pub trait NotAtRoot {}

    /// Stands in for the entry `#[native_module]` makes
    /// (`app::__nsh_native_module`) when the app's crate has none: a glob
    /// import of the crate in a block shadows it, so it is only called, and
    /// fails to compile, without the entry.
    pub fn no_native_module<R: NoNativeModule>() -> R {
        unreachable!("never compiles")
    }

    /// Stands in for `crate::__nsh_native_module` when `#[native_module]`
    /// is not at the crate's root (as [`no_native_module`]).
    pub fn native_module_not_at_root<R: NotAtRoot>() -> R {
        unreachable!("never compiles")
    }
}
