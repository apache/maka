//! `Intl` (ECMA-402) for what apps format most: `Intl.NumberFormat`
//! (decimal, percent, currency and unit styles; fraction and significant
//! digits; grouping; sign display; standard, scientific, engineering and
//! compact notation) and `Intl.DateTimeFormat` (the date and time fields,
//! `dateStyle` / `timeStyle`, 12- and 24-hour cycles; local time, UTC or a
//! fixed offset), with `format`, `formatToParts` and `resolvedOptions`;
//! and the locale-aware `toLocaleString` of numbers, BigInts and dates.
//! QuickJS has no `Intl`; this one formats natively, in Rust.
//!
//! The language data (`locale.rs`) is not CLDR: ICU4X's data for numbers
//! and dates in every locale would add megabytes to every app, a language
//! here is a JSON file of a few kilobytes. English is built in; the others
//! are the languages the app ships (nsh.json `locales`, the files of
//! `nsh-i18n`'s `data/`), which the bundle registers before the app runs
//! (`nsh:rt`'s `i18n`, [`add_languages`]). A locale without data resolves
//! to the next requested one, then the device's (`Environment::locale`),
//! then `en-US`. Local time is
//! `Date`'s, and is named as the zone it is computed in: as the C library
//! computing it reads that zone (`TZ`, `/etc/localtime`; the browser's on
//! the web), or where that is out of its sight (Windows, Android) as the
//! platform reports it (`LocaleSettings::time_zone`, `localeSettings()`'s
//! `timeZone`), so on a device `localeSettings()` names it too.
//! `resolvedOptions().timeZone` gives the name and a `timeZone` naming it
//! is local time; a `TZ` holding a POSIX rule
//! (`CET-1CEST,M3.5.0,M10.5.0/3`) is named by its text, so its daylight
//! saving time stays. A test's zone
//! (`open({ localeSettings: { timeZone } })`) names the device's zone
//! without moving local time, so `Intl` keeps naming the machine's. TypeScript declares all of
//! it in its ECMAScript library (`lib.es2023`), so `globals.d.ts` does not.
//!
//! Not there: `Collator`, `PluralRules`, `RelativeTimeFormat`,
//! `ListFormat`, `DisplayNames`, `Segmenter`, `Intl.Locale`; time zones
//! other than the device's, UTC and fixed offsets (no zone database);
//! calendars other than the Gregorian, non-Latin digits, `currencySign:
//! "accounting"` (written as `standard`) and currency names (written as
//! codes). The constructors need `new`.

mod date;
mod locale;
mod number;

use std::ffi::c_int;

pub(crate) use locale::Languages;
use locale::Locale;
#[cfg(not(target_arch = "wasm32"))]
use nsh_core::platform::TimeZone;
use rquickjs::qjs;

use super::{
    Class, Key, Object, Spec, data, instance,
    js::{self, Ctx, R, Raw, V, native, trace},
};

/// A piece of a formatted value (`formatToParts`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Part {
    pub(crate) kind: &'static str,
    pub(crate) value: String,
}

fn join(parts: &[Part]) -> String {
    parts.iter().map(|p| p.value.as_str()).collect()
}

fn parts_array(cx: Ctx, parts: &[Part]) -> R<V> {
    let mut items = Vec::with_capacity(parts.len());
    for part in parts {
        let o = js::new_object(cx)?;
        js::define(cx, o.raw(), "type", js::string(cx, part.kind)?, true)?;
        js::define(cx, o.raw(), "value", js::string(cx, &part.value)?, true)?;
        items.push(o);
    }
    js::new_array(cx, items)
}

// --- Arguments ------------------------------------------------------------

/// The requested locales: `undefined`, a tag or a list of them.
fn requested(cx: Ctx, locales: Raw) -> R<Vec<String>> {
    if js::is_undefined(locales) {
        return Ok(Vec::new());
    }
    let tags = if !js::is_object(locales) {
        vec![js::to_string(cx, locales)?]
    } else {
        let length = js::to_number(cx, js::get(cx, locales, "length")?.raw())?;
        let mut tags = Vec::new();
        for i in 0..(length.max(0.0) as usize).min(64) {
            let item = js::get(cx, locales, &i.to_string())?;
            tags.push(js::to_string(cx, item.raw())?);
        }
        tags
    };
    let mut out = Vec::with_capacity(tags.len());
    for tag in tags {
        match nsh_core::platform::Locale::parse(&tag) {
            Some(t) if !out.iter().any(|o: &String| o == t.as_str()) => {
                out.push(t.as_str().to_owned())
            }
            Some(_) => {}
            None => {
                return Err(js::range_error(
                    cx,
                    &format!("Incorrect locale information provided: {tag}"),
                ));
            }
        }
    }
    Ok(out)
}

fn resolve(cx: Ctx, locales: Raw) -> R<Locale> {
    let requested = requested(cx, locales)?;
    let default = crate::env::locale(cx);
    Ok(super::web(cx)
        .languages
        .resolve(&requested, default.as_str()))
}

/// Registers the language data the app ships, by language (`"de"`).
pub(crate) fn add_languages(cx: Ctx, languages: serde_json::Map<String, serde_json::Value>) {
    super::web(cx).languages.add(languages);
}

/// The options object (`undefined`: none).
fn options(cx: Ctx, options: Raw) -> R<Option<V>> {
    if js::is_undefined(options) {
        return Ok(None);
    }
    if !js::is_object(options) {
        if js::is_nullish(options) {
            return Err(js::type_error(cx, "options must be an object"));
        }
        return Ok(None);
    }
    Ok(Some(V::dup(cx, options)))
}

fn get(cx: Ctx, options: &Option<V>, key: &str) -> R<V> {
    match options {
        Some(o) => js::get(cx, o.raw(), key),
        None => Ok(V::undefined()),
    }
}

/// A string option, one of `allowed`.
fn string_option(
    cx: Ctx,
    o: &Option<V>,
    key: &str,
    allowed: &[&'static str],
) -> R<Option<&'static str>> {
    let v = get(cx, o, key)?;
    if v.is_undefined() {
        return Ok(None);
    }
    let s = js::to_string(cx, v.raw())?;
    allowed
        .iter()
        .find(|a| **a == s)
        .copied()
        .map(Some)
        .ok_or_else(|| js::range_error(cx, &format!("Value {s} out of range for option {key}")))
}

