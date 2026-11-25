//! Tiptap's table node specs (prosemirror-tables' `tableNodes`): `table`,
//! `tableRow`, `tableCell` and `tableHeader`, with their table roles, the
//! cells' `colspan`, `rowspan` and `colwidth`, the rows' `height`, and
//! their HTML (`<table><colgroup>…</colgroup><tbody><tr><td colspan
//! rowspan data-colwidth>`, `<th>`).
//!
//! Ported from prosemirror-tables (MIT, © Marijn Haverbeke and others)
//! and Tiptap's `@tiptap/extension-table` (MIT, © Tiptap GmbH).

use serde_json::Value;

use super::{TableRole, map::width_json};
use crate::rich_editor::model::{
    AttrParse, AttrSpec, Attrs, DomElement, DomNode, DomOutputSpec, NodeSpec, ParseRule, Whitespace,
};

// An attribute the type's `to_dom` and `parse_dom` handle themselves.
fn attr(default: Value) -> AttrSpec {
    AttrSpec {
        default: Some(default),
        rendered: false,
        parse_html: Some(AttrParse::Skip),
        ..Default::default()
    }
}

fn extra(role: TableRole) -> Attrs {
    [("tableRole".to_owned(), Value::from(role.name()))].into()
}

/// The table's options its spec reads (the `table` extension's): `HTMLAttributes`
/// written on `<table>`, `cellMinWidth` (25) for the `min-width` of columns
/// without a width, and what the view reads from the spec's `extra`:
/// `resizable` (true), `lastColumnResizable` (true) and `cellMinWidth`.
pub fn table(options: &Value) -> (String, NodeSpec) {
    let cell_min_width = options
        .get("cellMinWidth")
        .and_then(Value::as_f64)
        .unwrap_or(25.0);
    let html_attributes: Vec<(String, Value)> = options
        .get("HTMLAttributes")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let mut extra = extra(TableRole::Table);
    // The editor's view lays it out as a grid.
    extra.insert("render".into(), Value::from("table"));
    extra.insert("cellMinWidth".into(), Value::from(cell_min_width));
    for (key, default) in [("resizable", true), ("lastColumnResizable", true)] {
        let value = options.get(key).and_then(Value::as_bool).unwrap_or(default);
        extra.insert(key.into(), Value::Bool(value));
    }
    (
        "table".into(),
        NodeSpec {
            to_dom: Some(DomOutputSpec::render(move |src| {
                let mut table = DomOutputSpec::tag("table");
                for (key, value) in &html_attributes {
                    table = table.attr(key.clone(), value.clone());
                }
                // Tiptap's `createColGroup`: a column per slot of the first
                // row, with its width, or the minimum width.
                let widths = match src {
                    crate::rich_editor::model::DomSource::Node(node) => first_row_widths(node),
                    _ => Vec::new(),
                };
                let total: f64 = widths.iter().map(|w| w.unwrap_or(cell_min_width)).sum();
                let fixed = widths.iter().all(Option::is_some) && !widths.is_empty();
                let style = if fixed {
                    format!("width: {}px", width_text(total))
                } else {
                    format!("min-width: {}px", width_text(total))
                };
                table = table.attr("style", style);
                let mut colgroup = DomOutputSpec::tag("colgroup");
                for width in &widths {
                    let col = match width {
                        Some(w) => DomOutputSpec::tag("col")
                            .attr("style", format!("width: {}px", width_text(*w))),
                        None => DomOutputSpec::tag("col").attr(
                            "style",
                            format!("min-width: {}px", width_text(cell_min_width)),
                        ),
                    };
                    colgroup = colgroup.child(col);
                }
                table
                    .child(colgroup)
                    .child(DomOutputSpec::tag("tbody").hole())
            })),
            parse_dom: vec![ParseRule::tag("table")],
            content: Some("tableRow+".into()),
            group: Some("block".into()),
            isolating: true,
            extra,
            ..Default::default()
        },
    )
}

fn width_text(width: f64) -> String {
    width_json(width).to_string()
}

