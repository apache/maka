//! What the JS side is decoded with and typed from, so the two cannot
//! drift apart: the animation graph's codes ([`protocol`]), the canvas
//! operations and their decoding ([`canvas`], with [`ops`]'
//! `#[derive(JsOps)]`), the style types ([`style`]), the host elements'
//! props ([`host`]: their decoding and types, from `#[derive(HostProps)]`
//! on [`crate::Prop`]) and the easings and layout animations ([`animation`]).
//! The decoders in `nsh-js` match on the same constants and call the
//! derived decoders, and their declarations go into the ones apps are
//! checked against (`nsh-js` `declarations.rs`).

/// nsh's own native ES modules, which bundles compiled with nsh's JSX
/// compiler import (served by `nsh-js`, left as imports by the bundler):
/// `nsh`, the API apps write against; `nsh:rt`, the renderer compiled JSX
/// calls; and the platform APIs `nsh/desktop` and `nsh/mobile`.
/// Registries add UI sets (`Registry::specifier`: `nsh/base`, an app's set)
/// or exports to those modules, such as `nsh`'s Image and device services.
pub const NATIVE_MODULES: &[&str] = &["nsh", "nsh:rt", "nsh/desktop", "nsh/mobile"];

/// The exact gpui-shell standard catalog, using canonical bare specifiers.
/// Privileged entries route through NSH capability adapters.
pub const STANDARD_MODULES: &[&str] = &[
    "buffer",
    "console",
    "crypto",
    "fs/promises",
    "net",
    "os",
    "path",
    "process",
    "url",
    "websocket",
    "zlib",
];

/// Whether a module is a standard builtin with its canonical spelling.
pub fn is_standard_module(name: &str) -> bool {
    STANDARD_MODULES.contains(&name)
}

/// The globals the standard module `crypto` defines: Web Crypto's `crypto`
/// and its classes. A runtime built without `crypto` (`nsh-js`'s feature)
/// has none of them, so code that names one needs a runtime with it (the
/// bundler's `NativeUse::global_crypto`).
pub const CRYPTO_GLOBALS: &[&str] = &["crypto", "Crypto", "SubtleCrypto", "CryptoKey"];

/// The module name of an app's bundle (its entry chunk): stack traces show
/// `bundle.js:LINE:COL`, and the chunks of a split bundle import it as
/// `./bundle.js`.
pub const ENTRY_CHUNK: &str = "bundle.js";

/// The global function a split bundle's dynamic imports call (the bundler
/// rewrites `import("./Screen.js")` into `__nsh_import("Screen.js",
/// ["shared.js"])`): it makes the chunk and the chunks it imports
/// statically available (on the web, fetched), then imports the first.
pub const IMPORT_CHUNK: &str = "__nsh_import";