fn number_option(cx: Ctx, o: &Option<V>, key: &str, min: u8, max: u8) -> R<Option<u8>> {
    let v = get(cx, o, key)?;
    if v.is_undefined() {
        return Ok(None);
    }
    let n = js::to_number(cx, v.raw())?;
    if n.is_nan() || n < f64::from(min) || n > f64::from(max) {
        return Err(js::range_error(
            cx,
            &format!("{key} value is out of range."),
        ));
    }
    Ok(Some(n.floor() as u8))
}

fn bool_option(cx: Ctx, o: &Option<V>, key: &str) -> R<Option<bool>> {
    let v = get(cx, o, key)?;
    Ok((!v.is_undefined()).then(|| js::to_bool(cx, v.raw())))
}

// --- NumberFormat -----------------------------------------------------------

fn number_format(cx: Ctx, options: Raw) -> R<number::Format> {
    use number::{
        CurrencyDisplay, Format, Grouping, Notation, Rounding, SignDisplay, Style, UnitDisplay,
    };
    let o = self::options(cx, options)?;
    let style = string_option(cx, &o, "style", &["decimal", "percent", "currency", "unit"])?;
    let currency = get(cx, &o, "currency")?;
    let currency = if currency.is_undefined() {
        None
    } else {
        let code = js::to_string(cx, currency.raw())?;
        if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_alphabetic()) {
            return Err(js::range_error(
                cx,
                &format!("Invalid currency code : {code}"),
            ));
        }
        Some(code.to_ascii_uppercase())
    };
    let currency_display = string_option(
        cx,
        &o,
        "currencyDisplay",
        &["code", "symbol", "narrowSymbol", "name"],
    )?;
    string_option(cx, &o, "currencySign", &["standard", "accounting"])?;
    let unit = get(cx, &o, "unit")?;
    let unit = if unit.is_undefined() {
        None
    } else {
        let unit = js::to_string(cx, unit.raw())?;
        if !number::known_unit(&unit) {
            return Err(js::range_error(
                cx,
                &format!("Invalid unit argument for Intl.NumberFormat() '{unit}'"),
            ));
        }
        Some(unit)
    };
    let unit_display = string_option(cx, &o, "unitDisplay", &["short", "narrow", "long"])?;
    let style = match style.unwrap_or("decimal") {
        "percent" => Style::Percent,
        "currency" => Style::Currency {
            code: currency.ok_or_else(|| {
                js::type_error(cx, "Currency code is required with currency style.")
            })?,
            display: match currency_display {
                Some("code") => CurrencyDisplay::Code,
                Some("narrowSymbol") => CurrencyDisplay::NarrowSymbol,
                Some("name") => CurrencyDisplay::Name,
                _ => CurrencyDisplay::Symbol,
            },
        },
        "unit" => Style::Unit {
            unit: unit.ok_or_else(|| js::type_error(cx, "Unit is required with unit style."))?,
            display: match unit_display {
                Some("narrow") => UnitDisplay::Narrow,
                Some("long") => UnitDisplay::Long,
                _ => UnitDisplay::Short,
            },
        },
        _ => Style::Decimal,
    };
    let notation = string_option(
        cx,
        &o,
        "notation",
        &["standard", "scientific", "engineering", "compact"],
    )?;
    // Read in the order of the specification (getters observe it).
    let min_integer = number_option(cx, &o, "minimumIntegerDigits", 1, 21)?.unwrap_or(1);
    let mnfd = number_option(cx, &o, "minimumFractionDigits", 0, 100)?;
    let mxfd = number_option(cx, &o, "maximumFractionDigits", 0, 100)?;
    let mnsd = number_option(cx, &o, "minimumSignificantDigits", 1, 21)?;
    let mxsd = number_option(cx, &o, "maximumSignificantDigits", 1, 21)?;
    let priority = string_option(
        cx,
        &o,
        "roundingPriority",
        &["auto", "morePrecision", "lessPrecision"],
    )?
    .unwrap_or("auto");
    let trailing = string_option(cx, &o, "trailingZeroDisplay", &["auto", "stripIfInteger"])?;
    let compact_display = string_option(cx, &o, "compactDisplay", &["short", "long"])?;
    let notation = match notation.unwrap_or("standard") {
        "scientific" => Notation::Scientific,
        "engineering" => Notation::Engineering,
        "compact" => Notation::Compact {
            long: compact_display == Some("long"),
        },
        _ => Notation::Standard,
    };
    let compact = matches!(notation, Notation::Compact { .. });
    let (fraction_min, fraction_max) = match &style {
        Style::Currency { code, .. } if !compact => {
            let digits = number::currency_digits(code);
            (digits, digits)
        }
        Style::Percent => (0, 0),
        _ if compact => (0, 0),
        _ => (0, 3),
    };
    let has_sd = mnsd.is_some() || mxsd.is_some();
    let has_fd = mnfd.is_some() || mxfd.is_some();
    let need_sd = priority != "auto" || has_sd;
    let need_fd = priority != "auto" || !(has_sd || (!has_fd && compact));
    let (min_sig, max_sig) = (mnsd.unwrap_or(1), mxsd.unwrap_or(21));
    if need_sd && min_sig > max_sig {
        return Err(js::range_error(
            cx,
            "maximumSignificantDigits value is out of range.",
        ));
    }
    let (min_frac, max_frac) = match (mnfd, mxfd) {
        _ if !has_fd => (fraction_min, fraction_max),
        (Some(min), Some(max)) if min > max => {
            return Err(js::range_error(
                cx,
                "maximumFractionDigits value is out of range.",
            ));
        }
        (Some(min), Some(max)) => (min, max),
        (Some(min), None) => (min, fraction_max.max(min)),
        (None, Some(max)) => (fraction_min.min(max), max),
        (None, None) => (fraction_min, fraction_max),
    };
    let rounding = match (need_sd, need_fd) {
        (true, false) => Rounding::Significant {
            min: min_sig,
            max: max_sig,
        },
        (false, true) => Rounding::Fraction {
            min: min_frac,
            max: max_frac,
        },
        // Compact's default: two significant digits for small numbers.
        (false, false) => Rounding::Both {
            min_fraction: 0,
            max_fraction: 0,
            min_significant: 1,
            max_significant: 2,
            more: true,
        },
        (true, true) => Rounding::Both {
            min_fraction: min_frac,
            max_fraction: max_frac,
            min_significant: min_sig,
            max_significant: max_sig,
            more: priority != "lessPrecision",
        },
    };
    let grouping = get(cx, &o, "useGrouping")?;
    let grouping = if grouping.is_undefined() {
        if compact {
            Grouping::Min2
        } else {
            Grouping::Auto
        }
    // SAFETY: an inline tag read.
    } else if unsafe { qjs::JS_VALUE_GET_TAG(grouping.raw()) } == qjs::JS_TAG_BOOL {
        if js::to_bool(cx, grouping.raw()) {
            Grouping::Always
        } else {
            Grouping::Off
        }
    } else {
        match js::to_string(cx, grouping.raw())?.as_str() {
            "always" => Grouping::Always,
            "min2" => Grouping::Min2,
            "auto" | "true" | "false" => Grouping::Auto,
            "" => Grouping::Off,
            other => {
                return Err(js::range_error(
                    cx,
                    &format!("Value {other} out of range for option useGrouping"),
                ));
            }
        }
    };
    let sign = match string_option(
        cx,
        &o,
        "signDisplay",
        &["auto", "never", "always", "exceptZero", "negative"],
    )? {
        Some("never") => SignDisplay::Never,
        Some("always") => SignDisplay::Always,
        Some("exceptZero") => SignDisplay::ExceptZero,
        Some("negative") => SignDisplay::Negative,
        _ => SignDisplay::Auto,
    };
    Ok(Format {
        style,
        notation,
        sign,
        grouping,
        min_integer,
        rounding,
        strip_if_integer: trailing == Some("stripIfInteger"),
    })
}

