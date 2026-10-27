//! [`Rows`]: the rows of data a component takes from JS (`data: T[]`), read
//! natively as columns of numbers by key, and [`RowAccessor`]: how it reads
//! a value of each row (a key, or the app's function of a row), and
//! [`RowText`]: how it reads a text of each row (a label beside a value).

use std::{fmt, rc::Rc, sync::Arc};

use super::{
    Callback, JsValue, PropError, SharedString, TsTypes,
    callback::CallbackHandle,
    class::{Arg, Ret},
    js::{JsHost, JsIn, JsKind, JsOwned},
};

/// Rows of data a component takes, `T[]` in TypeScript (its props generic
/// over `T`: `#[props(generic)]`): JS objects whose number fields are read
/// once, when JS sets the prop, into a column per key, so the component
/// reads its values by key ([`Rows::column`]) without calling into JS
/// again. A field that is not a number on some row (missing, `null`, a
/// string) is `NaN` there: a gap.
#[derive(Clone, Default)]
pub struct Rows {
    len: usize,
    columns: Vec<(SharedString, Arc<[f64]>)>,
    /// The JS array, kept to hand its rows to the app's functions
    /// ([`RowAccessor::Js`]); none for rows made in Rust.
    js: Option<Rc<dyn CallbackHandle>>,
}

impl fmt::Debug for Rows {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Rows")
            .field("len", &self.len)
            .field("columns", &self.columns)
            .finish_non_exhaustive()
    }
}

impl Rows {
    /// `len` rows with the number fields `columns` (each `len` long;
    /// shorter ones end in gaps).
    pub fn from_columns(
        len: usize,
        columns: impl IntoIterator<Item = (SharedString, Vec<f64>)>,
    ) -> Self {
        let columns = columns
            .into_iter()
            .map(|(key, mut values)| {
                values.resize(len, f64::NAN);
                (key, values.into())
            })
            .collect();
        Self {
            len,
            columns,
            js: None,
        }
    }

    /// Row `index` as the app's JS value, for a function of the app's
    /// ([`RowAccessor::Js`]); `None` for rows made in Rust.
    pub fn row(&self, index: usize) -> Option<RowRef> {
        (index < self.len).then(|| RowRef {
            rows: self.js.clone(),
            index,
        })
    }

    /// How many rows there are.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The values of field `key`, one per row (`NaN` where a row has no
    /// number there); `None` when no row has a number there.
    pub fn column(&self, key: &str) -> Option<&[f64]> {
        self.columns
            .iter()
            .find(|(k, _)| &**k == key)
            .map(|(_, values)| &**values)
    }

    /// The keys with numbers, in the order they first appear.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.columns.iter().map(|(k, _)| &**k)
    }
}

/// Equal rows hold the same numbers (including gaps) and retained JS rows.
/// Arbitrary JS fields matter too: a different retained array must replace
/// the prop even when its numeric columns are unchanged.
impl PartialEq for Rows {
    fn eq(&self, other: &Self) -> bool {
        let same_rows = match (&self.js, &other.js) {
            (None, None) => true,
            (Some(a), Some(b)) => Rc::ptr_eq(a, b),
            _ => false,
        };
        same_rows
            && self.len == other.len
            && self.columns.len() == other.columns.len()
            && self.columns.iter().zip(&other.columns).all(|(a, b)| {
                a.0 == b.0
                    && a.1.len() == b.1.len()
                    && a.1
                        .iter()
                        .zip(b.1.iter())
                        .all(|(x, y)| x.to_bits() == y.to_bits())
            })
    }
}

