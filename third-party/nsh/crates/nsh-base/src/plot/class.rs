//! [`RowClass`]: a part's classes per row, the same on every row or the
//! app's function of a row, read once per row when the rows or the
//! function change.

use std::{fmt, rc::Rc, sync::Arc};

use nsh_core::{
    element::{
        Arg, Callback, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, RowRef, Rows, TsTypes,
    },
    prelude::*,
};

/// A part's classes per row (TS `string | ((d: T, index: number) =>
/// string)`): the same on every row, or the app's function of a row and its
/// index, as `gpui-component`'s `SankeyChart::node_color` takes a function
/// of the datum (`chart/sankey_chart.rs:264`), called once per row when the
/// rows or the function change, in the next JS turn, never while the mark
/// draws or follows the pointer (so the function is pure: the same row, the
/// same classes). [`SliceClass`](super::SliceClass) is the same for a
/// pie's slices.
#[derive(Clone)]
pub enum RowClass {
    /// The same classes on every row.
    All(SharedString),
    /// The app's JS function of a row and its index.
    Js(Callback<(RowRef, u32), SharedString>),
    /// A Rust function of a row's index, for marks made in Rust.
    Rust(Rc<dyn Fn(usize) -> SharedString>),
}

impl RowClass {
    /// The classes `f` gives the part of each row's index (Rust).
    pub fn from_fn(f: impl Fn(usize) -> SharedString + 'static) -> Self {
        RowClass::Rust(Rc::new(f))
    }

    /// Reads a JS value: classes, or a function of a row.
    pub(super) fn read(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::String => <SharedString as JsValue>::from_js(value).map(RowClass::All),
            JsKind::Function => {
                <Callback<(RowRef, u32), SharedString> as Arg>::from_js(value).map(RowClass::Js)
            }
            _ => Err(value.expected("classes or a function of a row")),
        }
    }

    /// The JS value: its classes, `undefined` for a function (it stays the
    /// app's, or Rust's).
    pub(super) fn write<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            RowClass::All(class) => class.to_js(host),
            _ => Ok(JsOwned::new(host, host.undefined())),
        }
    }
}

impl fmt::Debug for RowClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RowClass::All(class) => f.debug_tuple("All").field(class).finish(),
            RowClass::Js(_) => f.write_str("Js"),
            RowClass::Rust(_) => f.write_str("Rust"),
        }
    }
}

/// The same classes, or the same Rust function; the app's functions are
/// told apart by the classes they give, so a function set again (an arrow
/// function in JSX is a new one at each render) is called again.
impl PartialEq for RowClass {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (RowClass::All(a), RowClass::All(b)) => a == b,
            (RowClass::Rust(a), RowClass::Rust(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl From<&'static str> for RowClass {
    fn from(class: &'static str) -> Self {
        RowClass::All(class.into())
    }
}

impl From<SharedString> for RowClass {
    fn from(class: SharedString) -> Self {
        RowClass::All(class)
    }
}

impl JsValue for RowClass {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | ((d: T, index: number) => string)".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Self::read(value)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.write(host)
    }
}

/// The classes of each of `rows`, once known: at once for the same classes
/// or a Rust function, in the next JS turn for the app's function (a row
/// whose call throws has none of its own).
pub(super) fn row_classes(
    rows: impl Fn() -> Rows + 'static,
    class: impl Fn() -> Option<RowClass> + 'static,
) -> Signal<Option<Arc<[SharedString]>>> {
    let out = signal(None::<Arc<[SharedString]>>);
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let (rows, class) = (rows(), class());
        let run = generation.get() + 1;
        generation.replace(run);
        match class {
            None => out.set(None),
            Some(RowClass::All(class)) => out.set(Some(vec![class; rows.len()].into())),
            Some(RowClass::Rust(f)) => out.set(Some((0..rows.len()).map(|i| f(i)).collect())),
            Some(RowClass::Js(f)) => {
                let answers: Vec<_> = (0..rows.len())
                    .filter_map(|i| rows.row(i).map(|row| f.call_async((row, i as u32))))
                    .collect();
                spawn(async move {
                    let mut classes = Vec::with_capacity(answers.len());
                    for answer in answers {
                        classes.push(answer.await.unwrap_or_default());
                    }
                    if generation.get() == run {
                        out.set(Some(classes.into()));
                    }
                });
            }
        }
    });
    out
}
