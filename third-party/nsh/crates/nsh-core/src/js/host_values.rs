//! The host prop values that are objects or unions (sources, accessibility
//! descriptions, list layouts) and the props whose whole variant is
//! decoded by hand (`#[prop(with = …)]`): the shapes JS sends them in.

use std::sync::Arc;

use super::host::{HostCx, HostInput, HostList, HostValue, field};
use crate::{
    AccessibilityCurrent, AccessibilityProp, AccessibilityRole, AccessibilityState, AutoFill,
    CellSlot, EdgeInsets, HeaderItem, HeaderItemContent, HeaderSystemItem, ImageScales,
    ImageSource, KeyboardTaps, ListContentStyle, MacOsBackdrop, MacOsBackdropBlending,
    MacOsBackdropMaterial, MacOsBackdropState, ModalProp, Prop, RevealOptions, ScreenProp,
    ScrollAlignment, ScrollProp, StatusBarSetting, StatusBarStyle, Viewability, WindowsBackdrop,
    WindowsBackdropMaterial,
    element::{
        ElementTarget, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, ScrollEdgeTarget, TsTypes,
    },
    geometry::{Bounds, Percentage, Points, point, size},
    mount::ModalConfig,
    ops::OverlayProp,
    overlay::{OverlayAnchor, TooltipContent},
    props::{AccessibilityActionDef, AccessibilityValue, Checked, PanActivation, Ripple},
};

/// `"none"`, `"all"`, `"text"`, or the canonical keystrokes a view captures
/// (`"mod+k"`, `"shift+tab"`): parsed once here with the shortcut rules
/// and this platform's `mod`, which the engine's environment names
/// ([`crate::element::try_apple_keys`]); a JS host decoding outside that
/// environment calls [`crate::js::host::decode_capture_keys`] with its own
/// convention.
/// Another string clears the rule with a warning; an invalid keystroke in
/// the array is reported and left out.
impl HostValue for crate::KeyCapture {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        let apple = crate::element::try_apple_keys().unwrap_or(false);
        super::host::decode_capture_keys(input, cx, apple)
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "\"none\" | \"all\" | \"text\" | readonly string[]".into()
    }
}

fn number<I: HostInput>(input: &I, key: &str) -> Option<f32> {
    input
        .field(key)
        .and_then(|v| v.as_number())
        .map(|n| n as f32)
}

/// Field `key` of `input` as a number of points.
fn points<I: HostInput>(input: &I, key: &str) -> Option<Points> {
    number(input, key).map(Points)
}

/// The `scales` of an image asset (its first [`crate::ops::SCALES_READ`]
/// entries); values that are not [`crate::IMAGE_SCALES`] are left out.
fn scales<I: HostInput>(input: &I) -> ImageScales {
    let Some(list) = input.field("scales").and_then(|s| s.as_list()) else {
        return ImageScales::NONE;
    };
    (0..list.len().min(crate::ops::SCALES_READ))
        .filter_map(|i| list.item(i)?.as_number())
        .map(|n| n as f32)
        .collect()
}

/// `"https://…"` or a bundled asset `{ url, size: { width, height }, scales }`.
impl HostValue for ImageSource {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        if let Some(url) = input.as_string() {
            return (!url.is_empty()).then(|| ImageSource {
                uri: url.into(),
                size: None,
                scales: ImageScales::NONE,
                data: None,
            });
        }
        let url = input.field("url")?.as_string()?;
        let extent = input.field("size");
        let size = match extent
            .as_ref()
            .map(|e| (number(e, "width"), number(e, "height")))
        {
            Some((Some(w), Some(h))) => Some(size(Points(w), Points(h))),
            _ => None,
        };
        Some(ImageSource {
            uri: url.into(),
            size,
            scales: scales(input),
            data: None,
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "string | ImageAsset".into()
    }
}

/// `ref.reveal(options)`: `{ vertical?, horizontal?, animated? }`, each
/// missing one its default. None for an alignment that is not one, so the
/// call throws rather than scrolling somewhere the app did not ask for.
impl HostValue for RevealOptions {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        let mut options = RevealOptions::default();
        if input.is_nullish() {
            return Some(options);
        }
        if !input.is_object() {
            return None;
        }
        let mut alignment = |key: &str, default: ScrollAlignment| match input.field(key) {
            Some(value) if !value.is_nullish() => {
                <ScrollAlignment as HostValue>::decode(&value, cx)
            }
            _ => Some(default),
        };
        options.vertical = alignment("vertical", options.vertical)?;
        options.horizontal = alignment("horizontal", options.horizontal)?;
        if let Some(animated) = input.field("animated").and_then(|a| a.as_bool()) {
            options.animated = animated;
        }
        Some(options)
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let alignment = <ScrollAlignment as HostValue>::ts_type(types);
        types.declare("RevealOptions", |_| {
            format!(
                "/** How `reveal` places a view in the scroll views around it. */\n\
                 export interface RevealOptions {{\n  \
                 /** Along vertical scroll views; `\"start\"` by default. */\n  \
                 vertical?: {alignment};\n  \
                 /** Along horizontal scroll views; `\"nearest\"` by default. */\n  \
                 horizontal?: {alignment};\n  \
                 /** Animate the scrolls; `true` by default. */\n  \
                 animated?: boolean;\n}}"
            )
        })
    }
}

/// A list's `contentStyle`: the padding properties (numbers),
/// `gap` / `rowGap` / `columnGap`, and cross-axis `alignItems`.
impl HostValue for ListContentStyle {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        let align_items = input
            .field("alignItems")
            .and_then(|v| v.as_string())
            .and_then(|v| parse_list_align_items(v.as_str()));
        list_content(
            |key| Ok::<_, std::convert::Infallible>(points(input, key)),
            align_items,
        )
        .ok()
    }

    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("ListContentStyle", |_| {
            "/** Padding, gaps and cell alignment of a list's content (`contentStyle`). */\n\
             export interface ListContentStyle {\n  padding?: number;\n  paddingHorizontal?: number;\n  \
             paddingVertical?: number;\n  paddingTop?: number;\n  paddingRight?: number;\n  \
             paddingBottom?: number;\n  paddingLeft?: number;\n  gap?: number;\n  rowGap?: number;\n  \
             columnGap?: number;\n  alignItems?: \"stretch\" | \"flex-start\" | \"center\" | \"flex-end\";\n}"
                .into()
        })
    }
}