/// The number `v` stands for: a BigInt or a decimal string exactly, else
/// `ToNumber`.
fn number_value(cx: Ctx, v: Raw) -> R<number::Value> {
    // SAFETY: an inline tag read.
    let tag = unsafe { qjs::JS_VALUE_GET_TAG(v) };
    if tag == qjs::JS_TAG_BIG_INT || tag == qjs::JS_TAG_SHORT_BIG_INT || tag == qjs::JS_TAG_STRING {
        let text = js::to_string(cx, v)?;
        return Ok(number::Value::parse(&text).unwrap_or(number::Value::Nan));
    }
    Ok(number::Value::from_f64(js::to_number(cx, v)?))
}

struct NumberFormat {
    locale: Locale,
    format: number::Format,
    /// `format`, bound to the object (made on first read).
    bound: Option<V>,
}

trace!(NumberFormat { bound });

impl Object for NumberFormat {}

fn format_number(cx: Ctx, this: Raw, value: Raw) -> R<Vec<Part>> {
    let (locale, format) = {
        let nf = data::<NumberFormat>(cx, this, "NumberFormat")?;
        (nf.locale.clone(), nf.format.clone())
    };
    let value = number_value(cx, value)?;
    Ok(number::format(
        &value,
        &format,
        &locale.numbers,
        locale.tag.as_str(),
    ))
}

native!(
    fn number_format_constructor(cx, this, args) {
        let locale = resolve(cx, args.get(0))?;
        let format = number_format(cx, args.get(1))?;
        instance(cx, this, Class::NumberFormat, NumberFormat { locale, format, bound: None })
    }
);

native!(
    fn number_format_format(cx, this, args) {
        if let Some(bound) = &data::<NumberFormat>(cx, this, "NumberFormat")?.bound {
            return Ok(bound.clone_ref());
        }
        let f = js::closure(cx, vec![V::dup(cx, this)], |cx, captures, args| {
            let parts = format_number(cx, captures[0].raw(), args.get(0))?;
            js::string(cx, &join(&parts))
        })?;
        data::<NumberFormat>(cx, this, "NumberFormat")?.bound = Some(f.clone_ref());
        Ok(f)
    }
);

native!(
    fn number_format_to_parts(cx, this, args) {
        let parts = format_number(cx, this, args.get(0))?;
        parts_array(cx, &parts)
    }
);

