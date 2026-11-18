//! Parse cases after `prosemirror-model`'s `test-dom.ts`, on the starter
//! schema.

use serde_json::json;

use super::*;
use crate::rich_editor::{extensions::starter, model::SchemaSpec};

/// A compact form of `node`: `name{attrs}(children)`, texts quoted with
/// their marks before them (`<bold,italic>"x"`); null attributes left out.
fn show(node: &Node) -> String {
    if let Some(text) = node.text() {
        let marks: Vec<&str> = node.marks().iter().map(|m| m.ty().name()).collect();
        return if marks.is_empty() {
            format!("{text:?}")
        } else {
            format!("<{}>{text:?}", marks.join(","))
        };
    }
    let mut out = node.ty().name().to_owned();
    let attrs: Vec<String> = node
        .attrs()
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    if !attrs.is_empty() {
        out.push_str(&format!("{{{}}}", attrs.join(",")));
    }
    if !node.is_leaf() {
        let children: Vec<String> = node.content().iter().map(show).collect();
        out.push_str(&format!("({})", children.join(", ")));
    }
    out
}

fn show_fragment(f: &Fragment) -> String {
    f.iter().map(show).collect::<Vec<_>>().join(", ")
}

fn parse(html: &str) -> String {
    let schema = starter::schema();
    let doc = DomParser::from_schema(&schema).parse(html, &ParseOptions::default());
    doc.check().expect("a valid document");
    show(&doc)
}

