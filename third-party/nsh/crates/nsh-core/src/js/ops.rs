//! Operations JS records into flat lists (a canvas's drawing): a code, then
//! its arguments. `#[derive(JsOps)]` on an enum of operations maps codes
//! to variants and reads their fields in order ([`OpArg`]), and describes
//! the methods and properties that record them as they are, which the
//! native recorders (`nsh-js` `canvas.rs`) and their declarations
//! (`canvas.gen.ts`) are made from. The
//! lists are read through [`HostInput`], straight from QuickJS values.

use std::{fmt, sync::Arc};

pub use nsh_macros::JsOps;

use super::host::{HostCx, HostInput, HostList, HostValue};
use crate::element::TsTypes;

/// Why a recorded list could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpsError {
    /// It ends inside an operation.
    Truncated,
    /// A code is not a number.
    NotAnOperation,
    /// A code no operation has.
    Unknown(i32),
    /// An operation where it cannot be (a path's list holds path
    /// operations only).
    Misplaced(i32),
}

impl fmt::Display for OpsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpsError::Truncated => f.write_str("truncated list of operations"),
            OpsError::NotAnOperation => f.write_str("expected an operation"),
            OpsError::Unknown(code) => write!(f, "unknown operation {code}"),
            OpsError::Misplaced(code) => write!(f, "operation {code} does not belong here"),
        }
    }
}

impl std::error::Error for OpsError {}

/// Reads items `start..end` of a recorded list, in order.
pub struct OpReader<'a, L> {
    list: &'a L,
    pos: usize,
    end: usize,
}

impl<'a, L: HostList<Item: HostInput>> OpReader<'a, L> {
    /// Items `start..end` of `list`.
    pub fn new(list: &'a L, start: usize, end: usize) -> Self {
        Self {
            list,
            pos: start,
            end,
        }
    }

    /// The whole of `list`.
    pub fn all(list: &'a L) -> Self {
        Self::new(list, 0, list.len())
    }

    /// Whether items are left.
    #[inline]
    pub fn more(&self) -> bool {
        self.pos < self.end
    }

    /// The next item (an argument).
    #[inline]
    pub fn arg(&mut self) -> Result<L::Item, OpsError> {
        if self.pos >= self.end {
            return Err(OpsError::Truncated);
        }
        let item = self.list.item(self.pos).ok_or(OpsError::Truncated)?;
        self.pos += 1;
        Ok(item)
    }

    /// The next item as an operation's code.
    #[inline]
    pub fn code(&mut self) -> Result<i32, OpsError> {
        self.arg()?
            .as_number()
            .map(|n| n as i32)
            .ok_or(OpsError::NotAnOperation)
    }
}

/// An argument of a recorded operation: how it is read (with the list's
/// context `Cx`, e.g. the drawing that numbers' animated values become slots
/// of) and its TypeScript type.
pub trait OpArg<Cx>: Sized {
    /// How many items it takes (an `[f32; 4]` four, one parameter each).
    const ARITY: usize = 1;
    /// The argument; `None` drops the operation (an invalid color, as in
    /// HTML Canvas). Values of another type are the type's default.
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        cx: &mut Cx,
    ) -> Result<Option<Self>, OpsError>;
    /// The TypeScript type of (each of) its parameters.
    fn ts(types: &mut TsTypes) -> String;
}

/// A parameter of a recording method.
#[derive(Debug, Clone)]
pub struct OpParam {
    /// Its JS name.
    pub name: &'static str,
    /// Its TypeScript type.
    pub ts: String,
    /// Its JS default (`None`: required).
    pub default: Option<&'static str>,
}

/// A method that pushes its code and its arguments as they are.
#[derive(Debug, Clone)]
pub struct OpMethod {
    /// Its JS name.
    pub name: &'static str,
    /// The operation's code.
    pub code: i32,
    /// Its parameters, pushed in order.
    pub params: Vec<OpParam>,
    /// Documentation.
    pub doc: &'static str,
}

/// A state property: reading it gives the kept value, setting it keeps
/// the value and pushes its code and the value.
#[derive(Debug, Clone)]
pub struct OpProperty {
    /// Its JS name.
    pub name: &'static str,
    /// The operation's code.
    pub code: i32,
    /// Its TypeScript type.
    pub ts: String,
    /// Its initial value (JS).
    pub initial: &'static str,
    /// Documentation.
    pub doc: &'static str,
}

/// An enum of recorded operations (`#[derive(JsOps)]`).
pub trait JsOps: Sized {
    /// What reading the arguments needs.
    type Cx;
    /// The operation with code `code`, its arguments read from `r`:
    /// `None` for a code that is not one of these operations, `Some(None)`
    /// for one that is dropped.
    fn decode<L: HostList<Item: HostInput>>(
        code: i32,
        r: &mut OpReader<'_, L>,
        cx: &mut Self::Cx,
    ) -> Result<Option<Option<Self>>, OpsError>;
    /// The methods recording these operations as they are (not those of
    /// nested enums).
    fn methods(types: &mut TsTypes, out: &mut Vec<OpMethod>);
    /// The properties recording them.
    fn properties(types: &mut TsTypes, out: &mut Vec<OpProperty>);
}

/// Values of another type are 0.
impl<Cx> OpArg<Cx> for f32 {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        _: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        Ok(Some(r.arg()?.as_number().map_or(0.0, |n| n as f32)))
    }

    fn ts(_: &mut TsTypes) -> String {
        "number".into()
    }
}

/// A number, or nothing (`maxWidth`).
impl<Cx> OpArg<Cx> for Option<f32> {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        _: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        Ok(Some(r.arg()?.as_number().map(|n| n as f32)))
    }

    fn ts(_: &mut TsTypes) -> String {
        "number".into()
    }
}

/// Values of another type are false.
impl<Cx> OpArg<Cx> for bool {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        _: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        Ok(Some(r.arg()?.as_bool().unwrap_or(false)))
    }

    fn ts(_: &mut TsTypes) -> String {
        "boolean".into()
    }
}

/// Values of another type are the empty string.
impl<Cx> OpArg<Cx> for Arc<str> {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        _: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        Ok(Some(r.arg()?.as_string().unwrap_or_default().into()))
    }

    fn ts(_: &mut TsTypes) -> String {
        "string".into()
    }
}

/// `N` arguments of type `T` (one parameter each).
impl<Cx, T: OpArg<Cx> + Copy + Default, const N: usize> OpArg<Cx> for [T; N] {
    const ARITY: usize = N * T::ARITY;

    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        cx: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        let mut out = [T::default(); N];
        let mut kept = true;
        for v in &mut out {
            match T::read(r, cx)? {
                Some(read) => *v = read,
                None => kept = false,
            }
        }
        Ok(kept.then_some(out))
    }

    fn ts(types: &mut TsTypes) -> String {
        T::ts(types)
    }
}

/// An argument read as a host value (one of a string union and the
/// like); `None` when it does not take the value.
pub(crate) fn host_value<T: HostValue, L: HostList<Item: HostInput>>(
    r: &mut OpReader<'_, L>,
) -> Result<Option<T>, OpsError> {
    let item = r.arg()?;
    Ok(T::decode(&item, &mut HostCx::default()))
}