/// Resolve the list's existing shorthand/axis/side precedence at either
/// native JS boundary. Both decoders use this one content layout shape.
fn parse_list_align_items(value: &str) -> Option<taffy::AlignItems> {
    match value {
        "stretch" => Some(taffy::AlignItems::STRETCH),
        "flex-start" => Some(taffy::AlignItems::FLEX_START),
        "center" => Some(taffy::AlignItems::CENTER),
        "flex-end" => Some(taffy::AlignItems::FLEX_END),
        _ => None,
    }
}

fn list_content<E>(
    n: impl Fn(&str) -> Result<Option<Points>, E>,
    align_items: Option<taffy::AlignItems>,
) -> Result<ListContentStyle, E> {
    let all = n("padding")?.unwrap_or_default();
    let horizontal = n("paddingHorizontal")?.unwrap_or(all);
    let vertical = n("paddingVertical")?.unwrap_or(all);
    let gap = n("gap")?.unwrap_or_default();
    Ok(ListContentStyle {
        padding: EdgeInsets {
            top: n("paddingTop")?.unwrap_or(vertical),
            right: n("paddingRight")?.unwrap_or(horizontal),
            bottom: n("paddingBottom")?.unwrap_or(vertical),
            left: n("paddingLeft")?.unwrap_or(horizontal),
        },
        row_gap: n("rowGap")?.unwrap_or(gap),
        column_gap: n("columnGap")?.unwrap_or(gap),
        align_items,
    })
}

impl JsValue for ListContentStyle {
    fn ts_type(types: &mut TsTypes) -> String {
        <Self as HostValue>::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() != JsKind::Object {
            return Err(value.expected("a ListContentStyle object"));
        }
        let align_field = value.field("alignItems")?;
        let align_items = Option::<String>::from_js(align_field.get())
            .map_err(|error| PropError(format!("`alignItems`: {error}")))?
            .and_then(|v| parse_list_align_items(&v));
        list_content(
            |key| {
                let field = value.field(key)?;
                Option::<Points>::from_js(field.get())
                    .map_err(|error| PropError(format!("`{key}`: {error}")))
            },
            align_items,
        )
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        for (key, value) in [
            ("paddingTop", self.padding.top),
            ("paddingRight", self.padding.right),
            ("paddingBottom", self.padding.bottom),
            ("paddingLeft", self.padding.left),
            ("rowGap", self.row_gap),
            ("columnGap", self.column_gap),
        ] {
            host.set_field(object.get().raw(), key, value.to_js(host)?.into_raw())?;
        }
        if let Some(align) = self.align_items {
            let label = match align {
                taffy::AlignItems::STRETCH => Some("stretch"),
                taffy::AlignItems::FLEX_START => Some("flex-start"),
                taffy::AlignItems::CENTER => Some("center"),
                taffy::AlignItems::FLEX_END => Some("flex-end"),
                _ => None,
            };
            if let Some(label) = label {
                host.set_field(
                    object.get().raw(),
                    "alignItems",
                    label.to_string().to_js(host)?.into_raw(),
                )?;
            }
        }
        Ok(object)
    }
}

/// `macos={{ backdrop }}`: `{ material, blending, state }`, each field
/// falling back to its default when left out or unknown.
impl HostValue for MacOsBackdrop {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        Some(MacOsBackdrop {
            material: field::<MacOsBackdropMaterial, _>(input, "material", cx).unwrap_or_default(),
            blending: field::<MacOsBackdropBlending, _>(input, "blending", cx).unwrap_or_default(),
            state: field::<MacOsBackdropState, _>(input, "state", cx).unwrap_or_default(),
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let material = <MacOsBackdropMaterial as HostValue>::ts_type(types);
        let blending = <MacOsBackdropBlending as HostValue>::ts_type(types);
        let state = <MacOsBackdropState as HostValue>::ts_type(types);
        types.declare("MacOsBackdrop", |_| {
            format!(
                "/** The material a view draws with on macOS (`macos={{{{ backdrop }}}}`). */\n\
                 export interface MacOsBackdrop {{\n  material?: {material};\n  \
                 blending?: {blending};\n  state?: {state};\n}}"
            )
        })
    }
}

/// `ios={{ scrollEdgeElement }}`: `{ scrollView, edge }`, the scroll
/// view a ref holds and the edge (`"bottom"` when left out or unknown);
/// without a scroll view it is none.
impl HostValue for ScrollEdgeTarget {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        let scroll_view = input.field("scrollView")?.node()?;
        let edge = field::<crate::ScrollEdge, _>(input, "edge", cx).unwrap_or_default();
        Some(ScrollEdgeTarget::of_node(scroll_view, edge))
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let edge = <crate::ScrollEdge as HostValue>::ts_type(types);
        types.declare("ScrollEdgeElement", |_| {
            format!(
                "/** The scroll view a view floats over and the edge of it the view sits at \
                 (`ios={{{{ scrollEdgeElement }}}}`). */\n\
                 export interface ScrollEdgeElement {{\n  scrollView: ViewRef;\n  \
                 edge?: {edge};\n}}"
            )
        })
    }
}

