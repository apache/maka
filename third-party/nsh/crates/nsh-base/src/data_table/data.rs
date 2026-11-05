//! [`DataTableRows`]: the rows of a table's `data`, read once from JS into
//! columns, so the table draws any cell without calling JS.
//!
//! A row is an object whose fields are the columns' `key`s, or an array
//! indexed by the columns' positions. Numbers, booleans and strings are
//! kept (a date as the milliseconds it is, a number); anything else is a
//! gap. A Rust app gives the same rows a column at a time, each of one
//! type ([`DataTableRows::new`], then [`DataTableRows::texts`],
//! [`DataTableRows::numbers`], [`DataTableRows::bools`]), as the core's
//! `Rows::from_columns` does.

use std::{collections::HashMap, sync::Arc};

use nsh_core::element::{
    JsHost, JsIn, JsKind, JsOwned, JsPrimitive, JsValue, PropError, SharedString, TsTypes,
};

/// What a cell holds.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) enum Cell {
    #[default]
    Empty,
    Number(f64),
    Bool(bool),
    Text(Arc<str>),
}

impl Cell {
    /// The text a cell shows: numbers without a trailing `.0`, booleans as
    /// words, a gap as nothing.
    pub(crate) fn text(&self) -> SharedString {
        match self {
            Cell::Empty => SharedString::default(),
            Cell::Number(n) => format_number(*n).into(),
            Cell::Bool(b) => if *b { "true" } else { "false" }.into(),
            Cell::Text(s) => SharedString::from(s.as_ref().to_owned()),
        }
    }

    /// Whether it holds a rise (`Some(true)`) or a fall (`Some(false)`).
    pub(crate) fn sign(&self) -> Option<bool> {
        match self {
            Cell::Number(n) if *n > 0.0 => Some(true),
            Cell::Number(n) if *n < 0.0 => Some(false),
            Cell::Text(s) if s.starts_with('+') => Some(true),
            Cell::Text(s) if s.starts_with('-') || s.starts_with('\u{2212}') => Some(false),
            _ => None,
        }
    }

    /// The text for width measuring and export, without making a shared
    /// string.
    pub(crate) fn write_to(&self, out: &mut String) {
        match self {
            Cell::Empty => {}
            Cell::Number(n) => out.push_str(&format_number(*n)),
            Cell::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Cell::Text(s) => out.push_str(s),
        }
    }
}