impl JsValue for Rows {
    fn ts_type(_types: &mut TsTypes) -> String {
        "T[]".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let len = value
            .array_len()?
            .ok_or_else(|| value.expected("an array of objects"))?;
        let mut columns: Vec<(SharedString, Vec<f64>)> = Vec::new();
        for i in 0..len {
            let row = value.index(i)?;
            let row = row.get();
            if row.kind() != JsKind::Object {
                continue;
            }
            for key in row.keys()? {
                let Some(n) = row.field(&key)?.get().as_number() else {
                    continue;
                };
                let at = match columns.iter().position(|(k, _)| **k == *key) {
                    Some(at) => at,
                    None => {
                        columns.push((SharedString::from(key), vec![f64::NAN; len]));
                        columns.len() - 1
                    }
                };
                columns[at].1[i] = n;
            }
        }
        let mut rows = Rows::from_columns(len, columns);
        rows.js = value.host().retain(value.raw());
        Ok(rows)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        // The numbers it read, one object per row.
        let mut rows = Vec::with_capacity(self.len);
        for i in 0..self.len {
            let row = JsOwned::new(host, host.new_object()?);
            for (key, values) in &self.columns {
                let n = values[i];
                if !n.is_nan() {
                    host.set_field(row.get().raw(), key, host.new_number(n))?;
                }
            }
            rows.push(row);
        }
        let raws = rows.into_iter().map(JsOwned::into_raw).collect();
        Ok(JsOwned::new(host, host.new_array(raws)?))
    }
}

/// A row of [`Rows`] as the app's JS value: the first argument of the
/// app's function of a row ([`RowAccessor::Js`]), the object the app put
/// in its array (`undefined` for rows made in Rust, and by default).
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct RowRef {
    rows: Option<Rc<dyn CallbackHandle>>,
    index: usize,
}

impl Ret for RowRef {
    fn ts_type(_types: &mut TsTypes) -> String {
        "T".into()
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let Some(array) = self.rows.as_ref().and_then(|r| r.value(host)) else {
            return Ok(JsOwned::new(host, host.undefined()));
        };
        let array = JsOwned::new(host, array);
        let row = array.get().index(self.index)?;
        Ok(row)
    }
}

/// How a component reads a value of each of its [`Rows`] (TS
/// `Extract<keyof T, string> | ((d: T, index: number) => number)`): the
/// number field of a name, read natively; or the app's function of a row
/// and its index, which a component calls once per row when the rows or
/// the function change, in the next JS turn, and never while it draws or
/// follows the pointer (so the function is pure: the same row, the same
/// number).
#[derive(Clone)]
pub enum RowAccessor {
    /// The number field `key`.
    Key(SharedString),
    /// The app's JS function of a row and its index.
    Js(Callback<(RowRef, u32), f64>),
    /// A Rust function of a row's index, for components made in Rust.
    Rust(Rc<dyn Fn(usize) -> f64>),
}

impl RowAccessor {
    /// The field `key`.
    pub fn key(key: impl Into<SharedString>) -> Self {
        RowAccessor::Key(key.into())
    }

    /// The value of row `index` that `f` gives (Rust).
    pub fn from_fn(f: impl Fn(usize) -> f64 + 'static) -> Self {
        RowAccessor::Rust(Rc::new(f))
    }

    /// The values of `rows` when they need no JS (a key or a Rust
    /// function); `None` for a JS function ([`RowAccessor::values`]).
    pub fn values_now(&self, rows: &Rows) -> Option<Arc<[f64]>> {
        match self {
            RowAccessor::Key(key) => Some(
                rows.column(key)
                    .map(Arc::from)
                    .unwrap_or_else(|| vec![f64::NAN; rows.len()].into()),
            ),
            RowAccessor::Rust(f) => Some((0..rows.len()).map(|i| f(i)).collect()),
            RowAccessor::Js(_) => None,
        }
    }

    /// The values of `rows`: a JS function is called once per row, in the
    /// next JS turn (a row whose call throws or returns no number is
    /// `NaN`, a gap).
    pub async fn values(&self, rows: &Rows) -> Arc<[f64]> {
        if let Some(values) = self.values_now(rows) {
            return values;
        }
        let RowAccessor::Js(f) = self else {
            unreachable!("the other accessors need no JS")
        };
        let answers: Vec<_> = (0..rows.len())
            .filter_map(|i| rows.row(i).map(|row| f.call_async((row, i as u32))))
            .collect();
        let mut out = Vec::with_capacity(answers.len());
        for answer in answers {
            out.push(match answer.await {
                Ok(v) if v.is_finite() => v,
                _ => f64::NAN,
            });
        }
        out.into()
    }
}

impl fmt::Debug for RowAccessor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RowAccessor::Key(key) => f.debug_tuple("Key").field(key).finish(),
            RowAccessor::Js(_) => f.write_str("Js"),
            RowAccessor::Rust(_) => f.write_str("Rust"),
        }
    }
}