impl HostValue for WindowsBackdrop {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        Some(Self {
            material: field(input, "material", cx)?,
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let material = <WindowsBackdropMaterial as HostValue>::ts_type(types);
        types.declare("WindowsBackdrop", |_| {
            format!(
                "/** The material a view draws with on Windows (`windows={{{{ backdrop }}}}`). */\n\
                 export interface WindowsBackdrop {{\n  material: {material};\n}}"
            )
        })
    }
}

/// A dialog's `detents`, `detent`, `defaultDetent` and
/// `largestUndimmedDetent`: `"medium"`, `"large"`, `{ height }` or
/// `{ fraction }`; anything else is left out with a warning.
impl HostValue for crate::SheetDetent {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        use crate::SheetDetent;
        if input.is_nullish() {
            return None;
        }
        if let Some(name) = input.as_string() {
            match name.as_str() {
                "medium" => return Some(SheetDetent::Medium),
                "large" => return Some(SheetDetent::Large),
                _ => {}
            }
        } else if input.is_object() {
            let number = |key| input.field(key).and_then(|v| v.as_number());
            let detent = match number("height") {
                Some(height) => SheetDetent::of_height(height),
                None => number("fraction").and_then(SheetDetent::of_fraction),
            };
            if detent.is_some() {
                return detent;
            }
        }
        cx.warn(
            r#"detent: expected "medium", "large", `{ height }` (0 or more) or `{ fraction }` (0 to 1)"#,
        );
        None
    }

    fn ts_type(types: &mut TsTypes) -> String {
        <crate::SheetDetent as crate::element::JsValue>::ts_type(types)
    }
}

/// A page's or dialog's `statusBar`: `{ foreground, hidden, animated }`
/// (`StatusBar`, declared with the navigation in `nsh/base`); the fields
/// left out keep what is below. An unknown `foreground` is left out.
impl HostValue for StatusBarSetting {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        let flag = |key| input.field(key).and_then(|v| v.as_bool());
        Some(StatusBarSetting {
            style: input
                .field("foreground")
                .and_then(|v| v.as_string())
                .and_then(|s| StatusBarStyle::from_name(&s)),
            hidden: flag("hidden"),
            animated: flag("animated"),
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "StatusBar".into()
    }
}

impl HostValue for Viewability {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        Some(Viewability {
            view_area_coverage_threshold: number(input, "viewAreaCoverageThreshold")
                .map(Percentage),
            item_visible_threshold: number(input, "itemVisibleThreshold").map(Percentage),
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "ViewabilityConfig".into()
    }
}

/// `{ activeOffsetX, activeOffsetY, failOffsetX, failOffsetY, direction,
/// edge }` (points, the sign ignored; an unknown `direction` or `edge` is
/// left out).
impl HostValue for PanActivation {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        let offset = |key| points(input, key).map(Points::abs);
        Some(PanActivation {
            active_offset_x: offset("activeOffsetX"),
            active_offset_y: offset("activeOffsetY"),
            fail_offset_x: offset("failOffsetX"),
            fail_offset_y: offset("failOffsetY"),
            direction: field(input, "direction", cx),
            edge: field(input, "edge", cx),
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let direction = <crate::PanDirection as HostValue>::ts_type(types);
        let edge = <crate::PanEdge as HostValue>::ts_type(types);
        types.declare("PanActivation", |_| {
            format!(
                "/** When a view's pans activate (`panActivation`; react-native-gesture-handler's\n \
                 * `activeOffsetX` / `failOffsetY`), decided natively on the main thread as the\n \
                 * finger moves: past an active offset the view becomes the responder, its `pan`\n \
                 * starts and the scroll views around it can no longer take the touches; past a\n \
                 * fail offset first it never does, and they keep them. Distances in points along\n \
                 * one axis, either direction; without active offsets it activates after 10 points. */\n\
                 export interface PanActivation {{\n  \
                 activeOffsetX?: number;\n  activeOffsetY?: number;\n  \
                 failOffsetX?: number;\n  failOffsetY?: number;\n  \
                 /** The one way it activates in: a drag the other way, or mostly across it, fails it. */\n  \
                 direction?: {direction};\n  \
                 /** Only a finger that goes down within 20 points of this edge of the screen (the\n   \
                 * window on desktops, the page on the web) starts it, moving away from the edge. */\n  \
                 edge?: {edge};\n}}"
            )
        })
    }
}

/// `{ disabled, selected, checked: true | false | "mixed", busy, expanded,
/// pressed: true | false | "mixed", current: true | false | "page" | ...,
/// hasPopup, invalid }`.
impl HostValue for AccessibilityState {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        let flag = |key| input.field(key).and_then(|v| v.as_bool()).unwrap_or(false);
        let tristate = |key| {
            let value = input.field(key);
            match value.as_ref().and_then(|c| c.as_bool()) {
                Some(true) => Some(Checked::True),
                Some(false) => Some(Checked::False),
                None => value
                    .and_then(|c| c.as_string())
                    .filter(|s| s == "mixed")
                    .map(|_| Checked::Mixed),
            }
        };
        let current = input.field("current");
        Some(AccessibilityState {
            disabled: flag("disabled"),
            selected: flag("selected"),
            checked: tristate("checked"),
            busy: flag("busy"),
            expanded: input.field("expanded").and_then(|v| v.as_bool()),
            pressed: tristate("pressed"),
            has_popup: flag("hasPopup"),
            invalid: flag("invalid"),
            // `false` and unknown words are no current item, as ARIA has it.
            current: match current.as_ref().and_then(|c| c.as_bool()) {
                Some(true) => Some(AccessibilityCurrent::True),
                Some(false) => None,
                None => match current.and_then(|c| c.as_string()).as_deref() {
                    Some("page") => Some(AccessibilityCurrent::Page),
                    Some("step") => Some(AccessibilityCurrent::Step),
                    Some("location") => Some(AccessibilityCurrent::Location),
                    Some("date") => Some(AccessibilityCurrent::Date),
                    Some("time") => Some(AccessibilityCurrent::Time),
                    Some("true") => Some(AccessibilityCurrent::True),
                    _ => None,
                },
            },
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("AccessibilityState", |_| {
            "/** The state assistive technologies report (`accessibilityState`). */\n\
             export interface AccessibilityState {\n  disabled?: boolean;\n  selected?: boolean;\n  \
             checked?: boolean | \"mixed\";\n  busy?: boolean;\n  expanded?: boolean;\n  \
             /** A toggle button that is on or off (ARIA's `aria-pressed`). */\n  \
             pressed?: boolean | \"mixed\";\n  \
             /** The current item of a set (ARIA's `aria-current`): a pagination's page, a wizard's step. */\n  \
             current?: boolean | \"page\" | \"step\" | \"location\" | \"date\" | \"time\";\n  \
             /** Opens a popup, a menu or a list (ARIA's `aria-haspopup`); `expanded` says whether it is open. */\n  \
             hasPopup?: boolean;\n  \
             /** The content does not pass the app's checks (ARIA's `aria-invalid`): a rejected field. */\n  \
             invalid?: boolean;\n}"
                .into()
        })
    }
}

/// `{ min, max, now, text }`.
impl HostValue for AccessibilityValue {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        Some(AccessibilityValue {
            min: number(input, "min"),
            max: number(input, "max"),
            now: number(input, "now"),
            text: field(input, "text", cx),
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "{ min?: number; max?: number; now?: number; text?: string }".into()
    }
}

/// `{ name, label }`; without a name there is no action.
impl HostValue for AccessibilityActionDef {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        Some(AccessibilityActionDef {
            name: field(input, "name", cx)?,
            label: field(input, "label", cx),
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "{ name: string; label?: string }".into()
    }
}

/// The `autoComplete` names of the TypeScript type ([`AutoFill::parse`]
/// takes a few more).
const AUTO_COMPLETE: &[&str] = &[
    "off",
    "username",
    "password",
    "current-password",
    "new-password",
    "one-time-code",
    "sms-otp",
    "email",
    "tel",
    "name",
    "given-name",
    "family-name",
    "additional-name",
    "nickname",
    "organization",
    "street-address",
    "address-line1",
    "address-line2",
    "address-level1",
    "address-level2",
    "postal-code",
    "country",
    "cc-number",
    "cc-exp",
    "cc-csc",
    "cc-name",
    "url",
    "birthdate-full",
];

/// iOS's `textContentType` names.
const TEXT_CONTENT_TYPE: &[&str] = &[
    "none",
    "username",
    "password",
    "newPassword",
    "oneTimeCode",
    "emailAddress",
    "telephoneNumber",
    "name",
    "givenName",
    "middleName",
    "familyName",
    "nickname",
    "organizationName",
    "fullStreetAddress",
    "streetAddressLine1",
    "streetAddressLine2",
    "addressCity",
    "addressState",
    "postalCode",
    "countryName",
    "creditCardNumber",
    "creditCardExpiration",
    "creditCardSecurityCode",
    "creditCardName",
    "URL",
    "birthdate",
];

/// `autoComplete` values or iOS's `textContentType` names; others are the
/// platform's default (and a warning).
impl HostValue for AutoFill {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        let name = input.as_string()?;
        let fill = AutoFill::parse(&name);
        if fill.is_none() {
            cx.warn(format!(
                "{name:?} is not a supported autoComplete / textContentType value"
            ));
        }
        fill
    }