native!(
    fn number_format_resolved_options(cx, this, args) {
        use number::{CurrencyDisplay, Grouping, Notation, Rounding, SignDisplay, Style, UnitDisplay};
        let (locale, f) = {
            let nf = data::<NumberFormat>(cx, this, "NumberFormat")?;
            (nf.locale.clone(), nf.format.clone())
        };
        let o = js::new_object(cx)?;
        let set = |key: &str, value: V| js::define(cx, o.raw(), key, value, true);
        let text = |s: &str| js::string(cx, s);
        set("locale", text(locale.tag.as_str())?)?;
        set("numberingSystem", text("latn")?)?;
        match &f.style {
            Style::Decimal => set("style", text("decimal")?)?,
            Style::Percent => set("style", text("percent")?)?,
            Style::Currency { code, display } => {
                set("style", text("currency")?)?;
                set("currency", text(code)?)?;
                set("currencyDisplay", text(match display {
                    CurrencyDisplay::Symbol => "symbol",
                    CurrencyDisplay::NarrowSymbol => "narrowSymbol",
                    CurrencyDisplay::Code => "code",
                    CurrencyDisplay::Name => "name",
                })?)?;
                set("currencySign", text("standard")?)?;
            }
            Style::Unit { unit, display } => {
                set("style", text("unit")?)?;
                set("unit", text(unit)?)?;
                set("unitDisplay", text(match display {
                    UnitDisplay::Short => "short",
                    UnitDisplay::Narrow => "narrow",
                    UnitDisplay::Long => "long",
                })?)?;
            }
        }
        set("minimumIntegerDigits", V::num(f64::from(f.min_integer)))?;
        let (fraction, significant, priority) = match f.rounding {
            Rounding::Fraction { min, max } => (Some((min, max)), None, "auto"),
            Rounding::Significant { min, max } => (None, Some((min, max)), "auto"),
            Rounding::Both { min_fraction, max_fraction, min_significant, max_significant, more } => (
                Some((min_fraction, max_fraction)),
                Some((min_significant, max_significant)),
                if more { "morePrecision" } else { "lessPrecision" },
            ),
        };
        if let Some((min, max)) = fraction {
            set("minimumFractionDigits", V::num(f64::from(min)))?;
            set("maximumFractionDigits", V::num(f64::from(max)))?;
        }
        if let Some((min, max)) = significant {
            set("minimumSignificantDigits", V::num(f64::from(min)))?;
            set("maximumSignificantDigits", V::num(f64::from(max)))?;
        }
        set("useGrouping", match f.grouping {
            Grouping::Off => V::bool(false),
            Grouping::Always => text("always")?,
            Grouping::Auto => text("auto")?,
            Grouping::Min2 => text("min2")?,
        })?;
        let (notation, compact) = match f.notation {
            Notation::Standard => ("standard", None),
            Notation::Scientific => ("scientific", None),
            Notation::Engineering => ("engineering", None),
            Notation::Compact { long } => ("compact", Some(if long { "long" } else { "short" })),
        };
        set("notation", text(notation)?)?;
        if let Some(display) = compact {
            set("compactDisplay", text(display)?)?;
        }
        set("signDisplay", text(match f.sign {
            SignDisplay::Auto => "auto",
            SignDisplay::Never => "never",
            SignDisplay::Always => "always",
            SignDisplay::ExceptZero => "exceptZero",
            SignDisplay::Negative => "negative",
        })?)?;
        set("roundingIncrement", V::num(1.0))?;
        set("roundingMode", text("halfExpand")?)?;
        set("roundingPriority", text(priority)?)?;
        set("trailingZeroDisplay", text(if f.strip_if_integer { "stripIfInteger" } else { "auto" })?)?;
        Ok(o)
    }
);

native!(
    /// `supportedLocalesOf` of both classes: the requested tags with data.
    fn supported_locales_of(cx, this, args) {
        let tags = requested(cx, args.get(0))?;
        let mut items = Vec::new();
        let tags: Vec<String> = {
            let languages = &super::web(cx).languages;
            tags.into_iter().filter(|t| languages.supported(t)).collect()
        };
        for tag in &tags {
            items.push(js::string(cx, tag)?);
        }
        js::new_array(cx, items)
    }
);

native!(
    fn get_canonical_locales(cx, this, args) {
        let mut items = Vec::new();
        for tag in requested(cx, args.get(0))? {
            items.push(js::string(cx, &tag)?);
        }
        js::new_array(cx, items)
    }
);

// --- DateTimeFormat ---------------------------------------------------------

/// Which fields a format without any gets (ECMA-402's `ToDateTimeOptions`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Defaults {
    Date,
    Time,
    All,
}

/// The local time zone's name: the zone local times are computed in
/// (`Date`'s, and so these formats'), so that a `timeZone` naming it
/// formats as local time does. The system's as the C library computing
/// them reads it ([`system_zone`]); where that is out of its sight
/// (Windows, Android), the platform's report of the same setting
/// ([`reported_zone_name`]); `None` for a zone without a name.
fn local_zone_name(cx: Ctx) -> R<Option<String>> {
    match system_zone() {
        SystemZone::Named(name) => Ok(Some(name)),
        SystemZone::Unnamed => Ok(None),
        SystemZone::Unknown => reported_zone_name(cx),
    }
}

/// What the system tells of the zone local times are computed in.
#[derive(Debug, PartialEq)]
enum SystemZone {
    /// The zone's name (`Europe/Berlin`, `GMT`), or the `TZ` local times
    /// follow by its own text (`CET-1CEST,M3.5.0,M10.5.0/3`): a POSIX rule
    /// names no zone, but a `timeZone` naming it is local time, its
    /// daylight saving time included, which no offset would be.
    Named(String),
    /// A zone without a name: a `TZ` of nothing but its `:`.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    Unnamed,
    /// Nothing: the C library reads the system's setting itself (Windows,
    /// Android).
    Unknown,
}

/// The system's time zone: the zone `TZ` names, as the C library that
/// computes `Date`'s local times reads it, else the zone `/etc/localtime`
/// links to (`/var/db/timezone/zoneinfo/Europe/Berlin`).
#[cfg(not(target_arch = "wasm32"))]
fn system_zone() -> SystemZone {
    system_zone_of(std::env::var("TZ").ok().as_deref(), || {
        std::fs::read_link("/etc/localtime")
            .ok()
            .and_then(|target| TimeZone::parse(&target.to_string_lossy()))
    })
}

/// The zone `TZ` (`tz`, `None` when unset) names, read as the Linux and
/// GPUI backends read it for `localeSettings()` ([`TimeZone::posix`]), else the
/// system's (`system`, asked only then). A `TZ` naming no zone but the
/// system's own file (`:/etc/localtime`) is named by its text: a POSIX
/// rule (`JST-9`), which the C library follows, or what it cannot read,
/// which it takes for UTC.
#[cfg(not(target_arch = "wasm32"))]
fn system_zone_of(tz: Option<&str>, system: impl FnOnce() -> Option<TimeZone>) -> SystemZone {
    let mut asked = false;
    let mut known = true;
    let zone = TimeZone::posix(tz, || {
        asked = true;
        let zone = system();
        known = zone.is_some();
        zone
    });
    let text = tz.map(|tz| {
        let tz = tz.trim();
        tz.strip_prefix(':').unwrap_or(tz)
    });
    if let Some(text) = text.filter(|text| asked && *text != "/etc/localtime") {
        if text.is_empty() {
            SystemZone::Unnamed
        } else {
            SystemZone::Named(text.to_owned())
        }
    } else if known {
        SystemZone::Named(zone.as_str().to_owned())
    } else {
        SystemZone::Unknown
    }
}

