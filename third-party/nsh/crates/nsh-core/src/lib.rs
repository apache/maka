//! Platform-independent core of nsh.
//!
//! The core receives [`Op`]s from the JS renderer, maintains the shadow tree,
//! converts styles to [`taffy`] layout, merges inline text into
//! [`AttributedText`], runs layout and finally emits a [`MountBatch`] of
//! [`MountItem`]s that a platform backend applies to native views.
//!
//! Everything here is single-threaded and allocation-conscious: the core runs
//! on the engine thread, between the JS host and the platform backend.

mod byte_size;
pub use byte_size::ByteSize;
pub mod access;
pub mod animation;
pub mod audio;
pub mod canvas;
pub mod clipboard;
pub mod color;
mod core;
mod css;
mod css_named;
pub mod desktop;
mod effects;
pub mod element;
mod fenwick;
pub mod file_dialog;
pub mod file_type;
pub mod filesystem;
pub mod geometry;
mod grid;
pub mod host_channel;
pub mod i18n;
pub mod id_table;
pub mod image;
pub mod input;
pub mod js;
pub mod keymap;
pub mod main_thread;
pub mod mobile;
mod mount;
pub mod navigation;
pub mod notifications;
pub mod open_url;
mod ops;
pub mod overlay;
pub mod picker;
pub mod platform;
pub mod prelude;
mod props;
pub mod reactive;
pub mod resource;
#[doc(hidden)]
pub mod restart;
pub mod runtime;
pub mod runtime_data;
pub mod scroll;
pub mod selection;
pub mod shader;
pub mod shape;
pub mod single_instance;
pub mod speech;
pub mod storage;
mod style;
#[cfg(feature = "svg")]
pub mod svg;
pub mod tailwind;
mod text;
pub mod text_edit;
mod text_source;
pub mod time;
mod transform;
pub mod transition;
pub mod url_scheme;
pub mod web_resource;
pub mod websocket;

// The derive macros name `::nsh_core`, also in this crate's own tests.
extern crate self as nsh_core;

/// The values registered native components take and emit (props, events,
/// command arguments): JSON.
pub use serde_json::Value as JsonValue;

pub use crate::{
    color::{Hsla, Rgba},
    core::{ApplyError, Core, ListBind, ListScrollPosition, Measurement},
    effects::{
        BackdropMaterial, BlendMode, BoxShadow, ColorStop, Cursor, Effects, Filter, GlassEffect,
        Gradient, GradientKind, GradientSize, KeyframeAnimation, Keyframes, MacOsBackdrop,
        MacOsBackdropBlending, MacOsBackdropMaterial, MacOsBackdropState, Outline, Transition,
        TransitionProps, blur_radius, compose_color_matrices,
    },
    geometry::{Bounds, Corners, Edges, Point, Points, Size},
    image::ImageData,
    mount::{
        AudioSession, ImageOptions, InputConfig, ModalConfig, MountBatch, MountItem,
        NO_NATIVE_HEADER, NativeProps, NavShader, ScreenConfig, ScrollBehavior, StickyCell,
        VideoProps, ViewKind, WebProps,
    },
    ops::{
        AutoCapitalize, AutoFill, CellSlot, Command, ContextMenuEvent, Dialog, DialogButton,
        DialogButtonStyle, EditAction, EventKind, EventMask, EventPayload, Haptic, HapticImpact,
        HapticNotification, HeaderSlot, HeaderSystemItem, IMAGE_SCALES, ImageProp, ImageScales,
        ImageSource, KeyboardAppearance, KeyboardDismissMode, KeyboardTaps, KeyboardType,
        ListAlignment, ListContentStyle, ListViewport, ModalAnimation, ModalPresentation,
        ModalProp, MouseButton, MouseEvent, NativeProp, NodeId, Op, OverlayProp, PasteBehavior,
        PasteEvent, PastedFile, PayloadValue, PointerType, PressEvent, Prop, ROOT_ID, ResizeMode,
        ReturnKeyType, RevealOptions, ScreenAnimation, ScreenProp, ScrollAlignment, ScrollProp,
        ScrollbarSetting, SnapAlignment, StatusBarConfig, StatusBarSetting, StatusBarStyle,
        SubmitBehavior, Tag, TouchEvent, TouchPhase, TouchPoint, TransitionFallback, Viewability,
        WebElement, WebInput, WebKey, WebLoad, WebSource, WheelDelta, WheelEvent,
    },
    props::{
        Accessibility, AccessibilityActionDef, AccessibilityCurrent, AccessibilityProp,
        AccessibilityRole, AccessibilityState, AccessibilityValue, Checked, EdgeInsets,
        GestureValues, LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition, LiveRegion,
        PanActivation, PointerEvents, Ripple, ViewProps,
    },
    style::{
        BorderStyle, Borders, Color, CornerRadii, DecorationStyle, EllipsizeMode, EnvVar,
        FamilyName, FontFamily, FontVariant, GridTemplateValue, LineHeight, ObjectPosition,
        PaintStyle, PositionAxis, PropertyValue, Style, StyleDecl, StyleError, StyleKey,
        StylePatch, StyleValue, SvgPaint, TextAlign, TextDecoration, TextShadow, TextStyle,
        TextTransform, TransformOrigin, TransformProperty, VerticalAlign, ViewStyle, font_families,
    },
    text::{
        ATTACHMENT_CHAR, Affinity, ApproxTextEngine, AttachmentAlignments, AttributedText,
        BackgroundBox, FontExtent, LinePiece, ResolvedTextStyle, SpanTestId, TextAttachment,
        TextBackground, TextEngine, TextLayout, TextLine, TextLink, TextPosition, TextSpan,
        font_data, font_family, keep_font,
    },
    text_source::{ListSourceRows, TextSource, TextSourceKind, TextSourceSegment},
    transform::{
        Decomposed, MAX_TRANSFORMS, Matrix, Transform, TransformKind, TransformOp, translation,
    },
};