    /// Either list of names: the decoder takes both.
    fn ts_type(types: &mut TsTypes) -> String {
        let union = |names: &[&str]| {
            names
                .iter()
                .map(|n| format!("{n:?}"))
                .collect::<Vec<_>>()
                .join(" | ")
        };
        let web = types.declare("AutoComplete", |_| {
            format!(
                "/** What an input holds, for autofill (React Native's `autoComplete` values). */\n\
                 export type AutoComplete = {};",
                union(AUTO_COMPLETE)
            )
        });
        let ios = types.declare("TextContentType", |_| {
            format!(
                "/** iOS's names for `autoComplete` values. */\nexport type TextContentType = {};",
                union(TEXT_CONTENT_TYPE)
            )
        });
        format!("{web} | {ios}")
    }
}

/// `{ color, borderless, radius, foreground }`.
impl HostValue for Ripple {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        let flag = |key| input.field(key).and_then(|v| v.as_bool()).unwrap_or(false);
        Some(Ripple {
            color: field(input, "color", cx),
            borderless: flag("borderless"),
            radius: points(input, "radius"),
            foreground: flag("foreground"),
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "{ color?: ColorValue; borderless?: boolean; radius?: number; foreground?: boolean }".into()
    }
}

/// A trailing iOS bar button: `{ key?, systemItem | symbol | label,
/// disabled?, menu? }`. Handlers (`onPress`, menu `onSelect`) are taken by
/// the JS runtime when it sets the prop; this decode leaves their ids at 0.
impl HostValue for HeaderItem {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        let system = field::<HeaderSystemItem, _>(input, "systemItem", cx);
        let symbol = field::<std::sync::Arc<str>, _>(input, "symbol", cx);
        let label_content = field::<std::sync::Arc<str>, _>(input, "label", cx);
        let content = match (system, symbol, label_content.clone()) {
            (Some(item), None, _) => HeaderItemContent::SystemItem(item),
            (None, Some(name), _) => HeaderItemContent::Symbol(name),
            (None, None, Some(text)) => HeaderItemContent::Label(text),
            _ => {
                cx.warn("headerRightItems entry needs exactly one of systemItem, symbol, or label");
                return None;
            }
        };
        // `label` is the button's title when it is the content; otherwise
        // VoiceOver's label (re-read when content was system/symbol).
        let label = match &content {
            HeaderItemContent::Label(_) => None,
            _ => label_content,
        };
        let flag = |key| input.field(key).and_then(|v| v.as_bool()).unwrap_or(false);
        let menu = input.field("menu").and_then(|v| {
            v.as_list()?;
            Some(
                v.items()
                    .iter()
                    .filter_map(|item| decode_menu_item(item, cx))
                    .collect::<Vec<_>>(),
            )
        });
        Some(HeaderItem {
            key: field(input, "key", cx),
            content,
            label,
            disabled: flag("disabled"),
            press_id: 0,
            menu,
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let system = <HeaderSystemItem as HostValue>::ts_type(types);
        types.declare("HeaderItem", |_| {
            format!(
                "/** A trailing iOS navigation-bar button (`ios.headerRightItems`).\n\
                 * `menu` takes `nsh/desktop`'s `MenuItem` items (`onSelect` per\n\
                 * item; `destructive`, `inline`, `symbol` as documented there).\n\
                 * `onPress` runs when the button has no menu. */\n\
                 export type HeaderItem = {{\n  key?: string;\n  disabled?: boolean;\n  \
                 onPress?: () => void;\n  menu?: import(\"nsh/desktop\").MenuItem[];\n}} & (\n  \
                 {{ systemItem: {system}; symbol?: never; label?: string }} \
                 | {{ symbol: string; systemItem?: never; label?: string }} \
                 | {{ label: string; systemItem?: never; symbol?: never }}\n);"
            )
        })
    }
}

/// One `nsh/desktop` menu item without its handlers (ids stay 0); JS's
/// special path for `headerRightItems` assigns ids and keeps the functions.
fn decode_menu_item<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<crate::desktop::MenuItem> {
    use crate::{
        desktop::{MenuAction, MenuItem},
        keymap::When,
    };
    if !input.is_object() {
        return None;
    }
    if input.field("type").and_then(|v| v.as_string()).as_deref() == Some("separator") {
        return Some(MenuItem::Separator);
    }
    let flag = |key| input.field(key).and_then(|v| v.as_bool());
    let label = field::<String, _>(input, "label", cx).unwrap_or_default();
    let enabled = !flag("disabled").unwrap_or(false);
    let icon = field::<ImageSource, _>(input, "icon", cx);
    let symbol = field::<String, _>(input, "symbol", cx);
    if let Some(items_input) = input.field("submenu") {
        let items = items_input
            .items()
            .iter()
            .filter_map(|item| decode_menu_item(item, cx))
            .collect();
        return Some(MenuItem::Submenu {
            label,
            enabled,
            items,
            icon,
            symbol,
            inline: flag("inline").unwrap_or(false),
        });
    }
    let role = field::<String, _>(input, "role", cx).and_then(|name| menu_role(&name));
    if label.is_empty() && role.is_none() {
        return None;
    }
    Some(MenuItem::Action(MenuAction {
        id: 0,
        label,
        shortcut: None,
        enabled,
        checked: flag("checked"),
        role,
        when: When::Always,
        icon,
        symbol,
        destructive: flag("destructive").unwrap_or(false),
    }))
}

fn menu_role(name: &str) -> Option<crate::desktop::MenuRole> {
    use crate::desktop::MenuRole;
    Some(match name {
        "about" => MenuRole::About,
        "hide" => MenuRole::Hide,
        "hideOthers" => MenuRole::HideOthers,
        "showAll" => MenuRole::ShowAll,
        "quit" => MenuRole::Quit,
        "undo" => MenuRole::Undo,
        "redo" => MenuRole::Redo,
        "cut" => MenuRole::Cut,
        "copy" => MenuRole::Copy,
        "paste" => MenuRole::Paste,
        "selectAll" => MenuRole::SelectAll,
        "minimize" => MenuRole::Minimize,
        "zoom" => MenuRole::Zoom,
        "toggleFullScreen" => MenuRole::ToggleFullScreen,
        "close" => MenuRole::Close,
        _ => return None,
    })
}

// --- Whole variants ---------------------------------------------------------

/// `selectionMenu`: `nsh/desktop`'s `MenuItem` items. Handlers (`onSelect`)
/// are taken by the JS runtime when it sets the prop; this decode leaves
/// their ids at 0.
pub(crate) fn selection_menu<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Prop> {
    if input.is_nullish() {
        return Some(Prop::SelectionMenu(Vec::new()));
    }
    input.as_list()?;
    Some(Prop::SelectionMenu(
        input
            .items()
            .iter()
            .filter_map(|item| decode_menu_item(item, cx))
            .collect(),
    ))
}

/// `slot`: a recycling slot (a number) or a role.
pub(crate) fn slot<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::Slot(match input.as_string() {
        Some(role) => match role.as_str() {
            "header" => CellSlot::Header,
            "footer" => CellSlot::Footer,
            _ => CellSlot::Empty,
        },
        None => CellSlot::Item(input.as_number().unwrap_or(0.0) as u32),
    }))
}

/// `splice`: `[at, removed, inserted]`.
pub(crate) fn splice<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    let items = input.items();
    let at = |i: usize| {
        items
            .get(i)
            .and_then(|v| v.as_number())
            .unwrap_or(0.0)
            .max(0.0) as u32
    };
    Some(Prop::Splice(at(0), at(1), at(2)))
}

/// `stickyHeaderIndices`: the indexes, negative ones skipped.
pub(crate) fn sticky<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::StickyIndices(
        input
            .items()
            .iter()
            .filter_map(|v| v.as_number())
            .filter(|v| *v >= 0.0)
            .map(|v| v as u32)
            .collect(),
    ))
}

/// `selection`: `{ start, end }` (a caret without `end`); nothing without
/// `start`.
pub(crate) fn selection<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    let field = |key| input.field(key).and_then(|v| v.as_number());
    let start = field("start")?.max(0.0) as u32;
    Some(Prop::Selection(
        start,
        field("end").map_or(start, |e| e.max(0.0) as u32),
    ))
}

/// `textSource`: one literal byte offset, or ordered, non-overlapping local
/// UTF-16 ranges mapped to absolute source byte ranges. Text boundaries are
/// checked by the core against the actual flattened text.
pub(crate) fn text_source<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    fn integer<I: HostInput>(input: &I) -> Option<u64> {
        let n = input.as_number()?;
        (n.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0)
            .then_some(n as u64)
    }

