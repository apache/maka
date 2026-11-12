//! HTML in, the same HTML out: what the server stores survives the editor.

use nsh_base::rich_editor::{
    extensions::{ExtensionManager, kit::starter_kit},
    formats::{DomParser, ParseOptions, doc_to_html},
    model::{Node, Schema},
};
use post_editor_native::{hashtag, mention, security_tag};
use serde_json::json;

fn schema() -> Schema {
    ExtensionManager::with_core(vec![starter_kit(), security_tag(), mention(), hashtag()])
        .unwrap()
        .schema()
        .clone()
}

fn read(schema: &Schema, html: &str) -> Node {
    DomParser::from_schema(schema).parse(html, &ParseOptions::default())
}

/// Reads `html` and writes it back, expecting the same.
#[track_caller]
fn round_trips(html: &str) -> Node {
    let schema = schema();
    let doc = read(&schema, html);
    doc.check().unwrap();
    assert_eq!(doc_to_html(&doc), html);
    // And once more: the written form reads to the same document.
    assert_eq!(read(&schema, &doc_to_html(&doc)), doc);
    doc
}

/// The inline nodes of the first paragraph.
fn inline_nodes(doc: &Node) -> Vec<Node> {
    let mut out = Vec::new();
    doc.child(0).for_each(&mut |n, _, _| out.push(n.clone()));
    out
}

/// The tag nodes of the first paragraph.
fn tags(doc: &Node) -> Vec<Node> {
    inline_nodes(doc)
        .into_iter()
        .filter(|n| !n.is_text())
        .collect()
}

// The fixtures are the web's own (`html-parsers.test.ts`).

#[test]
fn a_security_tag_keeps_its_counter_name_and_trend() {
    let doc = round_trips(
        r#"<p>buy <span type="security-tag" counter_id="US/AAPL" name="Apple Inc." trend="1"></span> now</p>"#,
    );
    let tag = &tags(&doc)[0];
    assert_eq!(tag.ty().name(), "securityTag");
    assert_eq!(tag.attrs()["counterId"], json!("US/AAPL"));
    assert_eq!(tag.attrs()["name"], json!("Apple Inc."));
    assert_eq!(tag.attrs()["trend"], json!("1"));
    // One position: a text selection never lands inside it.
    assert!(tag.is_atom() && tag.is_leaf() && tag.node_size() == 1);
}

#[test]
fn trends_are_zero_one_and_two() {
    for trend in ["0", "1", "2"] {
        let html = format!(
            r#"<p><span type="security-tag" counter_id="HK/700" name="腾讯" trend="{trend}"></span></p>"#
        );
        let doc = round_trips(&html);
        assert_eq!(tags(&doc)[0].attrs()["trend"], json!(trend));
    }
}

#[test]
fn no_trend_writes_none_and_a_wrong_one_is_dropped() {
    let doc = round_trips(
        r#"<p><span type="security-tag" counter_id="US/TSLA" name="Tesla"></span></p>"#,
    );
    assert_eq!(tags(&doc)[0].attrs()["trend"], json!(null));
    let schema = schema();
    let doc = read(
        &schema,
        r#"<p><span type="security-tag" counter_id="US/TSLA" name="Tesla" trend="up"></span></p>"#,
    );
    assert_eq!(
        doc_to_html(&doc),
        r#"<p><span type="security-tag" counter_id="US/TSLA" name="Tesla"></span></p>"#
    );
}