/// The system's time zone: the browser's
/// (`Intl.DateTimeFormat().resolvedOptions().timeZone`, the web runtime's
/// `nsh.time_zone` import).
#[cfg(target_arch = "wasm32")]
fn system_zone() -> SystemZone {
    #[link(wasm_import_module = "nsh")]
    unsafe extern "C" {
        /// Writes the name's UTF-8 into `buf` if it fits in `cap` bytes;
        /// returns its length.
        fn time_zone(buf: *mut u8, cap: usize) -> usize;
    }
    let mut buf = [0u8; 64];
    // SAFETY: JS writes at most `buf.len()` bytes into it.
    let len = unsafe { time_zone(buf.as_mut_ptr(), buf.len()) };
    match buf
        .get(..len)
        .and_then(|name| std::str::from_utf8(name).ok())
    {
        Some(name) if !name.is_empty() => SystemZone::Named(name.to_owned()),
        _ => SystemZone::Unknown,
    }
}

/// The device's zone as the platform reports it (`LocaleSettings::time_zone`,
/// `localeSettings()`), where it can be local time's ([`may_be_local`]): a
/// test's zone (`open({ localeSettings: { timeZone } })`) names the device's zone without
/// moving local time. `None` before the platform reports one.
fn reported_zone_name(cx: Ctx) -> R<Option<String>> {
    const HALF_A_YEAR_MS: f64 = 182.0 * 86_400_000.0;
    let Some(zone) = crate::env::time_zone(cx) else {
        return Ok(None);
    };
    let now = time_value(cx, js::UNDEFINED)?;
    let offsets = [
        local_offset(cx, now)?,
        local_offset(cx, now + HALF_A_YEAR_MS)?,
    ];
    Ok(may_be_local(zone.as_str(), offsets).then(|| zone.as_str().to_owned()))
}

/// Whether the zone `name` can be the one local times are in, whose
/// offsets half a year apart are `offsets`: a zone of one offset (`UTC`,
/// `+08:00`: [`fixed_zone`]) where both are that offset, any other zone
/// (`Europe/Berlin`) always, its offsets being a zone database's.
fn may_be_local(name: &str, offsets: [i32; 2]) -> bool {
    let minutes = match fixed_zone(name) {
        Some(date::Zone::Offset(minutes)) => minutes,
        Some(_) => 0,
        None => return true,
    };
    offsets.iter().all(|offset| *offset == minutes)
}

/// The zone of one offset a `timeZone` names: UTC by one of its names, or
/// an offset (`+08:00`); `None` for any other zone's name.
fn fixed_zone(name: &str) -> Option<date::Zone> {
    let upper = name.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "UTC" | "ETC/UTC" | "GMT" | "ETC/GMT" | "Z" | "ETC/UCT" | "UCT"
    ) {
        return Some(date::Zone::Utc);
    }
    parse_offset(name).map(date::Zone::Offset)
}

/// An offset time zone (`+08:00`, `-0530`, `+08`) in minutes east.
fn parse_offset(zone: &str) -> Option<i32> {
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' | 0xE2 => -1,
        _ => return None,
    };
    let digits: String = zone[1..].chars().filter(|c| *c != ':').collect();
    if !digits.bytes().all(|b| b.is_ascii_digit()) || !(digits.len() == 2 || digits.len() == 4) {
        return None;
    }
    let hours: i32 = digits[..2].parse().ok()?;
    let minutes: i32 = digits
        .get(2..)
        .filter(|m| !m.is_empty())
        .map_or(Some(0), |m| m.parse().ok())?;
    (hours < 24 && minutes < 60).then_some(sign * (hours * 60 + minutes))
}

fn zone_option(cx: Ctx, o: &Option<V>) -> R<date::Zone> {
    let v = get(cx, o, "timeZone")?;
    if v.is_undefined() {
        return Ok(date::Zone::Local);
    }
    let name = js::to_string(cx, v.raw())?;
    if let Some(zone) = fixed_zone(&name) {
        return Ok(zone);
    }
    if local_zone_name(cx)?.is_some_and(|local| local.eq_ignore_ascii_case(&name)) {
        return Ok(date::Zone::Local);
    }
    Err(js::range_error(
        cx,
        &format!(
            "Invalid time zone specified: {name} (nsh knows the device's zone, UTC and offsets such as +08:00)"
        ),
    ))
}

/// `dateStyle` and `timeStyle` (`""`: not set).
type Styles = (&'static str, &'static str);