    fn decode<I: HostInput>(input: &I) -> Option<crate::TextSource> {
        let id = input.field("id")?.as_string()?;
        if id.is_empty() {
            return None;
        }
        let source = match (input.field("offset"), input.field("segments")) {
            (Some(offset), None) => crate::TextSource::Literal {
                id: id.into(),
                offset: integer(&offset)?,
            },
            (None, Some(mapped)) => {
                let list = mapped.as_list()?;
                let mut segments = Vec::new();
                let mut previous_end = 0;
                for index in 0..list.len() {
                    let segment = list.item(index)?;
                    let start = u32::try_from(integer(&segment.field("start")?)?).ok()?;
                    let end = u32::try_from(integer(&segment.field("end")?)?).ok()?;
                    let source_start = integer(&segment.field("sourceStart")?)?;
                    let source_end = integer(&segment.field("sourceEnd")?)?;
                    let kind = match segment.field("kind")?.as_string()?.as_str() {
                        "literal" => crate::TextSourceKind::Literal,
                        "replacement" => crate::TextSourceKind::Replacement,
                        _ => return None,
                    };
                    if start >= end
                        || start < previous_end
                        || source_start > source_end
                        || (kind == crate::TextSourceKind::Replacement
                            && source_start == source_end)
                    {
                        return None;
                    }
                    previous_end = end;
                    segments.push(crate::TextSourceSegment {
                        start,
                        end,
                        source_start,
                        source_end,
                        kind,
                    });
                }
                crate::TextSource::Mapped {
                    id: id.into(),
                    segments,
                }
            }
            _ => return None,
        };
        Some(source)
    }
    // Invalid metadata revokes the previous source identity rather than
    // retaining it on a reused text node. Glyph content is unaffected.
    Some(Prop::TextSource(decode(input).map(Arc::new)))
}

