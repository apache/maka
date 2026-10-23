//! The host prop values that are objects or unions (sources, accessibility
//! descriptions, list layouts) and the props whose whole variant is
//! decoded by hand (`#[prop(with = …)]`): the shapes JS sends them in.

use std::sync::Arc;

use super::host::{HostCx, HostInput, HostList, HostValue, field};
use crate::{
    AccessibilityProp, AccessibilityRole, AccessibilityState, AutoFill, CellSlot, EdgeInsets,
    ImageScales, ImageSource, KeyboardTaps, ListContentStyle, ModalProp, Prop, ScrollProp,
    StatusBarSetting, StatusBarStyle, Viewability,
    geometry::{Bounds, Points, point, size},
    mount::ModalConfig,
    ops::OverlayProp,
    overlay::{OverlayAnchor, TooltipContent},
    props::{AccessibilityActionDef, AccessibilityValue, Checked, PanActivation, Ripple},
    ui::{JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, TsTypes},
};

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

/// A list's `contentStyle`: the padding properties (numbers) and
/// `gap` / `rowGap` / `columnGap`.
impl HostValue for ListContentStyle {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        list_content(|key| Ok::<_, std::convert::Infallible>(points(input, key))).ok()
    }

    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("ListContentStyle", |_| {
            "/** Padding and gaps of a list's content (`contentStyle`). */\n\
             export interface ListContentStyle {\n  padding?: number;\n  paddingHorizontal?: number;\n  \
             paddingVertical?: number;\n  paddingTop?: number;\n  paddingRight?: number;\n  \
             paddingBottom?: number;\n  paddingLeft?: number;\n  gap?: number;\n  rowGap?: number;\n  \
             columnGap?: number;\n}"
                .into()
        })
    }
}

/// Resolve the list's existing shorthand/axis/side precedence at either
/// native JS boundary. Both decoders use this one content layout shape.
fn list_content<E>(n: impl Fn(&str) -> Result<Option<Points>, E>) -> Result<ListContentStyle, E> {
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
        list_content(|key| {
            let field = value.field(key)?;
            Option::<Points>::from_js(field.get())
                .map_err(|error| PropError(format!("`{key}`: {error}")))
        })
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
        Ok(object)
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
            view_area_percent: number(input, "viewAreaCoveragePercentThreshold"),
            item_visible_percent: number(input, "itemVisiblePercentThreshold"),
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "ViewabilityConfig".into()
    }
}

/// `{ activeOffsetX, activeOffsetY, failOffsetX, failOffsetY }` (points;
/// the sign is ignored).
impl HostValue for PanActivation {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        if !input.is_object() {
            return None;
        }
        let offset = |key| points(input, key).map(Points::abs);
        Some(PanActivation {
            active_offset_x: offset("activeOffsetX"),
            active_offset_y: offset("activeOffsetY"),
            fail_offset_x: offset("failOffsetX"),
            fail_offset_y: offset("failOffsetY"),
        })
    }

    fn ts_type(_: &mut TsTypes) -> String {
        "PanActivation".into()
    }
}

/// `{ disabled, selected, checked: true | false | "mixed", busy, expanded }`.
impl HostValue for AccessibilityState {
    fn decode<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Self> {
        let flag = |key| input.field(key).and_then(|v| v.as_bool()).unwrap_or(false);
        let checked = input.field("checked");
        Some(AccessibilityState {
            disabled: flag("disabled"),
            selected: flag("selected"),
            checked: match checked.as_ref().and_then(|c| c.as_bool()) {
                Some(true) => Some(Checked::True),
                Some(false) => Some(Checked::False),
                None => checked
                    .and_then(|c| c.as_string())
                    .filter(|s| s == "mixed")
                    .map(|_| Checked::Mixed),
            },
            busy: flag("busy"),
            expanded: input.field("expanded").and_then(|v| v.as_bool()),
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("AccessibilityState", |_| {
            "/** The state assistive technologies report (`accessibilityState`). */\n\
             export interface AccessibilityState {\n  disabled?: boolean;\n  selected?: boolean;\n  \
             checked?: boolean | \"mixed\";\n  busy?: boolean;\n  expanded?: boolean;\n}"
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

// --- Whole variants ---------------------------------------------------------

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

/// `hintDelay`: milliseconds before a native hint is shown.
pub(crate) fn hint_delay<I: HostInput>(input: &I, _: &mut HostCx) -> Option<OverlayProp> {
    let millis = input.as_number().filter(|n| n.is_finite())?;
    let delay = std::time::Duration::try_from_secs_f64(millis.max(0.0) / 1000.0).ok()?;
    Some(OverlayProp::Hint(Some(delay)))
}

/// `tooltip`: a string, an element (a node JS made), or nothing.
pub(crate) fn tooltip<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    let content = match (input.node(), input.as_string()) {
        (Some(id), _) => TooltipContent::Node(id),
        (None, Some(text)) if !text.is_empty() => TooltipContent::Text(text.into()),
        _ => TooltipContent::None,
    };
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

/// `maintainVisibleContentPosition`: `{ autoscrollToBottomThreshold }`.
pub(crate) fn visible_content<I: HostInput>(input: &I, _: &mut HostCx) -> Option<Prop> {
    Some(Prop::FollowEnd(
        points(input, "autoscrollToBottomThreshold").map(|t| t.max(Points::ZERO)),
    ))
}

/// `contentOffset`: `{ x, y }`.
pub(crate) fn content_offset<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ScrollProp> {
    let n = |key| points(input, key).unwrap_or_default();
    Some(ScrollProp::ContentOffset(point(n("x"), n("y"))))
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

/// `supportedOrientations`: the orientation names.
pub(crate) fn orientations<I: HostInput>(input: &I, _: &mut HostCx) -> Option<ModalProp> {
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
    Some(ModalProp::Orientations(bits))
}

#[cfg(test)]
mod content_style_tests {
    use super::*;
    use crate::ui::json_host::JsonHost;
    use serde_json::json;

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
                "paddingTop": 9.0, "paddingRight": 6.0,
                "paddingBottom": 4.0, "paddingLeft": 6.0,
                "rowGap": 16.0, "columnGap": 12.0,
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