/// The fields, the zone and the styles (made into fields for a locale by
/// [`styled`]) of the options.
fn date_format(
    cx: Ctx,
    options: Raw,
    defaults: Defaults,
) -> R<(date::Format, date::Zone, Option<Styles>)> {
    use date::{Format, HourCycle, Month, Num, Text};
    let o = self::options(cx, options)?;
    let text = |s: Option<&str>| match s {
        Some("long") => Some(Text::Long),
        Some("short") => Some(Text::Short),
        Some("narrow") => Some(Text::Narrow),
        _ => None,
    };
    let num = |s: Option<&str>| match s {
        Some("numeric") => Some(Num::Numeric),
        Some("2-digit") => Some(Num::TwoDigit),
        _ => None,
    };
    const NUMS: &[&str] = &["2-digit", "numeric"];
    let hour12 = bool_option(cx, &o, "hour12")?;
    let hour_cycle = string_option(cx, &o, "hourCycle", &["h11", "h12", "h23", "h24"])?;
    let zone = zone_option(cx, &o)?;
    let weekday = text(string_option(
        cx,
        &o,
        "weekday",
        &["narrow", "short", "long"],
    )?);
    string_option(cx, &o, "era", &["narrow", "short", "long"])?;
    let year = num(string_option(cx, &o, "year", NUMS)?);
    let month = match string_option(
        cx,
        &o,
        "month",
        &["2-digit", "numeric", "narrow", "short", "long"],
    )? {
        Some("numeric") => Some(Month::Num(Num::Numeric)),
        Some("2-digit") => Some(Month::Num(Num::TwoDigit)),
        other => text(other).map(Month::Text),
    };
    let day = num(string_option(cx, &o, "day", NUMS)?);
    string_option(cx, &o, "dayPeriod", &["narrow", "short", "long"])?;
    let hour = num(string_option(cx, &o, "hour", NUMS)?);
    let minute = num(string_option(cx, &o, "minute", NUMS)?);
    let second = num(string_option(cx, &o, "second", NUMS)?);
    let fraction = number_option(cx, &o, "fractionalSecondDigits", 1, 3)?.unwrap_or(0);
    let zone_name = string_option(
        cx,
        &o,
        "timeZoneName",
        &[
            "short",
            "long",
            "shortOffset",
            "longOffset",
            "shortGeneric",
            "longGeneric",
        ],
    )?
    .is_some();
    let date_style = string_option(cx, &o, "dateStyle", &["full", "long", "medium", "short"])?;
    let time_style = string_option(cx, &o, "timeStyle", &["full", "long", "medium", "short"])?;
    let hour_cycle = match (hour12, hour_cycle) {
        (Some(true), _) => Some(HourCycle::H12),
        (Some(false), _) => Some(HourCycle::H23),
        (None, Some("h11")) => Some(HourCycle::H11),
        (None, Some("h12")) => Some(HourCycle::H12),
        (None, Some("h23")) => Some(HourCycle::H23),
        (None, Some("h24")) => Some(HourCycle::H24),
        _ => None,
    };
    let mut f = Format {
        weekday,
        year,
        month,
        day,
        hour,
        minute,
        second,
        fraction,
        hour_cycle,
        zone_name,
    };
    let any_field = weekday.is_some()
        || year.is_some()
        || month.is_some()
        || day.is_some()
        || hour.is_some()
        || minute.is_some()
        || second.is_some()
        || fraction > 0
        || zone_name;
    if date_style.is_some() || time_style.is_some() {
        if any_field {
            return Err(js::type_error(
                cx,
                "Can't set option dateStyle or timeStyle with other date-time fields",
            ));
        }
        return Ok((
            f,
            zone,
            Some((date_style.unwrap_or(""), time_style.unwrap_or(""))),
        ));
    }
    let has_date = weekday.is_some() || year.is_some() || month.is_some() || day.is_some();
    let has_time = hour.is_some() || minute.is_some() || second.is_some() || fraction > 0;
    if !has_date && !has_time {
        if defaults != Defaults::Time {
            f.year = Some(Num::Numeric);
            f.month = Some(Month::Num(Num::Numeric));
            f.day = Some(Num::Numeric);
        }
        if defaults != Defaults::Date {
            f.hour = Some(Num::Numeric);
            f.minute = Some(Num::Numeric);
            f.second = Some(Num::Numeric);
        }
    }
    Ok((f, zone, None))
}

/// The fields of `dateStyle` / `timeStyle` for a locale.
fn styled(f: &mut date::Format, (date_style, time_style): Styles, locale: &Locale) {
    use date::{Month, Num, Text};
    match date_style {
        "short" => {
            f.year = Some(if locale.dates.short_year_2digit {
                Num::TwoDigit
            } else {
                Num::Numeric
            });
            f.month = Some(Month::Num(Num::Numeric));
            f.day = Some(Num::Numeric);
        }
        "medium" | "long" | "full" => {
            f.year = Some(Num::Numeric);
            f.month = Some(Month::Text(if date_style == "medium" {
                Text::Short
            } else {
                Text::Long
            }));
            f.day = Some(Num::Numeric);
            if date_style == "full" {
                f.weekday = Some(Text::Long);
            }
        }
        _ => {}
    }
    if !time_style.is_empty() {
        f.hour = Some(Num::Numeric);
        f.minute = Some(Num::Numeric);
        if time_style != "short" {
            f.second = Some(Num::Numeric);
        }
        f.zone_name = time_style == "long" || time_style == "full";
    }
}

struct DateTimeFormat {
    locale: Locale,
    format: date::Format,
    zone: date::Zone,
    styles: Option<Styles>,
    bound: Option<V>,
}

trace!(DateTimeFormat { bound });

impl Object for DateTimeFormat {}

/// The offset in minutes east of UTC that the local zone has at `ms`.
fn local_offset(cx: Ctx, ms: f64) -> R<i32> {
    // SAFETY: a new Date of this context.
    let date = V::checked(cx, unsafe { qjs::JS_NewDate(cx, ms) })?;
    let west = js::to_number(
        cx,
        js::invoke(cx, date.raw(), "getTimezoneOffset", &[])?.raw(),
    )?;
    Ok(if west.is_finite() { -(west as i32) } else { 0 })
}

/// The time `v` stands for (`undefined`: now), or a `RangeError`.
fn time_value(cx: Ctx, v: Raw) -> R<f64> {
    let ms = if js::is_undefined(v) {
        // Not std's clock: WebAssembly has none.
        nsh_core::time::unix_ms()
    } else {
        js::to_number(cx, v)?
    };
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return Err(js::range_error(cx, "Invalid time value"));
    }
    Ok(ms)
}

fn format_date(
    cx: Ctx,
    locale: &Locale,
    f: &date::Format,
    zone: date::Zone,
    ms: f64,
) -> R<Vec<Part>> {
    let offset = match zone {
        date::Zone::Local => local_offset(cx, ms)?,
        date::Zone::Utc => 0,
        date::Zone::Offset(minutes) => minutes,
    };
    Ok(date::format(ms, offset, zone, f, &locale.dates))
}

fn format_with(cx: Ctx, this: Raw, value: Raw) -> R<Vec<Part>> {
    let (locale, format, zone) = {
        let d = data::<DateTimeFormat>(cx, this, "DateTimeFormat")?;
        (d.locale.clone(), d.format, d.zone)
    };
    let ms = time_value(cx, value)?;
    format_date(cx, &locale, &format, zone, ms)
}

native!(
    fn date_time_format_constructor(cx, this, args) {
        let locale = resolve(cx, args.get(0))?;
        let (mut format, zone, styles) = date_format(cx, args.get(1), Defaults::Date)?;
        if let Some(styles) = styles {
            styled(&mut format, styles, &locale);
        }
        instance(cx, this, Class::DateTimeFormat, DateTimeFormat { locale, format, zone, styles, bound: None })
    }
);