/// `pan`: `{ x, y }` animated values.
pub(crate) fn pan<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    let axis = |key| input.field(key).and_then(|v| v.animated_node());
    Some(Prop::PanValues(axis("x"), axis("y")))
}

/// `pinch`: `{ scale }`.
pub(crate) fn pinch<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::PinchValue(
        input.field("scale").and_then(|v| v.animated_node()),
    ))
}

/// `anchor`: a host element (a ref), `{ x, y }`, `{ origin, size }`, or
/// nothing.
pub(crate) fn overlay_anchor<I: HostInput>(input: &I, _: &mut HostCx) -> Option<OverlayProp> {
    let bounds = || {
        let origin = input.field("origin")?;
        let extent = input.field("size")?;
        Some(Bounds {
            origin: point(points(&origin, "x")?, points(&origin, "y")?),
            size: size(
                points(&extent, "width")?.max(Points::ZERO),
                points(&extent, "height")?.max(Points::ZERO),
            ),
        })
    };
    let anchor = match (input.node(), points(input, "x"), points(input, "y")) {
        (Some(id), ..) => OverlayAnchor::Node(id),
        (None, Some(x), Some(y)) => OverlayAnchor::Point(point(x, y)),
        _ => bounds().map_or(OverlayAnchor::None, OverlayAnchor::Bounds),
    };
    Some(OverlayProp::Anchor(anchor))
}

/// `accessibilityActiveDescendant`: an element (a ref), or nothing.
pub(crate) fn active_descendant<I: HostInput>(
    input: &I,
    _: &mut HostCx,
) -> Option<AccessibilityProp> {
    Some(AccessibilityProp::ActiveDescendant(
        input.node().map(ElementTarget::of_node),
    ))
}

/// `accessibilityControls`: an element (a ref), or nothing.
pub(crate) fn accessibility_controls<I: HostInput>(
    input: &I,
    _: &mut HostCx,
) -> Option<AccessibilityProp> {
    Some(AccessibilityProp::Controls(
        input.node().map(ElementTarget::of_node),
    ))
}

/// `accessibilityDescribedBy`: an element (a ref), or nothing.
pub(crate) fn accessibility_described_by<I: HostInput>(
    input: &I,
    _: &mut HostCx,
) -> Option<AccessibilityProp> {
    Some(AccessibilityProp::DescribedBy(
        input.node().map(ElementTarget::of_node),
    ))
}

/// `tooltip`: a string, an element (a node JS made), or nothing.
pub(crate) fn tooltip<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    let content = input
        .node()
        .map_or(TooltipContent::None, TooltipContent::Node);
    Some(Prop::Tooltip(content))
}

/// `rotation`: `{ angle }`.
pub(crate) fn rotation<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::RotationValue(
        input.field("angle").and_then(|v| v.animated_node()),
    ))
}

/// `scrollValue`: an animated value.
pub(crate) fn scroll_value<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::ScrollValue(input.animated_node()))
}

/// `pullValue`: an animated value.
pub(crate) fn pull_value<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::PullValue(input.animated_node()))
}

/// `stickyHeaderOffset`: a number, or an animated value.
pub(crate) fn sticky_offset<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    match input.as_number() {
        Some(n) => Some(Prop::StickyOffset(Points(n as f32))),
        None => input
            .animated_node()
            .map(|node| Prop::StickyOffsetNode(Some(node))),
    }
}

/// `hitSlop`: one number for every edge, or the edges.
pub(crate) fn hit_slop<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Prop> {
    Some(Prop::HitSlop(match input.as_number() {
        Some(n) => EdgeInsets::all(Points(n as f32)),
        None => EdgeInsets::decode(input, cx).unwrap_or_default(),
    }))
}

/// `classList`: the names whose value is truthy.
pub(crate) fn class_list<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::ClassList(
        input
            .entries()
            .into_iter()
            .filter(|(_, on)| on.truthy())
            .map(|(name, _)| name.into())
            .collect(),
    ))
}

/// `tailwindTheme`: JSON; nothing without it.
pub(crate) fn tailwind_theme<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::TailwindTheme(input.as_string()?.into()))
}