/// The same key, or the same function.
impl PartialEq for RowAccessor {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (RowAccessor::Key(a), RowAccessor::Key(b)) => a == b,
            (RowAccessor::Js(a), RowAccessor::Js(b)) => Rc::ptr_eq(a.handle(), b.handle()),
            (RowAccessor::Rust(a), RowAccessor::Rust(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl From<&str> for RowAccessor {
    fn from(key: &str) -> Self {
        RowAccessor::key(key.to_owned())
    }
}

impl JsValue for RowAccessor {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Extract<keyof T, string> | ((d: T, index: number) => number)".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::String => <SharedString as JsValue>::from_js(value).map(RowAccessor::Key),
            JsKind::Function => {
                <Callback<(RowRef, u32), f64> as Arg>::from_js(value).map(RowAccessor::Js)
            }
            _ => Err(value.expected("a field name or a function of a row")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            RowAccessor::Key(key) => key.to_js(host),
            // A function stays the app's: it is not handed back.
            _ => Ok(JsOwned::new(host, host.undefined())),
        }
    }
}

/// How a component reads a text of each of its [`Rows`] (TS
/// `Extract<keyof T, string> | ((d: T, index: number) => string)`): the
/// number field of a name, written as JS writes a number (`String(n)`),
/// read natively; or the app's function of a row and its index, for text
/// the app formats (units, separators, its locale), which a component
/// calls once per row when the rows or the function change, in the next
/// JS turn, and never while it draws (so the function is pure: the same
/// row, the same text). [`RowAccessor`]'s twin for what a component shows
/// as text, such as a value beside a bar.
#[derive(Clone)]
pub enum RowText {
    /// The number field `key`, as JS writes it.
    Key(SharedString),
    /// The app's JS function of a row and its index.
    Js(Callback<(RowRef, u32), SharedString>),
    /// A Rust function of a row's index, for components made in Rust.
    Rust(Rc<dyn Fn(usize) -> SharedString>),
}

impl RowText {
    /// The field `key`, as JS writes its numbers.
    pub fn key(key: impl Into<SharedString>) -> Self {
        RowText::Key(key.into())
    }

    /// The text of row `index` that `f` gives (Rust).
    pub fn from_fn(f: impl Fn(usize) -> SharedString + 'static) -> Self {
        RowText::Rust(Rc::new(f))
    }

    /// The texts of `rows` when they need no JS (a key or a Rust
    /// function); `None` for a JS function ([`RowText::texts`]). A row
    /// without a number in the field has no text (empty).
    pub fn texts_now(&self, rows: &Rows) -> Option<Arc<[SharedString]>> {
        match self {
            RowText::Key(key) => Some(match rows.column(key) {
                Some(values) => values.iter().map(|&v| js_number_text(v)).collect(),
                None => vec![SharedString::default(); rows.len()].into(),
            }),
            RowText::Rust(f) => Some((0..rows.len()).map(|i| f(i)).collect()),
            RowText::Js(_) => None,
        }
    }

    /// The texts of `rows`: a JS function is called once per row, in the
    /// next JS turn (a row whose call throws or returns no string has no
    /// text).
    pub async fn texts(&self, rows: &Rows) -> Arc<[SharedString]> {
        if let Some(texts) = self.texts_now(rows) {
            return texts;
        }
        let RowText::Js(f) = self else {
            unreachable!("the other texts need no JS")
        };
        let answers: Vec<_> = (0..rows.len())
            .filter_map(|i| rows.row(i).map(|row| f.call_async((row, i as u32))))
            .collect();
        let mut out = Vec::with_capacity(answers.len());
        for answer in answers {
            out.push(answer.await.unwrap_or_default());
        }
        out.into()
    }
}

/// `n` as JS's `String(n)` writes the numbers rows hold: whole numbers
/// without a fraction, `-0` as `0`, nothing for a gap (`NaN`).
fn js_number_text(n: f64) -> SharedString {
    if n.is_nan() {
        return SharedString::default();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    // Rust writes 1820.0 as "1820" and 0.25 as "0.25", as JS does, short
    // of the exponents JS switches to past 1e21 and below 1e-6.
    format!("{n}").into()
}

impl fmt::Debug for RowText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RowText::Key(key) => f.debug_tuple("Key").field(key).finish(),
            RowText::Js(_) => f.write_str("Js"),
            RowText::Rust(_) => f.write_str("Rust"),
        }
    }
}