fn format_number(n: f64) -> String {
    if n.is_nan() {
        String::new()
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The rows of a table: columns of cells by field name and by position.
#[derive(Debug, Clone, Default)]
pub struct DataTableRows {
    len: usize,
    /// Columns by the field of object rows they hold.
    named: Vec<Vec<Cell>>,
    names: HashMap<String, usize>,
    /// Columns by position of array rows.
    indexed: Vec<Vec<Cell>>,
}

impl DataTableRows {
    /// `len` rows with no fields yet: [`Self::texts`], [`Self::numbers`]
    /// and [`Self::bools`] give them their columns, by the columns' `key`s.
    pub fn new(len: usize) -> Self {
        Self {
            len,
            ..Default::default()
        }
    }

    /// The field `key` of the rows: `values` in order, a text each (the
    /// rows past them have none; values past the rows are left out).
    /// A text starting with `+` is a rise and one starting with `-` or `−`
    /// a fall, as from JS (the column's `positive_class` / `negative_class`).
    pub fn texts(mut self, key: &str, values: impl IntoIterator<Item = impl AsRef<str>>) -> Self {
        self.set_column(
            key,
            values.into_iter().map(|v| Cell::Text(v.as_ref().into())),
        );
        self
    }

    /// The field `key` of the rows: `values` in order, a number each,
    /// shown as JS shows numbers; a positive one is a rise and a negative
    /// one a fall (the column's `positive_class` / `negative_class`),
    /// `NaN` a gap.
    pub fn numbers(mut self, key: &str, values: impl IntoIterator<Item = f64>) -> Self {
        self.set_column(
            key,
            values.into_iter().map(|n| {
                if n.is_nan() {
                    Cell::Empty
                } else {
                    Cell::Number(n)
                }
            }),
        );
        self
    }

    /// The field `key` of the rows: `values` in order, shown as `true` or
    /// `false`.
    pub fn bools(mut self, key: &str, values: impl IntoIterator<Item = bool>) -> Self {
        self.set_column(key, values.into_iter().map(Cell::Bool));
        self
    }

    /// The column of field `key` made of `cells`, in place of what it held.
    fn set_column(&mut self, key: &str, cells: impl Iterator<Item = Cell>) {
        let len = self.len;
        let column = self.named_column(key);
        column.clear();
        column.extend(cells.take(len));
        column.resize(len, Cell::Empty);
    }

    /// How many rows there are.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The cell of `row` (0-based among the rows given) for a column named
    /// `key` that is at `position` among the columns.
    pub(crate) fn cell(&self, row: usize, key: &str, position: usize) -> &Cell {
        static EMPTY: Cell = Cell::Empty;
        let column = match self.names.get(key) {
            Some(&c) => self.named.get(c),
            None => self.indexed.get(position),
        };
        column.and_then(|c| c.get(row)).unwrap_or(&EMPTY)
    }

    fn named_column(&mut self, key: &str) -> &mut Vec<Cell> {
        let at = match self.names.get(key) {
            Some(&at) => at,
            None => {
                self.named.push(vec![Cell::Empty; self.len]);
                self.names.insert(key.to_owned(), self.named.len() - 1);
                self.named.len() - 1
            }
        };
        &mut self.named[at]
    }

    fn indexed_column(&mut self, position: usize) -> &mut Vec<Cell> {
        while self.indexed.len() <= position {
            self.indexed.push(vec![Cell::Empty; self.len]);
        }
        &mut self.indexed[position]
    }

    /// Rows made of `rows`, each a list of cells by position.
    #[cfg(test)]
    pub(crate) fn from_arrays(rows: Vec<Vec<Cell>>) -> DataTableRows {
        let mut data = DataTableRows {
            len: rows.len(),
            ..Default::default()
        };
        for (r, row) in rows.into_iter().enumerate() {
            for (c, cell) in row.into_iter().enumerate() {
                data.indexed_column(c)[r] = cell;
            }
        }
        data
    }

    /// Rows made of `rows`, each a list of (field, cell).
    #[cfg(test)]
    pub(crate) fn from_objects(rows: Vec<Vec<(&str, Cell)>>) -> DataTableRows {
        let mut data = DataTableRows {
            len: rows.len(),
            ..Default::default()
        };
        for (r, row) in rows.into_iter().enumerate() {
            for (key, cell) in row {
                data.named_column(key)[r] = cell;
            }
        }
        data
    }
}

impl PartialEq for DataTableRows {
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len
            && self.named == other.named
            && self.indexed == other.indexed
            && self.names == other.names
    }
}

fn cell_of(value: JsPrimitive) -> Cell {
    match value {
        JsPrimitive::Number(n) | JsPrimitive::Date(n) => Cell::Number(n),
        JsPrimitive::Bool(b) => Cell::Bool(b),
        JsPrimitive::String(s) => Cell::Text(s.into()),
        _ => Cell::Empty,
    }
}

impl JsValue for DataTableRows {
    fn ts_type(_types: &mut TsTypes) -> String {
        "T[]".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let len = value
            .array_len()?
            .ok_or_else(|| value.expected("an array of rows"))?;
        let mut data = DataTableRows {
            len,
            ..Default::default()
        };
        for r in 0..len {
            let row = value.index(r)?;
            let row = row.get();
            // A row's cells are read in one call: a page of a wide table
            // holds thousands, and the browser crosses into JS per call.
            match row.kind() {
                JsKind::Array => {
                    for (c, cell) in row
                        .primitives()?
                        .unwrap_or_default()
                        .into_iter()
                        .enumerate()
                    {
                        let cell = cell_of(cell);
                        if cell != Cell::Empty {
                            data.indexed_column(c)[r] = cell;
                        }
                    }
                }
                JsKind::Object => {
                    for (key, cell) in row.primitive_entries()? {
                        let cell = cell_of(cell);
                        if cell != Cell::Empty {
                            data.named_column(&key)[r] = cell;
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(data)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        // Rows as objects of their named fields (array rows by position).
        let mut rows = Vec::with_capacity(self.len);
        for r in 0..self.len {
            let row = JsOwned::new(host, host.new_object()?);
            let named = self.names.iter().map(|(k, &c)| (k.clone(), &self.named[c]));
            let indexed = self
                .indexed
                .iter()
                .enumerate()
                .map(|(i, c)| (i.to_string(), c));
            for (key, column) in named.chain(indexed) {
                let raw = match &column[r] {
                    Cell::Empty => continue,
                    Cell::Number(n) => host.new_number(*n),
                    Cell::Bool(b) => host.new_bool(*b),
                    Cell::Text(s) => host.new_string(s)?,
                };
                host.set_field(row.get().raw(), &key, raw)?;
            }
            rows.push(row);
        }
        let raws = rows.into_iter().map(JsOwned::into_raw).collect();
        Ok(JsOwned::new(host, host.new_array(raws)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(Cell::Number(3.0).text(), "3");
        assert_eq!(Cell::Number(-0.5).text(), "-0.5");
        assert_eq!(Cell::Number(f64::NAN).text(), "");
        assert_eq!(Cell::Bool(true).text(), "true");
        assert_eq!(Cell::Empty.text(), "");
    }

    #[test]
    fn rust_columns_fill_their_rows() {
        let rows = DataTableRows::new(3)
            .texts("symbol", ["AAPL", "MSFT", "NVDA", "past the rows"])
            .numbers("change", [1.2, -0.4, f64::NAN])
            .bools("open", [true])
            .numbers("change", [0.5]);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows.cell(2, "symbol", 0).text(), "NVDA");
        assert_eq!(
            rows.cell(0, "change", 0),
            &Cell::Number(0.5),
            "given again: replaced"
        );
        assert_eq!(rows.cell(1, "change", 0), &Cell::Empty);
        assert_eq!(rows.cell(0, "open", 0).text(), "true");
        assert_eq!(rows.cell(2, "open", 0), &Cell::Empty);
        assert_eq!(rows.cell(0, "missing", 5), &Cell::Empty);
        let signs = DataTableRows::new(2).numbers("change", [1.2, -0.4]);
        assert_eq!(signs.cell(0, "change", 0).sign(), Some(true));
        assert_eq!(signs.cell(1, "change", 0).sign(), Some(false));
        let owned = ["+1.2%".to_owned(), "\u{2212}0.4%".to_owned()];
        let borrowed = DataTableRows::new(2).texts("change", owned.iter().map(String::as_str));
        assert_eq!(borrowed.cell(0, "change", 0).text(), "+1.2%");
        assert_eq!(borrowed.cell(0, "change", 0).sign(), Some(true));
        assert_eq!(borrowed.cell(1, "change", 0).sign(), Some(false));
    }

    #[test]
    fn cells_are_found_by_key_or_position() {
        let objects = DataTableRows::from_objects(vec![
            vec![("a", Cell::Number(1.0)), ("b", Cell::Text("x".into()))],
            vec![("b", Cell::Text("y".into()))],
        ]);
        assert_eq!(objects.len(), 2);
        assert_eq!(objects.cell(0, "a", 7), &Cell::Number(1.0));
        assert_eq!(objects.cell(1, "a", 0), &Cell::Empty);
        assert_eq!(objects.cell(1, "b", 0).text(), "y");
        assert_eq!(objects.cell(9, "b", 0), &Cell::Empty);
        let arrays = DataTableRows::from_arrays(vec![
            vec![Cell::Number(1.0), Cell::Text("x".into())],
            vec![Cell::Number(2.0)],
        ]);
        assert_eq!(arrays.cell(1, "anything", 0), &Cell::Number(2.0));
        assert_eq!(arrays.cell(0, "anything", 1).text(), "x");
        assert_eq!(arrays.cell(1, "anything", 1), &Cell::Empty);
    }
}