/// `uiTheme`: JSON; nothing without it.
pub(crate) fn ui_theme<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::UiTheme(input.as_string()?.into()))
}

/// `role`: one of the role names; others are no role (and a
/// warning).
pub(crate) fn role<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<AccessibilityProp> {
    let role = AccessibilityRole::decode(input, cx);
    if role.is_none()
        && let Some(name) = input.as_string().filter(|n| !n.is_empty())
    {
        cx.warn(format!("unknown role `{name}`"));
    }
    Some(AccessibilityProp::Role(role.unwrap_or_default()))
}

/// `accessibilityLevel`: a whole number from 1; anything else is none.
pub(crate) fn accessibility_level<I: HostInput>(
    input: &I,
    _: &mut HostCx,
) -> Option<AccessibilityProp> {
    let level = input
        .as_number()
        .filter(|n| *n >= 1.0 && n.fract() == 0.0 && *n <= f64::from(u32::MAX))
        .map(|n| n as u32);
    Some(AccessibilityProp::Level(level))
}

/// `importantForAccessibility`.
pub(crate) fn important<I: HostInput>(input: &I, _: &mut HostCx) -> Option<AccessibilityProp> {
    Some(match input.as_string().as_deref() {
        Some("yes") => AccessibilityProp::Important(Some(true), false),
        Some("no") => AccessibilityProp::Important(Some(false), false),
        Some("no-hide-descendants") => AccessibilityProp::Important(Some(false), true),
        _ => AccessibilityProp::Important(None, false),
    })
}

/// `decelerationRate`: `"fast"`, `"normal"` (React Native's iOS rates:
/// velocity kept per millisecond) or the rate.
pub(crate) fn deceleration<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ScrollProp> {
    Some(ScrollProp::Deceleration(match input.as_string() {
        Some(s) => match s.as_str() {
            "fast" => 0.99,
            "normal" => 0.998,
            _ => 0.0,
        },
        None => input.as_number().unwrap_or(0.0) as f32,
    }))
}

/// `maintainVisibleContentPosition`: `{ autoscrollToBottomThreshold, animated }`.
pub(crate) fn visible_content<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::FollowEnd(
        points(input, "autoscrollToBottomThreshold").map(|t| t.max(Points::ZERO)),
        input
            .field("animated")
            .and_then(|a| a.as_bool())
            .unwrap_or(false),
    ))
}

/// `refreshIndicator`: `{ height }`.
pub(crate) fn refresh_indicator<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ScrollProp> {
    Some(ScrollProp::RefreshIndicator(
        points(input, "height").map(|h| h.max(Points::ZERO)),
    ))
}

/// `contentOffset`: `{ x, y }`.
pub(crate) fn content_offset<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ScrollProp> {
    let n = |key| points(input, key).unwrap_or_default();
    Some(ScrollProp::ContentOffset(point(n("x"), n("y"))))
}

/// `scrollbar`: a boolean, or the object of a theme (kept as JSON for the
/// set that draws the built-in bar).
pub(crate) fn scrollbar<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::Scrollbar(match input.as_bool() {
        Some(shows) => shows.into(),
        None if input.is_object() => {
            crate::ScrollbarSetting::Themed(std::sync::Arc::new(json_of(input, 0, &mut {
                JSON_ENTRIES
            })))
        }
        None => crate::ScrollbarSetting::Shown,
    }))
}

/// Deepest nesting [`json_of`] reads.
const JSON_DEPTH: u32 = 64;
/// Most array items and object fields [`json_of`] reads in all.
const JSON_ENTRIES: usize = 1 << 20;

/// `input` as JSON: what is neither a boolean, number, string, array nor
/// object (a function) is `null`, and so is what is nested more than
/// [`JSON_DEPTH`] deep or past `left` entries (of [`JSON_ENTRIES`]): the
/// app's value is read natively, where neither the time budget nor the
/// interpreter's stack limit applies, and one that holds itself would
/// recurse until the engine thread's stack overflows.
fn json_of<I: HostInput>(input: &I, depth: u32, left: &mut usize) -> crate::JsonValue {
    use crate::JsonValue;
    if let Some(b) = input.as_bool() {
        return JsonValue::Bool(b);
    }
    if let Some(n) = input.as_number() {
        return serde_json::Number::from_f64(n).map_or(JsonValue::Null, JsonValue::Number);
    }
    if let Some(s) = input.as_string() {
        return JsonValue::String(s);
    }
    if depth >= JSON_DEPTH {
        return JsonValue::Null;
    }
    if let Some(list) = input.as_list() {
        let mut items = Vec::new();
        for i in 0..list.len() {
            if *left == 0 {
                break;
            }
            *left -= 1;
            if let Some(item) = list.item(i) {
                items.push(json_of(&item, depth + 1, left));
            }
        }
        return JsonValue::Array(items);
    }
    if input.is_object() {
        let mut fields = serde_json::Map::new();
        for (key, value) in input.entries() {
            if *left == 0 {
                break;
            }
            *left -= 1;
            fields.insert(key, json_of(&value, depth + 1, left));
        }
        return JsonValue::Object(fields);
    }
    JsonValue::Null
}

/// `keyboardShouldPersistTaps`: a boolean or `"never"` / `"always"` /
/// `"handled"`.
pub(crate) fn keyboard_taps<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ScrollProp> {
    Some(ScrollProp::KeyboardTaps(match input.as_bool() {
        Some(true) => KeyboardTaps::Always,
        Some(false) => KeyboardTaps::Never,
        None => match input.as_string().as_deref() {
            Some("always") => KeyboardTaps::Always,
            Some("handled") => KeyboardTaps::Handled,
            _ => KeyboardTaps::Never,
        },
    }))
}

/// A dialog's `supportedOrientations`: the orientation names.
pub(crate) fn orientations<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ModalProp> {
    Some(ModalProp::Orientations(orientation_bits(input)))
}