native!(
    fn date_time_format_format(cx, this, args) {
        if let Some(bound) = &data::<DateTimeFormat>(cx, this, "DateTimeFormat")?.bound {
            return Ok(bound.clone_ref());
        }
        let f = js::closure(cx, vec![V::dup(cx, this)], |cx, captures, args| {
            let parts = format_with(cx, captures[0].raw(), args.get(0))?;
            js::string(cx, &join(&parts))
        })?;
        data::<DateTimeFormat>(cx, this, "DateTimeFormat")?.bound = Some(f.clone_ref());
        Ok(f)
    }
);

native!(
    fn date_time_format_to_parts(cx, this, args) {
        let parts = format_with(cx, this, args.get(0))?;
        parts_array(cx, &parts)
    }
);

native!(
    fn date_time_format_resolved_options(cx, this, args) {
        use date::{Month, Num, Text, Zone};
        let (locale, f, zone, styles) = {
            let d = data::<DateTimeFormat>(cx, this, "DateTimeFormat")?;
            (d.locale.clone(), d.format, d.zone, d.styles)
        };
        let o = js::new_object(cx)?;
        let set = |key: &str, value: V| js::define(cx, o.raw(), key, value, true);
        let text = |s: &str| js::string(cx, s);
        set("locale", text(locale.tag.as_str())?)?;
        set("calendar", text("gregory")?)?;
        set("numberingSystem", text("latn")?)?;
        let zone = match zone {
            Zone::Utc => "UTC".to_owned(),
            Zone::Offset(m) => format!("{}{:02}:{:02}", if m < 0 { '-' } else { '+' }, m.abs() / 60, m.abs() % 60),
            Zone::Local => match local_zone_name(cx)? {
                Some(name) => name,
                None => {
                    let m = local_offset(cx, time_value(cx, js::UNDEFINED)?)?;
                    format!("{}{:02}:{:02}", if m < 0 { '-' } else { '+' }, m.abs() / 60, m.abs() % 60)
                }
            },
        };
        set("timeZone", text(&zone)?)?;
        if f.hour.is_some() {
            let cycle = f.cycle(&locale.dates);
            set("hourCycle", text(cycle.name())?)?;
            set("hour12", V::bool(matches!(cycle, date::HourCycle::H11 | date::HourCycle::H12)))?;
        }
        if let Some((date_style, time_style)) = styles {
            if !date_style.is_empty() {
                set("dateStyle", text(date_style)?)?;
            }
            if !time_style.is_empty() {
                set("timeStyle", text(time_style)?)?;
            }
            return Ok(o);
        }
        let text_name = |t: Text| match t {
            Text::Long => "long",
            Text::Short => "short",
            Text::Narrow => "narrow",
        };
        let num_name = |n: Num| match n {
            Num::Numeric => "numeric",
            Num::TwoDigit => "2-digit",
        };
        if let Some(w) = f.weekday {
            set("weekday", text(text_name(w))?)?;
        }
        if let Some(n) = f.year {
            set("year", text(num_name(n))?)?;
        }
        if let Some(m) = f.month {
            set("month", text(match m {
                Month::Num(n) => num_name(n),
                Month::Text(t) => text_name(t),
            })?)?;
        }
        for (key, value) in [("day", f.day), ("hour", f.hour), ("minute", f.minute), ("second", f.second)] {
            if let Some(n) = value {
                // Minutes and seconds are written with two digits next to
                // the hour, as browsers report.
                let n = if (key == "minute" && f.hour.is_some()) || (key == "second" && f.minute.is_some()) {
                    Num::TwoDigit
                } else {
                    n
                };
                set(key, text(num_name(n))?)?;
            }
        }
        if f.fraction > 0 {
            set("fractionalSecondDigits", V::num(f64::from(f.fraction)))?;
        }
        if f.zone_name {
            set("timeZoneName", text("short")?)?;
        }
        Ok(o)
    }
);

// --- The prototypes' toLocaleString -----------------------------------------

native!(
    /// `Number.prototype.toLocaleString` and `BigInt.prototype.
    /// toLocaleString`: `Intl.NumberFormat` without the object.
    fn number_to_locale_string(cx, this, args) {
        // SAFETY: an inline tag read.
        let tag = unsafe { qjs::JS_VALUE_GET_TAG(this) };
        let value = if tag == qjs::JS_TAG_BIG_INT || tag == qjs::JS_TAG_SHORT_BIG_INT {
            number_value(cx, this)?
        } else {
            // A Number object or a number (`valueOf` unwraps the object).
            number::Value::from_f64(js::to_number(cx, this)?)
        };
        let locale = resolve(cx, args.get(0))?;
        let format = number_format(cx, args.get(1))?;
        let parts = number::format(&value, &format, &locale.numbers, locale.tag.as_str());
        js::string(cx, &join(&parts))
    }
);

fn date_to_locale(cx: Ctx, this: Raw, args: js::Args<'_>, defaults: Defaults) -> R<V> {
    // SAFETY: an inline class check.
    if !unsafe { qjs::JS_IsDate(this) } {
        return Err(js::type_error(cx, "this is not a Date object."));
    }
    let ms = js::to_number(cx, this)?;
    if !ms.is_finite() {
        return js::string(cx, "Invalid Date");
    }
    let locale = resolve(cx, args.get(0))?;
    let (mut format, zone, styles) = date_format(cx, args.get(1), defaults)?;
    if let Some(styles) = styles {
        styled(&mut format, styles, &locale);
    }
    let parts = format_date(cx, &locale, &format, zone, ms)?;
    js::string(cx, &join(&parts))
}

native!(
    fn date_to_locale_string(cx, this, args) {
        date_to_locale(cx, this, args, Defaults::All)
    }
);

native!(
    fn date_to_locale_date_string(cx, this, args) {
        date_to_locale(cx, this, args, Defaults::Date)
    }
);

native!(
    fn date_to_locale_time_string(cx, this, args) {
        date_to_locale(cx, this, args, Defaults::Time)
    }
);