/// The same key, or the same function.
impl PartialEq for RowText {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (RowText::Key(a), RowText::Key(b)) => a == b,
            (RowText::Js(a), RowText::Js(b)) => Rc::ptr_eq(a.handle(), b.handle()),
            (RowText::Rust(a), RowText::Rust(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl From<&str> for RowText {
    fn from(key: &str) -> Self {
        RowText::key(key.to_owned())
    }
}

impl JsValue for RowText {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Extract<keyof T, string> | ((d: T, index: number) => string)".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::String => <SharedString as JsValue>::from_js(value).map(RowText::Key),
            JsKind::Function => {
                <Callback<(RowRef, u32), SharedString> as Arg>::from_js(value).map(RowText::Js)
            }
            _ => Err(value.expected("a field name or a function of a row")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            RowText::Key(key) => key.to_js(host),
            // A function stays the app's: it is not handed back.
            _ => Ok(JsOwned::new(host, host.undefined())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_by_key_with_gaps() {
        let rows = Rows::from_columns(
            3,
            [
                ("price".into(), vec![1.0, 2.0, 3.0]),
                ("avg".into(), vec![1.5]),
            ],
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows.column("price"), Some(&[1.0, 2.0, 3.0][..]));
        let avg = rows.column("avg").unwrap();
        assert_eq!(avg[0], 1.5);
        assert!(avg[1].is_nan() && avg[2].is_nan());
        assert_eq!(rows.column("time"), None);
        assert_eq!(rows.keys().collect::<Vec<_>>(), ["price", "avg"]);
        // Gaps compare equal.
        assert_eq!(rows, rows.clone());
    }

    /// A field and a Rust function read at once; a field no row has is
    /// all gaps; the same key or function is equal, another is not.
    #[test]
    fn accessors_read_a_value_of_each_row() {
        let rows = Rows::from_columns(3, [("price".into(), vec![1.0, 2.0, 3.0])]);
        let key = RowAccessor::key("price");
        assert_eq!(key.values_now(&rows).as_deref(), Some(&[1.0, 2.0, 3.0][..]));
        let missing = RowAccessor::key("time").values_now(&rows).unwrap();
        assert!(missing.len() == 3 && missing.iter().all(|v| v.is_nan()));
        let twice = RowAccessor::from_fn(|i| i as f64 * 2.0);
        assert_eq!(
            twice.values_now(&rows).as_deref(),
            Some(&[0.0, 2.0, 4.0][..])
        );
        assert_eq!(key, RowAccessor::from("price"));
        assert_eq!(twice, twice.clone());
        assert_ne!(twice, RowAccessor::from_fn(|i| i as f64 * 2.0));
        // Rust rows have no JS value to hand a function.
        assert!(rows.row(0).is_some_and(|r| r.rows.is_none()));
        assert!(rows.row(3).is_none());
    }

    /// A field's numbers as JS writes them, gaps empty; a Rust function's
    /// texts; the same key or function is equal.
    #[test]
    fn texts_read_a_text_of_each_row() {
        let rows = Rows::from_columns(4, [("v".into(), vec![1820.0, 0.25, -0.0, f64::NAN])]);
        let key = RowText::key("v");
        let texts = key.texts_now(&rows).unwrap();
        assert_eq!(
            texts.iter().map(|t| &**t).collect::<Vec<_>>(),
            ["1820", "0.25", "0", ""]
        );
        let missing = RowText::key("w").texts_now(&rows).unwrap();
        assert!(missing.len() == 4 && missing.iter().all(|t| t.is_empty()));
        let named = RowText::from_fn(|i| format!("#{i}").into());
        assert_eq!(&*named.texts_now(&rows).unwrap()[3], "#3");
        assert_eq!(key, RowText::from("v"));
        assert_ne!(named, RowText::from_fn(|i| format!("#{i}").into()));
    }
}