#[test]
fn paragraphs() {
    assert_eq!(parse("<p>hello</p>"), r#"doc(paragraph("hello"))"#);
    assert_eq!(
        parse("<p>one</p><p>two</p>"),
        r#"doc(paragraph("one"), paragraph("two"))"#
    );
}

#[test]
fn headings_and_rules() {
    assert_eq!(
        parse("<h1>a</h1><h3>b</h3><hr><blockquote><p>q</p></blockquote>"),
        r#"doc(heading{level=1}("a"), heading{level=3}("b"), horizontalRule, blockquote(paragraph("q")))"#
    );
}

#[test]
fn marks_from_tags() {
    assert_eq!(
        parse("<p><strong>a</strong><em>b</em><code>c</code><s>d</s><u>e</u></p>"),
        r#"doc(paragraph(<bold>"a", <italic>"b", <code>"c", <strike>"d", <underline>"e"))"#
    );
    assert_eq!(
        parse("<p><b><i>both</i></b></p>"),
        r#"doc(paragraph(<italic,bold>"both"))"#
    );
}

#[test]
fn marks_from_styles() {
    assert_eq!(
        parse(
            "<p><span style=\"font-weight: 700\">a</span><span style=\"font-style:italic\">b</span>\
             <span style=\"text-decoration: line-through\">c</span><span style=\"font-weight:400\">d</span></p>"
        ),
        r#"doc(paragraph(<bold>"a", <italic>"b", <strike>"c", "d"))"#
    );
    // A normal style inside a mark clears it.
    assert_eq!(
        parse("<p><em>a<span style=\"font-style: normal\">b</span></em></p>"),
        r#"doc(paragraph(<italic>"a", "b"))"#
    );
}

#[test]
fn google_docs_bold_wrapper() {
    let html = "<meta charset=\"utf-8\"><b style=\"font-weight:normal;\" id=\"docs-internal-guid-1\">\
                <p><span style=\"font-weight:700\">bold</span><span style=\"font-weight:400\"> plain</span></p></b>";
    assert_eq!(parse(html), r#"doc(paragraph(<bold>"bold", " plain"))"#);
}

#[test]
fn windows_cf_html_header() {
    let html = "Version:0.9\r\nStartHTML:0000000105\r\n<html><body><!--StartFragment--><p><b>x</b></p><!--EndFragment--></body></html>";
    assert_eq!(parse(html), r#"doc(paragraph(<bold>"x"))"#);
}

#[test]
fn whitespace_collapses() {
    assert_eq!(
        parse("<p>  a \n  b  <em> c </em> </p>"),
        r#"doc(paragraph("a b ", <italic>"c"))"#
    );
    assert_eq!(
        parse("<p>a</p>\n   \n<p>b</p>"),
        r#"doc(paragraph("a"), paragraph("b"))"#
    );
}

#[test]
fn pre_keeps_whitespace() {
    assert_eq!(
        parse("<pre><code class=\"language-rust\">fn  main() {\n    x\n}</code></pre>"),
        r#"doc(codeBlock{language="rust"}("fn  main() {\n    x\n}"))"#
    );
}

#[test]
fn line_breaks() {
    assert_eq!(
        parse("<p>a<br>b</p>"),
        r#"doc(paragraph("a", hardBreak, "b"))"#
    );
}

#[test]
fn links_and_images() {
    assert_eq!(
        parse("<p><a href=\"https://x.dev\" title=\"t\">x</a> <img src=\"i.png\" alt=\"pic\"></p>"),
        r#"doc(paragraph(<link>"x", " ", image{alt="pic",src="i.png"}))"#
    );
    // An anchor without href is no link.
    assert_eq!(
        parse("<p><a name=\"n\">x</a></p>"),
        r#"doc(paragraph("x"))"#
    );
}

#[test]
fn lists() {
    assert_eq!(
        parse("<ol start=\"3\"><li>a</li><li><p>b</p><ul><li>c</li></ul></li></ol>"),
        r#"doc(orderedList{start=3}(listItem(paragraph("a")), listItem(paragraph("b"), bulletList(listItem(paragraph("c"))))))"#
    );
}

#[test]
fn sublist_directly_in_list() {
    assert_eq!(
        parse("<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>"),
        r#"doc(bulletList(listItem(paragraph("a"), bulletList(listItem(paragraph("b")))), listItem(paragraph("c"))))"#
    );
}

#[test]
fn unknown_tags_pass_content_through() {
    assert_eq!(
        parse("<section><article><foo>hi <span>there</span></foo></article></section>"),
        r#"doc(paragraph("hi there"))"#
    );
    assert_eq!(
        parse("<div>one</div><div>two</div>"),
        r#"doc(paragraph("one"), paragraph("two"))"#
    );
}

#[test]
fn ignored_tags() {
    assert_eq!(
        parse("<p>a<script>alert(1)</script><style>p{}</style>b</p>"),
        r#"doc(paragraph("ab"))"#
    );
}

#[test]
fn loose_inline_content_gets_a_paragraph() {
    assert_eq!(
        parse("just <b>text</b>"),
        r#"doc(paragraph("just ", <bold>"text"))"#
    );
    assert_eq!(parse(""), r#"doc(paragraph())"#);
}

#[test]
fn inline_slice_is_open() {
    let schema = starter::schema();
    let slice =
        DomParser::from_schema(&schema).parse_slice("foo <b>bar</b>", &ParseOptions::default());
    assert_eq!(show_fragment(&slice.content), r#""foo ", <bold>"bar""#);
    assert_eq!((slice.open_start, slice.open_end), (0, 0));

    let slice =
        DomParser::from_schema(&schema).parse_slice("<p>a</p><p>b</p>", &ParseOptions::default());
    assert_eq!((slice.open_start, slice.open_end), (1, 1));
}

#[test]
fn clipboard_slice_fits_its_context() {
    let schema = starter::schema();
    let parser = DomParser::from_schema(&schema);
    let doc = parser.parse("<p>ab</p>", &ParseOptions::default());
    let at = doc.resolve(2).unwrap();

    // Inline HTML stays inline, so it merges into the paragraph.
    let slice = parser.parse_with_context("<span>x <b>y</b></span>", &at);
    assert_eq!(show_fragment(&slice.content), r#""x ", <bold>"y""#);
    let pasted = doc.replace(2, 2, &slice).unwrap();
    assert_eq!(show(&pasted), r#"doc(paragraph("ax ", <bold>"y", "b"))"#);

    // A block's trailing `<br>` is the browser's placeholder.
    let slice = parser.parse_with_context("<p>one<br></p><p>two</p>", &at);
    assert_eq!(
        show_fragment(&slice.content),
        r#"paragraph("one"), paragraph("two")"#
    );
    assert_eq!((slice.open_start, slice.open_end), (1, 1));

    // Loose list items are wrapped in a list together (the first list
    // type the document takes).
    let slice = parser.parse_with_context("<li>a</li><li>b</li>", &at);
    assert_eq!(
        show_fragment(&slice.content),
        r#"orderedList{start=1}(listItem(paragraph("a")), listItem(paragraph("b")))"#
    );
    assert!(slice.content.size() > 0);

    assert_eq!(parser.parse_with_context("", &at).content.size(), 0);
}

/// What an editor copies is pasted back as the same slice: its open
/// depths and the nodes it was open through (`data-pm-slice`).
#[test]
fn a_copied_slice_reads_back_with_its_context() {
    let schema = starter::schema();
    let parser = DomParser::from_schema(&schema);
    let doc = parser.parse(
        "<blockquote><ul><li><p>abc</p></li></ul></blockquote><p>x</p>",
        &ParseOptions::default(),
    );
    // `b`, inside the paragraph of the item of the list of the quote.
    let slice = doc.slice(5, 6, true).unwrap();
    assert_eq!(slice.open_start, 4);
    let html = crate::rich_editor::formats::DomSerializer::from_schema(&schema)
        .serialize_for_clipboard(&slice);
    assert_eq!(
        html,
        r#"<p data-pm-slice="1 1 [&quot;blockquote&quot;,null,&quot;bulletList&quot;,null,&quot;listItem&quot;,null]">b</p>"#
    );
    let at = doc.resolve(doc.content().size() - 1).unwrap();
    let back = parser.parse_from_clipboard(&html, &at);
    assert_eq!(back, slice);
    // HTML from elsewhere has no context: the paragraph alone.
    let other = parser.parse_from_clipboard("<p>b</p>", &at);
    assert_eq!(show_fragment(&other.content), r#"paragraph("b")"#);
    assert_eq!((other.open_start, other.open_end), (1, 1));
}

/// `data-pm-slice` is read as ProseMirror's regular expression reads
/// it: what does not match leaves the HTML read as any other, a `-N`
/// without a space after it is context, and context that is no JSON
/// leaves the slice unwrapped.
#[test]
fn malformed_slice_data_reads_as_prosemirror_reads_it() {
    assert_eq!(slice_data("1 1 []"), Some((1, 1, 0, "[]")));
    assert_eq!(slice_data("0 0 -2 []"), Some((0, 0, 2, "[]")));
    assert_eq!(slice_data("0 0 -2x []"), Some((0, 0, 0, "-2x []")));
    assert_eq!(slice_data("0 0 -2"), Some((0, 0, 0, "-2")));
    assert_eq!(
        slice_data("1 1 [\"a\"]\n[\"b\"]"),
        Some((1, 1, 0, "[\"a\"]"))
    );
    assert_eq!(slice_data("1 1"), None);
    assert_eq!(slice_data("a 1 []"), None);
    assert_eq!(slice_data(" 1 1 []"), None);
    assert_eq!(
        slice_data("99999999999999999999999 0 []").map(|d| d.0),
        Some(usize::MAX)
    );

    let schema = starter::schema();
    let parser = DomParser::from_schema(&schema);
    let doc = parser.parse("<p>x</p>", &ParseOptions::default());
    let at = doc.resolve(1).unwrap();
    // No match: other HTML, its whitespace collapsed.
    let other = parser.parse_from_clipboard(r#"<p data-pm-slice="1 1">a  b</p>"#, &at);
    assert_eq!(show_fragment(&other.content), r#"paragraph("a b")"#);
    // The first element with the attribute decides, even when it does not match.
    let first = parser.parse_from_clipboard(
        r#"<p data-pm-slice="x">a  b</p><p data-pm-slice="1 1 []">c</p>"#,
        &at,
    );
    assert_eq!(
        show_fragment(&first.content),
        r#"paragraph("a b"), paragraph("c")"#
    );
    // Context that is no JSON: the slice as it was copied, unwrapped.
    let broken = parser.parse_from_clipboard(r#"<p data-pm-slice="1 1 [oops">a  b</p>"#, &at);
    assert_eq!(show_fragment(&broken.content), r#"paragraph("a  b")"#);
    assert_eq!((broken.open_start, broken.open_end), (1, 1));
    // An odd context array: pairs counted from its end, as ProseMirror
    // counts them (`blockquote`, `null`; the leading `x` is left over).
    let odd = parser.parse_from_clipboard(
        r#"<p data-pm-slice="1 1 [&quot;x&quot;,&quot;blockquote&quot;,null]">a</p>"#,
        &at,
    );
    assert_eq!(show_fragment(&odd.content), r#"blockquote(paragraph("a"))"#);
    assert_eq!((odd.open_start, odd.open_end), (2, 2));
}

/// A context node whose type has required attributes stops the
/// wrapping (ProseMirror's `addContext`), even when the copy recorded
/// them: its attributes cannot be trusted to make a valid node.
#[test]
fn context_stops_at_a_type_with_required_attributes() {
    let schema = SchemaSpec::from_json(&json!({
        "nodes": [
            ["doc", {"content": "block+"}],
            ["section", {"content": "block+", "group": "block", "attrs": {"id": {}},
                         "parseDOM": [{"tag": "section"}], "toDOM": ["section", 0]}],
            ["box", {"content": "block+", "group": "block",
                     "parseDOM": [{"tag": "div.box"}], "toDOM": ["div", {"class": "box"}, 0]}],
            ["para", {"content": "text*", "group": "block", "parseDOM": [{"tag": "p"}], "toDOM": ["p", 0]}],
            ["text", {}]
        ]
    }))
    .unwrap();
    let parser = DomParser::from_schema(&schema);
    let serializer = crate::rich_editor::formats::DomSerializer::from_schema(&schema);
    let doc = Node::from_json(
        &schema,
        &json!({"type": "doc", "content": [
            {"type": "section", "attrs": {"id": "s"}, "content": [
                {"type": "box", "content": [{"type": "para", "content": [{"type": "text", "text": "abc"}]}]}
            ]}
        ]}),
    )
    .unwrap();
    // `b`: inside the paragraph of the box of the section.
    let slice = doc.slice(4, 5, true).unwrap();
    assert_eq!(slice.open_start, 3);
    let html = serializer.serialize_for_clipboard(&slice);
    assert_eq!(
        html,
        r#"<p data-pm-slice="1 1 [&quot;section&quot;,{&quot;id&quot;:&quot;s&quot;},&quot;box&quot;,null]">b</p>"#
    );
    let at = doc.resolve(4).unwrap();
    let back = parser.parse_from_clipboard(&html, &at);
    // The box wraps it again; the section, whose `id` is required, does not.
    assert_eq!(show_fragment(&back.content), r#"box(para("b"))"#);
    assert_eq!((back.open_start, back.open_end), (2, 2));
}

#[test]
fn rules_from_schema_json() {
    let schema = SchemaSpec::from_json(&json!({
        "nodes": [
            ["doc", {"content": "block+"}],
            ["para", {"content": "inline*", "group": "block", "parseDOM": [{"tag": "p"}]}],
            ["note", {"content": "inline*", "group": "block",
                      "attrs": {"kind": {"default": "info"}, "level": {"default": 0, "validate": "number"}},
                      "parseDOM": [{"tag": "div.note", "getAttrs": {"kind": "data-kind", "level": "data-level"}, "priority": 60}]}],
            ["text", {"group": "inline"}]
        ],
        "marks": [
            ["strong", {"parseDOM": [{"tag": "b"}, {"style": "font-weight=bold"}]}]
        ]
    }))
    .unwrap();
    let doc = DomParser::from_schema(&schema).parse(
        "<div class=\"note\" data-kind=\"warn\" data-level=\"2\">x <span style=\"font-weight: bold\">y</span></div><p>z</p>",
        &ParseOptions::default(),
    );
    assert_eq!(
        show(&doc),
        r#"doc(note{kind="warn",level=2}("x ", <strong>"y"), para("z"))"#
    );
}

#[test]
fn rule_context() {
    let mut spec = starter::schema_spec();
    // Inside a blockquote, `<p class="x">` becomes a heading.
    let heading = spec
        .nodes
        .iter_mut()
        .find(|(n, _)| n == "heading")
        .expect("a heading");
    heading.1.parse_dom.push(ParseRule {
        context: Some("blockquote/".into()),
        priority: Some(60),
        ..ParseRule::tag("p.x")
    });
    let schema = Schema::new(spec).unwrap();
    let doc = DomParser::from_schema(&schema).parse(
        "<p class=\"x\">a</p><blockquote><p class=\"x\">b</p></blockquote>",
        &ParseOptions::default(),
    );
    assert_eq!(
        show(&doc),
        r#"doc(paragraph("a"), blockquote(heading{level=1}("b")))"#
    );
}
