//! Serializer cases after `prosemirror-model`'s `test-dom.ts` and Tiptap's
//! `getHTML`, on the starter schema (read from HTML, so they keep to the
//! schema's names whatever they are) and on schemas from JSON.

#![allow(clippy::field_reassign_with_default)]

use serde_json::json;

use super::*;
use crate::rich_editor::{
    extensions::starter,
    model::{AttrSpec, MarkSpec, NodeSpec, SchemaSpec},
};

fn read(html: &str) -> Node {
    let schema = starter::schema();
    let doc = DomParser::from_schema(&schema).parse(html, &ParseOptions::default());
    doc.check().expect("a valid document");
    doc
}

/// `html` read and written back gives `expected`, and that reads back
/// into the same document.
fn round_trip(html: &str, expected: &str) {
    let doc = read(html);
    let out = doc_to_html(&doc);
    assert_eq!(out, expected);
    let again = read(&out);
    // Each read builds its own starter schema, so compare the JSON.
    assert_eq!(
        again.to_json(),
        doc.to_json(),
        "{out} reads back differently"
    );
}

#[test]
fn every_starter_node() {
    round_trip("<p>a</p>", "<p>a</p>");
    round_trip("<h2>t</h2><h6>u</h6>", "<h2>t</h2><h6>u</h6>");
    round_trip(
        "<blockquote><p>q</p></blockquote>",
        "<blockquote><p>q</p></blockquote>",
    );
    round_trip("<hr>", "<hr>");
    round_trip("<p>a<br>b</p>", "<p>a<br>b</p>");
    round_trip(
        r#"<p><img src="x.png" alt="X"></p>"#,
        r#"<p><img src="x.png" alt="X"></p>"#,
    );
    round_trip(
        "<pre><code class=\"language-rust\">fn x() {\n  1\n}</code></pre><pre><code>plain</code></pre>",
        "<pre><code class=\"language-rust\">fn x() {\n  1\n}</code></pre><pre><code>plain</code></pre>",
    );
    round_trip(
        "<ul><li><p>a</p></li><li><p>b</p><ol start=\"3\"><li><p>c</p></li></ol></li></ul><ol><li><p>d</p></li></ol>",
        "<ul><li><p>a</p></li><li><p>b</p><ol start=\"3\"><li><p>c</p></li></ol></li></ul><ol><li><p>d</p></li></ol>",
    );
}

#[test]
fn every_starter_mark() {
    round_trip(
        r#"<p><strong>b</strong><em>i</em><s>s</s><u>u</u><code>c</code><a href="/x" title="T">l</a></p>"#,
        r#"<p><strong>b</strong><em>i</em><s>s</s><u>u</u><code>c</code><a href="/x" title="T">l</a></p>"#,
    );
}

#[test]
fn marks_open_and_close_minimally() {
    // Common marks stay open across texts; the rest close and reopen.
    round_trip(
        "<p><em>a<strong>b</strong>c</em>d</p>",
        "<p><em>a<strong>b</strong>c</em>d</p>",
    );
    // Marks open in schema order: an outer mark of later rank reopens.
    assert_eq!(
        doc_to_html(&read("<p><strong>a<em>b</em></strong></p>")),
        "<p><strong>a</strong><em><strong>b</strong></em></p>"
    );
    let doc = read("<p><em><strong>x</strong>y</em></p>");
    let out = doc_to_html(&doc);
    let again = read(&out);
    assert_eq!(again.to_json(), doc.to_json(), "{out}");
}

#[test]
fn escapes_text_and_attributes() {
    round_trip(
        r#"<p><a href="/a?b=1&amp;c=&quot;2&quot;">&lt;tag&gt; &amp; more</a></p>"#,
        r#"<p><a href="/a?b=1&amp;c=&quot;2&quot;">&lt;tag&gt; &amp; more</a></p>"#,
    );
}