// The widths of the columns of a table's first row (none for a column
// without one).
fn first_row_widths(table: &crate::rich_editor::model::Node) -> Vec<Option<f64>> {
    let mut widths = Vec::new();
    let Some(row) = table.first_child() else {
        return widths;
    };
    for i in 0..row.child_count() {
        let cell = row.child(i);
        let span = super::colspan(cell);
        let colwidth = super::map::colwidth(cell);
        for j in 0..span {
            widths.push(
                colwidth
                    .as_ref()
                    .and_then(|c| c.get(j).copied())
                    .filter(|w| *w > 0.0),
            );
        }
    }
    widths
}

/// A row of cells (`tableRow`), with a `height` (null: as tall as its
/// content; points, set by resizing it in the view), written as `<tr
/// style="height: …px">`.
pub fn table_row() -> (String, NodeSpec) {
    (
        "tableRow".into(),
        NodeSpec {
            to_dom: Some(DomOutputSpec::render(|src| {
                let height = src.attr("height").and_then(Value::as_f64);
                DomOutputSpec::tag("tr")
                    .attr(
                        "style",
                        height.map(|h| format!("height: {}px", width_text(h))),
                    )
                    .hole()
            })),
            parse_dom: vec![ParseRule::tag("tr").with_get_attrs(|input| {
                let tr = input.element()?;
                let height = tr
                    .style("height")
                    .and_then(|h| h.trim().trim_end_matches("px").trim().parse::<f64>().ok())
                    .filter(|h| *h > 0.0);
                let mut attrs = Attrs::new();
                attrs.insert("height".into(), height.map_or(Value::Null, width_json));
                Some(attrs)
            })],
            content: Some("(tableCell | tableHeader)*".into()),
            attrs: vec![("height".into(), attr(Value::Null))],
            extra: extra(TableRole::Row),
            ..Default::default()
        },
    )
}

// Supported cell alignment values (Tiptap's `normalizeTableCellAlign`).
fn normalize_align(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "left" => Some("left"),
        "right" => Some("right"),
        "center" => Some("center"),
        _ => None,
    }
}