#[test]
fn both_counter_id_forms_are_kept_as_they_came() {
    // Three segments, what the search returns; two, the web's fallback.
    round_trips(
        r#"<p><span type="security-tag" counter_id="ST/US/AAPL" name="Apple" trend="2"></span></p>"#,
    );
    round_trips(r#"<p><span type="security-tag" counter_id="HK/700" name="腾讯"></span></p>"#);
}

#[test]
fn a_missing_name_becomes_the_code() {
    let schema = schema();
    let doc = read(
        &schema,
        r#"<p><span type="security-tag" counter_id="ST/US/TSLA"></span></p>"#,
    );
    assert_eq!(tags(&doc)[0].attrs()["name"], json!("TSLA"));
    assert_eq!(
        doc_to_html(&doc),
        r#"<p><span type="security-tag" counter_id="ST/US/TSLA" name="TSLA"></span></p>"#
    );
}

#[test]
fn text_inside_a_stock_tag_is_left_out() {
    // The server's body_html has `$腾讯.HK` inside; the editor shows its own.
    let schema = schema();
    let doc = read(
        &schema,
        r#"<p><span type="security-tag" counter_id="ST/HK/700" name="腾讯" trend="1">$腾讯.HK</span></p>"#,
    );
    assert_eq!(
        doc_to_html(&doc),
        r#"<p><span type="security-tag" counter_id="ST/HK/700" name="腾讯" trend="1"></span></p>"#
    );
}

#[test]
fn a_security_tag_shows_its_name() {
    let schema = schema();
    let doc = read(
        &schema,
        r#"<p><span type="security-tag" counter_id="US/AAPL" name="Apple"></span></p>"#,
    );
    let tag = &tags(&doc)[0];
    assert_eq!(
        tag.ty().spec().render_text.clone().unwrap().text(tag),
        "$Apple"
    );
}

#[test]
fn a_tag_without_a_counter_id_is_dropped() {
    let schema = schema();
    let doc = read(
        &schema,
        r#"<p>a<span type="security-tag" name="x"></span>b</p>"#,
    );
    assert!(tags(&doc).is_empty(), "{}", doc_to_html(&doc));
}

#[test]
fn a_mention_keeps_its_member_and_name() {
    let doc = round_trips(
        r#"<p>cc <span type="mention" member_id="u001" name="Alice">@Alice</span> ok</p>"#,
    );
    let node = &tags(&doc)[0];
    assert_eq!(node.ty().name(), "mention");
    assert_eq!(node.attrs()["memberId"], json!("u001"));
    assert_eq!(node.attrs()["name"], json!("Alice"));
}

#[test]
fn a_mention_is_read_in_every_form_the_web_reads() {
    let schema = schema();
    let written = |html: &str| doc_to_html(&read(&schema, html));
    // `data-mention` with `data-user-id`.
    assert_eq!(
        written(r#"<p><span data-mention data-user-id="u002" name="Bob">@Bob</span></p>"#),
        r#"<p><span type="mention" member_id="u002" name="Bob">@Bob</span></p>"#
    );
    // No member_id: the name is the id.
    assert_eq!(
        written(r#"<p><span type="mention" name="Dave">@Dave</span></p>"#),
        r#"<p><span type="mention" member_id="Dave" name="Dave">@Dave</span></p>"#
    );
    // No name: the text without its `@`.
    assert_eq!(
        written(r#"<p><span type="mention" member_id="u005">@Eve</span></p>"#),
        r#"<p><span type="mention" member_id="u005" name="Eve">@Eve</span></p>"#
    );
}

#[test]
fn a_hashtag_keeps_its_name() {
    let doc = round_trips(
        r##"<p><span type="hashtag" name="Earnings" value="#Earnings#">#Earnings#</span> season</p>"##,
    );
    assert_eq!(tags(&doc)[0].attrs()["name"], json!("Earnings"));
    // The renderer's other form: only `value`.
    let schema = schema();
    let doc = read(
        &schema,
        r##"<p><span type="hashtag" value="#财报季#">#财报季#</span></p>"##,
    );
    assert_eq!(tags(&doc)[0].attrs()["name"], json!("财报季"));
}

#[test]
fn every_tag_among_text_and_paragraphs() {
    round_trips(concat!(
        r#"<p>看多 <span type="security-tag" counter_id="ST/US/NVDA" name="英伟达" trend="1"></span> "#,
        r#"<span type="mention" member_id="7" name="老王">@老王</span> "#,
        r##"<span type="hashtag" name="财报" value="#财报#">#财报#</span></p>"##,
        "<p>第二段 <strong>加粗</strong></p>",
    ));
}

#[test]
fn text_in_names_is_escaped() {
    let doc =
        round_trips(r#"<p><span type="mention" member_id="1" name="a&amp;b">@a&amp;b</span></p>"#);
    assert_eq!(tags(&doc)[0].attrs()["name"], json!("a&b"));
    round_trips(
        r#"<p><span type="security-tag" counter_id="US/BRK.B" name="A &quot;B&quot; &lt;C&gt;"></span></p>"#,
    );
}

/// The HTML parser collapses white space as a browser does: the space
/// `insertMention` leaves after a tag at the end of a paragraph is written
/// out, and gone once the HTML is read back (a first read settles it, the
/// next ones keep the document).
#[test]
fn a_trailing_space_is_dropped_on_reading() {
    let schema = schema();
    let doc = read(
        &schema,
        r#"<p>cc <span type="mention" member_id="1" name="A">@A</span> </p>"#,
    );
    assert_eq!(
        doc_to_html(&doc),
        r#"<p>cc <span type="mention" member_id="1" name="A">@A</span></p>"#
    );
}