#[test]
fn serialize_node_wraps_its_marks() {
    let doc = read("<p><strong>x</strong></p>");
    let ser = DomSerializer::from_schema(doc.ty().schema());
    let text = doc.child(0).child(0);
    assert_eq!(ser.serialize_node(text), "<strong>x</strong>");
    assert_eq!(
        ser.serialize_node(doc.child(0)),
        "<p><strong>x</strong></p>"
    );
}

#[test]
fn html_format_round_trips() {
    let schema = starter::schema();
    let f = HtmlFormat::default();
    let doc = f.parse(&schema, "<h1>T</h1><p>a <em>b</em></p>").unwrap();
    let html = f.serialize(&doc).unwrap();
    assert_eq!(html, "<h1>T</h1><p>a <em>b</em></p>");
    assert!(f.parse(&schema, &html).unwrap().eq(&doc));
    assert!(!f.is_lossless_for(&schema));
}

fn json_schema() -> Schema {
    SchemaSpec::from_json(&json!({
        "nodes": [
            ["doc", {"content": "block+"}],
            ["note", {"content": "inline*", "group": "block",
                "attrs": [["tone", {"default": "info"}], ["color", {"default": null,
                    "parseHTML": {"style": "color"}, "renderHTML": {"style": "color"}}],
                    ["id", {"default": null, "parseHTML": "data-id", "renderHTML": "data-id"}],
                    ["secret", {"default": "s", "renderHTML": "data-secret", "rendered": false}],
                    ["quiet", {"default": "q", "renderHTML": false, "parseHTML": false}]],
                "parseDOM": [{"tag": "aside"}],
                "toDOM": ["aside", {"class": "note", "data-tone": {"attr": "tone"}}, ["div", 0]]}],
            ["chip", {"inline": true, "group": "inline", "attrs": {"label": {"default": "?"}},
                "toDOM": ["span", {"class": "chip"}, {"attr": "label"}]}],
            ["plain", {"content": "inline*", "group": "block"}],
            ["dot", {"inline": true, "group": "inline"}],
            ["text", {"group": "inline"}]
        ],
        "marks": [
            ["tag", {"attrs": {"cls": {"default": "x", "renderHTML": "class"}},
                "toDOM": ["mark", {"class": "base"}, 0]}],
            ["bare", {}],
            ["flat", {"spanning": false, "toDOM": ["b", 0]}]
        ]
    }))
    .unwrap()
}

#[test]
fn data_specs_interpolate_and_merge_attributes() {
    let s = json_schema();
    let mut attrs = crate::rich_editor::model::Attrs::new();
    attrs.insert("tone".into(), json!("warn"));
    attrs.insert("color".into(), json!("red"));
    attrs.insert("id".into(), json!(7));
    let chip = s.node("chip", None, Fragment::empty(), vec![]).unwrap();
    let tag = s.mark("tag", None).unwrap();
    let content = Fragment::from(vec![s.text("a", vec![tag.clone()]), chip]);
    let note = s.node("note", Some(attrs), content, vec![]).unwrap();
    let doc = s
        .node("doc", None, Fragment::from(vec![note]), vec![])
        .unwrap();
    assert_eq!(
        doc_to_html(&doc),
        r#"<aside class="note" data-tone="warn" tone="warn" style="color: red" data-id="7"><div><mark class="base x">a</mark><span class="chip" label="?">?</span></div></aside>"#
    );
    // `parse_html` reads the attributes back.
    let parsed = DomParser::from_schema(&s).parse(&doc_to_html(&doc), &ParseOptions::default());
    let note = parsed.child(0);
    assert_eq!(note.attrs()["color"], json!("red"));
    assert_eq!(note.attrs()["id"], json!(7));
    // Read by default from the DOM attribute of its name.
    assert_eq!(note.attrs()["tone"], json!("warn"));
}