/// Constants of encoded operations and a table of them for the generators.
macro_rules! codes {
    ($table:ident: $($(#[doc = $doc:literal])* $name:ident = $value:literal),* $(,)?) => {
        $(
            #[doc = concat!("`", stringify!($name), "`.")]
            $(#[doc = $doc])*
            pub const $name: i32 = $value;
        )*

        /// The codes by name, with their documentation (the operands).
        pub const $table: &[(&str, i32, &str)] = &[$((stringify!($name), $value, concat!($($doc),*))),*];
    };
}

pub mod animation;
pub mod canvas;
pub mod host;
pub(crate) mod host_values;
mod limits;
pub mod ops;
pub mod protocol;
pub mod style;

pub use limits::{HostLimits, Limits};

#[cfg(test)]
mod tests {
    #[test]
    fn the_declarations_match_the_tables() {
        let canvas = super::canvas::declarations();
        assert!(
            canvas.contains("  moveTo(x: CanvasNumber, y: CanvasNumber): void;"),
            "{canvas}"
        );
        assert!(canvas.contains("counterclockwise?: boolean): void;"));
        assert!(canvas.contains("  lineCap: LineCap;"));
        assert!(canvas.contains("export type LineCap = \"butt\" | \"round\" | \"square\";"));
        let style = super::style::declarations();
        // Every property the core parses has a type, in its interface.
        for (name, ts) in [
            ("boxShadow", "string | BoxShadowLayer[]"),
            ("textShadow", "string | TextShadowLayer[]"),
            ("gridTemplateColumns", "string"),
            ("transform", "string | TransformStep[]"),
            ("rotate", "string | number | AnimatedNode"),
            ("tintColor", "ColorValue"),
            (
                "display",
                "\"flex\" | \"grid\" | \"block\" | \"flow-root\" | \"none\"",
            ),
        ] {
            assert!(style.contains(&format!("  {name}?: {ts};")), "{name}");
        }
        assert!(!style.contains("backdropMaterial"));
        // Style keys, not props.
        for key in [
            "numberOfLines",
            "textOverflow",
            "userSelect",
            "pointerEvents",
        ] {
            assert!(style.contains(&format!("  {key}?: ")), "{key}");
        }
        let text = style.find("export interface TextStyle").unwrap();
        assert!(style[text..].contains("  textDecorationStyle?:"));
        // Each host prop and event in the interface of the elements it is for.
        let elements = super::host::declarations();
        for (interface, prop) in [
            ("HostProps", "  onPress?: (e?: PressEvent) => void;"),
            ("HostProps", "  onLongPress?: (e?: PressEvent) => void;"),
            ("HostProps", "  onPressDown?: (e?: PressEvent) => void;"),
            ("HostProps", "  onPressUp?: (e?: PressEvent) => void;"),
            ("HostProps", "  onLayout?: (bounds: Bounds) => void;"),
            ("AndroidHostProps", "  elevation?: number;"),
            ("IOSHostProps", "  backdropMaterial?: BackdropMaterial;"),
            ("InputHostProps", "  keyboardType?: KeyboardType;"),
            ("InputHostProps", "  onChange?: (text: string) => void;"),
            (
                "InputHostProps",
                "  onSubmit?: (e: { text: string }) => void;",
            ),
            ("InputHostProps", "  masked?: boolean;"),
            ("InputHostProps", "  readonly?: boolean;"),
            ("InputHostProps", "  tokens?: InputTokenRule[];"),
            ("IOSInputHostProps", "  inputAccessoryViewID?: string;"),
            (
                "IOSInputHostProps",
                "  keyboardAppearance?: KeyboardAppearance;",
            ),
            ("ImageHostProps", "  onLoad?: (e: PixelSize) => void;"),
            (
                "TextHostProps",
                "  textSource?: { id: string; offset: number; segments?: never } | { id: string; offset?: never; segments: { start: number; end: number; sourceStart: number; sourceEnd: number; kind: \"literal\" | \"replacement\" }[] };",
            ),
            (
                "VideoHostProps",
                "  onLoad?: (e: { duration: number; size: PixelSize }) => void;",
            ),
            ("VideoHostProps", "  audioSession?: AudioSession;"),
            (
                "ScrollingHostProps",
                "  decelerationRate?: \"normal\" | \"fast\" | number;",
            ),
            (
                "ScrollingHostProps",
                "  onScroll?: (e: ScrollEvent) => void;",
            ),
            (
                "ScrollingHostProps",
                "  onScrollIntent?: (e: { intent: \"start\" | \"end\" | \"scroll\" }) => void;",
            ),
            ("HostProps", "  onFocus?: () => void;"),
            ("HostProps", "  onBlur?: () => void;"),
            ("ListHostProps", "  contentStyle?: ListContentStyle;"),
            ("DialogHostProps", "  presentation?: ModalPresentation;"),
            ("DialogHostProps", "  closeOnEscape?: boolean;"),
            ("NavPageHostProps", "  headerBackTitle?: string;"),
            ("NavPageHostProps", "  popOnBack?: boolean;"),
            (
                "DesktopWebViewHostProps",
                "  allowsBackForwardNavigationGestures?: boolean;",
            ),
        ] {
            let at = elements
                .find(&format!("export interface {interface} {{"))
                .unwrap_or_else(|| panic!("{interface}"));
            let end = at + elements[at..].find("\n}").unwrap();
            assert!(elements[at..end].contains(prop), "{interface}: {prop}");
        }
        for kind in [crate::EventKind::Focus, crate::EventKind::Blur] {
            let (_, applies, handler, _) =
                super::host::EVENTS.iter().find(|e| e.0 == kind).unwrap();
            assert_eq!(*handler, "() => void");
            for tag in [
                crate::Tag::View,
                crate::Tag::Input,
                crate::Tag::Scroll,
                crate::Tag::List,
            ] {
                assert_ne!(
                    super::host::element_bits(tag) & applies,
                    0,
                    "{kind:?} on {tag:?}"
                );
            }
        }
        assert!(elements.contains(
            "export type KeyboardType = \"default\" | \"number-pad\" | \"decimal-pad\" | \"numeric\" | \"numbers-and-punctuation\""
        ));
        assert!(
            elements
                .contains("export type KeyboardAppearance = \"default\" | \"light\" | \"dark\";")
        );
        let animation = super::animation::declarations();
        assert!(animation.contains("  back(s?: number): EasingCurve;"));
        assert!(
            animation.contains("export type LayoutAnimationType = \"easeInEaseOut\" | \"spring\"")
        );
        assert!(animation.contains("  readonly scaleXY: \"scaleXY\";"));
        // What the runtime sets itself is not part of the types.
        for internal in [
            "splice?",
            "cellIndex?",
            "tailwindTheme?",
            "headerSlot?",
            "onChangeText?",
            "onDismiss?",
            "onRequestClose?",
            "selectionColor?",
            "placeholderTextColor?",
        ] {
            assert!(!elements.contains(internal), "{internal}");
        }
    }

    #[test]
    fn every_event_is_typed_or_internal() {
        use super::host::{EVENTS, INTERNAL_EVENTS};
        for kind in crate::EventKind::ALL {
            let typed = EVENTS.iter().any(|e| e.0 == *kind);
            let internal = INTERNAL_EVENTS.contains(kind);
            assert!(
                typed != internal,
                "{}: give it a handler type in `EVENTS` or list it in `INTERNAL_EVENTS`",
                kind.prop_name()
            );
        }
    }
}
