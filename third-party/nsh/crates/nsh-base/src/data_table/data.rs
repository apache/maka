//! [`DataTableRows`]: the rows of a table's `data`, read once from JS into
//! columns, so the table draws any cell without calling JS.
//!
//! A row is an object whose fields are the columns' `key`s, or an array
//! indexed by the columns' positions. Numbers, booleans and strings are
//! kept (a date as the milliseconds it is, a number); anything else is a
//! gap.

use std::{collections::HashMap, sync::Arc};

use nsh_core::element::{JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, SharedString, TsTypes};

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

fn cell_of(value: JsIn<'_>) -> Cell {
    match value.kind() {
        JsKind::Number => value.as_number().map_or(Cell::Empty, Cell::Number),
        JsKind::Bool => value.as_bool().map_or(Cell::Empty, Cell::Bool),
        JsKind::String => value
            .as_string()
            .map_or(Cell::Empty, |s| Cell::Text(s.into())),
        _ => value.as_date().map_or(Cell::Empty, Cell::Number),
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
            match row.kind() {
                JsKind::Array => {
                    let n = row.array_len()?.unwrap_or(0);
                    for c in 0..n {
                        let cell = cell_of(row.index(c)?.get());
                        if cell != Cell::Empty {
                            data.indexed_column(c)[r] = cell;
                        }
                    }
                }
                JsKind::Object => {
                    for key in row.keys()? {
                        let cell = cell_of(row.field(&key)?.get());
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