/// A page's `supportedOrientations`: the orientation names.
pub(crate) fn page_orientations<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ScreenProp> {
    Some(ScreenProp::Orientations(orientation_bits(input)))
}

/// The [`ModalConfig::PORTRAIT`] bits of a list of orientation names; a
/// name it does not know adds none.
fn orientation_bits<I: HostInput>(input: &I) -> u8 {
    let mut bits = 0;
    for name in input.items() {
        bits |= match name.as_string().as_deref() {
            Some("portrait") => ModalConfig::PORTRAIT,
            Some("portrait-upside-down") => ModalConfig::PORTRAIT_UPSIDE_DOWN,
            Some("landscape") => ModalConfig::LANDSCAPE_LEFT | ModalConfig::LANDSCAPE_RIGHT,
            Some("landscape-left") => ModalConfig::LANDSCAPE_LEFT,
            Some("landscape-right") => ModalConfig::LANDSCAPE_RIGHT,
            _ => 0,
        };
    }
    bits
}

/// A shader's `uniforms`: `{ name: value }`, a value a number, a CSS color,
/// an animated value or a list of them; what is none of them is left out
/// with a warning.
impl HostValue for crate::shader::ShaderUniforms {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        let mut values = Vec::new();
        for (name, value) in input.entries() {
            match uniform_value(&value, 0) {
                Some(v) => values.push((name.as_str().into(), v)),
                None => cx.warn(format!(
                    "uniform `{name}`: a number, a color, an animated value or a list of them"
                )),
            }
        }
        Some(crate::shader::ShaderUniforms(values))
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let value = types.declare("ShaderUniform", |_| {
            "/** A value of a shader's uniform: a number (`f32`, `i32`, `u32`), a color\n \
             * (`vec3f` / `vec4f`, sRGB 0..1), an animated value, or a list of them (a\n \
             * vector's components, an `array<vec4f, N>`'s items). */\n\
             export type ShaderUniform = number | ColorValue | AnimatedNode | readonly ShaderUniform[];"
                .into()
        });
        format!("Record<string, {value}>")
    }
}

/// A page's or a dialog's `transitionShader`: `{ source, uniforms?,
/// duration? }`.
impl HostValue for crate::shader::NavShaderSpec {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        let mut source = None;
        let mut uniforms = crate::shader::ShaderUniforms::default();
        let mut duration = None;
        for (name, value) in input.entries() {
            match name.as_str() {
                "source" => source = value.as_string(),
                "uniforms" => {
                    uniforms = crate::shader::ShaderUniforms::decode(&value, cx).unwrap_or_default()
                }
                "duration" => duration = value.as_number().map(|d| d as f32),
                _ => {}
            }
        }
        Some(crate::shader::NavShaderSpec {
            source: source?.as_str().into(),
            uniforms,
            duration,
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let uniforms = crate::shader::ShaderUniforms::ts_type(types);
        format!("{{ source: string; uniforms?: {uniforms}; duration?: number }}")
    }
}

/// An effect's `progress`: a number or an animated value.
impl HostValue for crate::shader::ShaderProgress {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        if let Some(n) = input.as_number() {
            return Some(crate::shader::ShaderProgress::Number(
                crate::geometry::Percentage(n as f32),
            ));
        }
        input
            .animated_node()
            .map(crate::shader::ShaderProgress::Animated)
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "number | AnimatedNode".into()
    }
}

/// A transition's `value`: a string, a number or a boolean.
impl HostValue for crate::shader::TransitionKey {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        if let Some(b) = input.as_bool() {
            return Some(crate::shader::TransitionKey::Bool(b));
        }
        if let Some(n) = input.as_number() {
            return Some(crate::shader::TransitionKey::number(n));
        }
        input
            .as_string()
            .map(|s| crate::shader::TransitionKey::String(s.as_str().into()))
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "string | number | boolean".into()
    }
}

fn uniform_value<I: HostInput>(input: &I, depth: u32) -> Option<crate::shader::UniformValue> {
    use crate::shader::UniformValue;
    if let Some(n) = input.as_number() {
        return Some(UniformValue::Number(n as f32));
    }
    if let Some(s) = input.as_string() {
        return crate::Color::parse(&s).map(UniformValue::Color);
    }
    if let Some(node) = input.animated_node() {
        return Some(UniformValue::Animated(node));
    }
    let list = input.as_list()?;
    // Vectors in arrays: two levels.
    if depth > 1 {
        return None;
    }
    (0..list.len())
        .map(|i| {
            list.item(i)
                .and_then(|item| uniform_value(&item, depth + 1))
        })
        .collect::<Option<Vec<_>>>()
        .map(UniformValue::List)
}

#[cfg(test)]
mod content_style_tests {
    use serde_json::json;

    use super::*;
    use crate::element::json_host::JsonHost;

    #[test]
    fn component_content_style_uses_list_shorthands_and_rejects_non_numeric_lengths() {
        let host = JsonHost::default();
        let input = host.value(json!({
            "padding": 4, "paddingHorizontal": 6, "paddingTop": 9,
            "gap": 12, "rowGap": 16,
        }));
        let content = ListContentStyle::from_js(JsIn::new(&host, input)).unwrap();
        assert_eq!(
            host.read(content.to_js(&host).unwrap()),
            Some(json!({
                "paddingTop": 9, "paddingRight": 6,
                "paddingBottom": 4, "paddingLeft": 6,
                "rowGap": 16, "columnGap": 12,
            }))
        );
        let invalid = host.value(json!({ "rowGap": "10%" }));
        assert!(
            ListContentStyle::from_js(JsIn::new(&host, invalid))
                .unwrap_err()
                .to_string()
                .contains("rowGap")
        );
        let empty = host.value(json!({}));
        assert_eq!(
            ListContentStyle::from_js(JsIn::new(&host, empty)).unwrap(),
            ListContentStyle::default()
        );
    }
}