// Whether a cell/header element has no child elements and only ASCII
// collapsible whitespace (Tiptap's `isEmptyCellElement`), so `&nbsp;` is
// preserved while blank whitespace backfills to an empty paragraph.
fn is_empty_cell_element(el: &DomElement) -> bool {
    el.children().iter().all(|child| match child {
        DomNode::Text(text) => text
            .chars()
            .all(|c| matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{000C}')),
        DomNode::Comment => true,
        DomNode::Element(_) => false,
    })
}

// A cell type: `tableCell` (`<td>`) or `tableHeader` (`<th>`).
fn cell(name: &str, tag: &'static str, role: TableRole) -> (String, NodeSpec) {
    (
        name.into(),
        NodeSpec {
            to_dom: Some(DomOutputSpec::render(move |src| {
                let span = |name: &str| src.attr(name).and_then(Value::as_u64).filter(|n| *n != 1);
                let colwidth = src.attr("colwidth").and_then(Value::as_array).map(|w| {
                    w.iter()
                        .map(|w| w.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                });
                let align_style = src
                    .attr("align")
                    .and_then(Value::as_str)
                    .and_then(normalize_align)
                    .map(|a| format!("text-align: {a};"));
                DomOutputSpec::tag(tag)
                    .attr("colspan", span("colspan"))
                    .attr("rowspan", span("rowspan"))
                    .attr("data-colwidth", colwidth)
                    .attr("style", align_style)
                    .hole()
            })),
            parse_dom: vec![
                // Backfill empty / ASCII-whitespace-only cells even under
                // `Whitespace::Full` (Tiptap's `isEmptyCellElement`).
                ParseRule {
                    preserve_whitespace: Some(Whitespace::Collapse),
                    ..ParseRule::tag(tag)
                }
                .with_get_attrs(|input| {
                    let el = input.element()?;
                    is_empty_cell_element(el).then(|| cell_attrs(el))
                }),
                ParseRule::tag(tag).with_get_attrs(|input| Some(cell_attrs(input.element()?))),
            ],
            content: Some("block+".into()),
            isolating: true,
            attrs: vec![
                ("colspan".into(), attr(Value::from(1))),
                ("rowspan".into(), attr(Value::from(1))),
                ("colwidth".into(), attr(Value::Null)),
                ("align".into(), attr(Value::Null)),
            ],
            extra: extra(role),
            ..Default::default()
        },
    )
}

/// A cell's attributes read from its `<td>` / `<th>`: `colspan`,
/// `rowspan`, `colwidth` from `data-colwidth` (or Tiptap's `colwidth`,
/// comma-separated widths), and `align` from `text-align` style or legacy
/// `align` attribute.
fn cell_attrs(el: &DomElement) -> Attrs {
    let span = |name: &str| {
        el.attr(name)
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|n| *n >= 1)
            .unwrap_or(1)
    };
    let colspan = span("colspan");
    let colwidth = el
        .attr("data-colwidth")
        .or_else(|| el.attr("colwidth"))
        .and_then(|value| {
            let widths: Vec<f64> = value
                .split(',')
                .map(|w| w.trim().parse::<f64>().unwrap_or(0.0))
                .collect();
            (!widths.is_empty() && widths.iter().any(|w| *w > 0.0))
                .then(|| Value::Array(widths.into_iter().map(width_json).collect()))
        });
    let align = el
        .style("text-align")
        .as_deref()
        .and_then(normalize_align)
        .or_else(|| el.attr("align").and_then(normalize_align))
        .map_or(Value::Null, Value::from);
    let mut attrs = Attrs::new();
    attrs.insert("colspan".into(), Value::from(colspan));
    attrs.insert("rowspan".into(), Value::from(span("rowspan")));
    attrs.insert("colwidth".into(), colwidth.unwrap_or(Value::Null));
    attrs.insert("align".into(), align);
    attrs
}

/// A cell (`tableCell`, `<td>`): blocks, `colspan` and `rowspan` (1),
/// `colwidth` (null, or a width in points per spanned column, 0 for
/// none).
pub fn table_cell() -> (String, NodeSpec) {
    cell("tableCell", "td", TableRole::Cell)
}

/// A header cell (`tableHeader`, `<th>`), as [`table_cell`].
pub fn table_header() -> (String, NodeSpec) {
    cell("tableHeader", "th", TableRole::HeaderCell)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_util::*;
    use crate::rich_editor::{
        formats::{DomParser, DomSerializer, ParseOptions},
        model::Fragment,
    };

    #[test]
    fn tables_are_written_as_html() {
        let s = schema();
        let mut attrs = crate::rich_editor::model::Attrs::new();
        attrs.insert("colwidth".into(), json!([100]));
        let wide = s
            .node(
                "tableHeader",
                Some(attrs),
                Fragment::from(vec![p("a")]),
                vec![],
            )
            .unwrap();
        let t = table(vec![tr(vec![wide, th("b")]), tr(vec![tds("c", 2, 1)])]);
        let html = DomSerializer::from_schema(&s).serialize_node(&t);
        assert_eq!(
            html,
            "<table style=\"min-width: 125px;\"><colgroup><col style=\"width: 100px;\"><col \
             style=\"min-width: 25px;\"></colgroup><tbody><tr><th \
             data-colwidth=\"100\"><p>a</p></th><th><p>b</p></th></tr><tr><td \
             colspan=\"2\"><p>c</p></td></tr></tbody></table>"
        );
    }

    /// A copied row is wrapped in the table and body HTML needs around it,
    /// counted in `data-pm-slice`, and read back as the row.
    #[test]
    fn copied_table_rows_are_wrapped_and_read_back() {
        let s = schema();
        let row = tr(vec![td("a"), td("b")]);
        let slice = crate::rich_editor::model::Slice::new(Fragment::from(row.clone()), 0, 0);
        let html = DomSerializer::from_schema(&s).serialize_for_clipboard(&slice);
        assert_eq!(
            html,
            "<table data-pm-slice=\"0 0 -2 []\"><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>"
        );
        let d = doc(vec![table(vec![tr(vec![td("x"), td("y")])])]);
        let at = d.resolve(in_cell(&d, "x")).unwrap();
        let back = DomParser::from_schema(&s).parse_from_clipboard(&html, &at);
        assert_eq!(back.content.child_count(), 1);
        assert_eq!(back.content.child(0), &row, "{:?}", back.content);
        assert_eq!((back.open_start, back.open_end), (0, 0));
    }

    #[test]
    fn tables_are_read_from_html() {
        let s = schema();
        let html = "<table><colgroup><col></colgroup><tbody><tr style=\"height: 40px\"><th \
                    colspan=\"2\" data-colwidth=\"100,50\">a</th></tr><tr><td>b</td><td \
                    rowspan=\"1\">c</td></tr></tbody></table>";
        let d = DomParser::from_schema(&s).parse(html, &ParseOptions::default());
        let t = first_table(&d);
        assert_eq!(shape(&t), "*a(2,1)/b|c");
        assert_eq!(t.child(0).child(0).attrs()["colwidth"], json!([100, 50]));
        assert_eq!(t.child(0).attrs()["height"], json!(40));
        assert_eq!(t.child(1).attrs()["height"], serde_json::Value::Null);
    }

    #[test]
    fn colwidth_colgroup_align_and_empty_cells_follow_tiptap() {
        let s = schema();
        let parser = DomParser::from_schema(&s);
        let ser = DomSerializer::from_schema(&s);

        // Single and multiple colwidth (even when fewer widths than colspan).
        let d = parser.parse(
            r#"<table><tbody><tr><td colwidth="200">A</td><td colspan="3" colwidth="150,100">B</td></tr></tbody></table>"#,
            &ParseOptions::default(),
        );
        let row = first_table(&d).child(0).clone();
        assert_eq!(row.child(0).attrs()["colwidth"], json!([200]));
        assert_eq!(row.child(1).attrs()["colwidth"], json!([150, 100]));

        // <colgroup><col width> fallback and cell colwidth priority.
        let d = parser.parse(
            r#"<table><colgroup><col width="64" /><col width="128" /></colgroup><tbody><tr><th colwidth="200">H1</th><th>H2</th></tr><tr><td>C1</td><td>C2</td></tr></tbody></table>"#,
            &ParseOptions::default(),
        );
        let t = first_table(&d);
        assert_eq!(t.child(0).child(0).attrs()["colwidth"], json!([200]));
        assert_eq!(t.child(0).child(1).attrs()["colwidth"], json!([128]));
        assert_eq!(t.child(1).child(0).attrs()["colwidth"], json!([64]));
        assert_eq!(t.child(1).child(1).attrs()["colwidth"], json!([128]));

        // Cell align: allowed values serialize to text-align; invalid values are omitted.
        let valid_doc = s
            .node_from_json(&json!({
                "type": "doc",
                "content": [{
                    "type": "table",
                    "content": [{
                        "type": "tableRow",
                        "content": [{
                            "type": "tableCell",
                            "attrs": { "align": "center" },
                            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "x" }] }]
                        }]
                    }]
                }]
            }))
            .unwrap();
        assert!(
            ser.serialize_node(&valid_doc)
                .contains(r#"style="text-align: center;""#)
        );

        let invalid_doc = s
            .node_from_json(&json!({
                "type": "doc",
                "content": [{
                    "type": "table",
                    "content": [{
                        "type": "tableRow",
                        "content": [{
                            "type": "tableCell",
                            "attrs": { "align": "left; position: fixed" },
                            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "x" }] }]
                        }]
                    }]
                }]
            }))
            .unwrap();
        let out = ser.serialize_node(&invalid_doc);
        assert!(!out.contains("text-align"));
        assert!(!out.contains("position"));

        // Whitespace-only cells backfill to empty paragraphs even under insert parsing,
        // while &nbsp; is preserved.
        let ws =
            parser.parse_insert_fragment("<table><tr><td>   </td><td>&nbsp;</td></tr></table>");
        let row = ws.child(0).child(0);
        assert_eq!(row.child(0).child(0).text_content(), "");
        assert_eq!(row.child(1).child(0).text_content(), "\u{00A0}");
    }
}