#[test]
fn defaults_render_every_type() {
    let s = json_schema();
    let bare = s.mark("bare", None).unwrap();
    let flat = s.mark("flat", None).unwrap();
    let p = s
        .node(
            "plain",
            None,
            Fragment::from(vec![
                s.node(
                    "dot",
                    None,
                    Fragment::empty(),
                    vec![bare.clone(), flat.clone()],
                )
                .unwrap(),
                s.node("dot", None, Fragment::empty(), vec![bare, flat])
                    .unwrap(),
                s.text("c", vec![]),
            ]),
            vec![],
        )
        .unwrap();
    let doc = s
        .node("doc", None, Fragment::from(vec![p]), vec![])
        .unwrap();
    // `bare` spans both dots; `flat` (not spanning) closes between them.
    assert_eq!(
        doc_to_html(&doc),
        r#"<div data-type="plain"><span data-mark="bare"><b><span data-type="dot"></span></b><b><span data-type="dot"></span></b></span>c</div>"#
    );
}

#[test]
fn callbacks_render() {
    let mut spec = SchemaSpec::default();
    spec.nodes = vec![
        (
            "doc".into(),
            NodeSpec {
                content: Some("text*".into()),
                ..Default::default()
            },
        ),
        ("text".into(), NodeSpec::default()),
    ];
    spec.marks = vec![(
        "size".into(),
        MarkSpec {
            attrs: vec![(
                "px".into(),
                AttrSpec {
                    default: Some(json!(12)),
                    ..Default::default()
                },
            )],
            to_dom: Some(DomOutputSpec::render(|src| {
                let px = src
                    .attr("px")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                DomOutputSpec::tag("span")
                    .attr("style", format!("font-size: {px}px"))
                    .hole()
            })),
            ..Default::default()
        },
    )];
    let s = Schema::new(spec).unwrap();
    let doc = s
        .node(
            "doc",
            None,
            Fragment::from(vec![s.text("<", vec![s.mark("size", None).unwrap()])]),
            vec![],
        )
        .unwrap();
    assert_eq!(
        doc_to_html(&doc),
        r#"<span style="font-size: 12px" px="12">&lt;</span>"#
    );
}

#[test]
fn null_attributes_are_left_out() {
    // The image's null `title` and `alt` write nothing.
    round_trip(r#"<p><img src="a.png"></p>"#, r#"<p><img src="a.png"></p>"#);
}

#[test]
fn void_elements_drop_content() {
    let mut spec = SchemaSpec::default();
    spec.nodes = vec![
        (
            "doc".into(),
            NodeSpec {
                content: Some("block+".into()),
                ..Default::default()
            },
        ),
        (
            "rule".into(),
            NodeSpec {
                content: Some("text*".into()),
                group: Some("block".into()),
                to_dom: Some(DomOutputSpec::tag("hr").attr("class", "x").hole()),
                ..Default::default()
            },
        ),
        ("text".into(), NodeSpec::default()),
    ];
    let s = Schema::new(spec).unwrap();
    let rule = s
        .node(
            "rule",
            None,
            Fragment::from(vec![s.text("gone", vec![])]),
            vec![],
        )
        .unwrap();
    let doc = s
        .node("doc", None, Fragment::from(vec![rule]), vec![])
        .unwrap();
    assert_eq!(doc_to_html(&doc), r#"<hr class="x">"#);
}

#[test]
fn callbacks_returning_callbacks_stop() {
    fn forever() -> DomOutputSpec {
        DomOutputSpec::render(|_| forever())
    }
    let mut spec = SchemaSpec::default();
    spec.nodes = vec![
        (
            "doc".into(),
            NodeSpec {
                content: Some("block+".into()),
                ..Default::default()
            },
        ),
        (
            "loop".into(),
            NodeSpec {
                content: Some("text*".into()),
                group: Some("block".into()),
                to_dom: Some(forever()),
                ..Default::default()
            },
        ),
        ("text".into(), NodeSpec::default()),
    ];
    let s = Schema::new(spec).unwrap();
    let node = s
        .node(
            "loop",
            None,
            Fragment::from(vec![s.text("t", vec![])]),
            vec![],
        )
        .unwrap();
    let doc = s
        .node("doc", None, Fragment::from(vec![node]), vec![])
        .unwrap();
    // The default form stands in.
    assert_eq!(doc_to_html(&doc), r#"<div data-type="loop">t</div>"#);
}