/// Replaces the engine's `toLocaleString`s (which ignore locales and
/// options) with these.
pub(crate) fn install(cx: Ctx) -> R<()> {
    let g = js::global(cx);
    type Methods = &'static [(&'static std::ffi::CStr, js::Native, c_int)];
    let methods: [(&str, Methods); 3] = [
        ("Number", &[(c"toLocaleString", number_to_locale_string, 0)]),
        ("BigInt", &[(c"toLocaleString", number_to_locale_string, 0)]),
        (
            "Date",
            &[
                (c"toLocaleString", date_to_locale_string, 0),
                (c"toLocaleDateString", date_to_locale_date_string, 0),
                (c"toLocaleTimeString", date_to_locale_time_string, 0),
            ],
        ),
    ];
    for (class, methods) in methods {
        let ctor = js::get(cx, g.raw(), class)?;
        let proto = js::get(cx, ctor.raw(), "prototype")?;
        for (name, f, length) in methods {
            let func = js::function(cx, name, *f, *length)?;
            // SAFETY: the property takes the function; non-enumerable, as
            // built-in methods are.
            unsafe {
                qjs::JS_DefinePropertyValueStr(
                    cx,
                    proto.raw(),
                    name.as_ptr(),
                    func.take(),
                    (qjs::JS_PROP_WRITABLE | qjs::JS_PROP_CONFIGURABLE) as c_int,
                );
            }
        }
    }
    Ok(())
}

/// The `Intl` object: the namespace of the two classes.
pub(crate) fn namespace(cx: Ctx) -> R<V> {
    let global = js::new_object(cx)?;
    for (name, class) in [
        ("NumberFormat", Class::NumberFormat),
        ("DateTimeFormat", Class::DateTimeFormat),
    ] {
        let ctor = super::constructor(cx, class)?;
        js::define(cx, global.raw(), name, ctor, false)?;
    }
    let f = js::function(cx, c"getCanonicalLocales", get_canonical_locales, 1)?;
    js::define(cx, global.raw(), "getCanonicalLocales", f, false)?;
    let tag = js::string(cx, "Intl")?;
    // SAFETY: the property takes the string.
    unsafe {
        qjs::JS_DefinePropertyValue(
            cx,
            global.raw(),
            qjs::JS_ATOM_Symbol_toStringTag as _,
            tag.take(),
            qjs::JS_PROP_CONFIGURABLE as c_int,
        );
    }
    Ok(global)
}

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::NumberFormat,
        name: c"NumberFormat",
        parent: None,
        constructor: Some((number_format_constructor, 0)),
        methods: &[
            (Key::Name(c"formatToParts"), number_format_to_parts, 1),
            (
                Key::Name(c"resolvedOptions"),
                number_format_resolved_options,
                0,
            ),
        ],
        accessors: &[(c"format", number_format_format, None)],
        statics: &[(c"supportedLocalesOf", supported_locales_of, 1)],
        constants: &[],
        global: false,
        ts: super::ClassTs::NONE,
    },
    Spec {
        class: Class::DateTimeFormat,
        name: c"DateTimeFormat",
        parent: None,
        constructor: Some((date_time_format_constructor, 0)),
        methods: &[
            (Key::Name(c"formatToParts"), date_time_format_to_parts, 1),
            (
                Key::Name(c"resolvedOptions"),
                date_time_format_resolved_options,
                0,
            ),
        ],
        accessors: &[(c"format", date_time_format_format, None)],
        statics: &[(c"supportedLocalesOf", supported_locales_of, 1)],
        constants: &[],
        global: false,
        ts: super::ClassTs::NONE,
    },
];

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn the_systems_zone_is_the_one_tz_names() {
        use SystemZone::{Named, Unknown, Unnamed};
        let named = |name: &str| Named(name.to_owned());
        // A system zone other than UTC, so that falling back on it shows.
        let singapore = || TimeZone::parse("Asia/Singapore");
        let zone = |tz: Option<&str>| system_zone_of(tz, singapore);
        // `TZ=GMT` is the zone `Date`'s local times follow, eight hours
        // from the system's, and the system is not asked.
        assert_eq!(zone(Some("GMT")), named("GMT"));
        assert_eq!(
            system_zone_of(Some("GMT"), || unreachable!("TZ names the zone")),
            named("GMT")
        );
        for name in ["UTC", "EST", "Japan", "Etc/GMT+5", "Europe/Berlin"] {
            assert_eq!(zone(Some(name)), named(name));
            assert_eq!(zone(Some(&format!(":{name}"))), named(name));
        }
        assert_eq!(zone(Some("")), named("UTC"));
        assert_eq!(
            zone(Some("/usr/share/zoneinfo/Asia/Tokyo")),
            named("Asia/Tokyo")
        );
        // Unset, or the system's own file: the system's zone.
        assert_eq!(zone(None), named("Asia/Singapore"));
        assert_eq!(zone(Some(":/etc/localtime")), named("Asia/Singapore"));
        // A POSIX rule is local time named by its text, not the system's
        // zone (nine hours from Singapore's), nor one offset: a `timeZone`
        // naming it keeps its daylight saving time.
        for rule in ["JST-9", "<+08>-8", "CET-1CEST,M3.5.0,M10.5.0/3"] {
            assert_eq!(zone(Some(rule)), named(rule));
            assert_eq!(zone(Some(&format!(":{rule}"))), named(rule));
        }
        // What the C library cannot read (it takes UTC) is named as set,
        // and a lone `:` is local time without a name.
        assert_eq!(zone(Some("Not a zone")), named("Not a zone"));
        assert_eq!(zone(Some(":")), Unnamed);
        // Where nothing tells (Windows, Android), nothing known: the
        // platform's report is asked instead.
        assert_eq!(system_zone_of(None, || None), Unknown);
        assert_eq!(system_zone_of(Some("GMT"), || None), named("GMT"));
    }

    #[test]
    fn a_zone_of_one_offset_is_local_time_only_with_its_offset() {
        // Singapore (+08:00), London in winter and summer.
        for (name, offsets, local) in [
            ("UTC", [480, 480], false),
            ("UTC", [0, 60], false),
            ("UTC", [0, 0], true),
            ("Etc/UTC", [0, 0], true),
            ("+08:00", [480, 480], true),
            ("+08:00", [450, 480], false),
            // A zone's name: its offsets are the database's.
            ("Asia/Singapore", [480, 480], true),
            ("Europe/London", [0, 60], true),
            ("GMT+01:00", [60, 60], true),
        ] {
            assert_eq!(may_be_local(name, offsets), local, "{name} at {offsets:?}");
        }
    }
}
