//! The inline atoms of a short post, in the HTML the web editor reads and the
//! server stores (`longbridge-websites` `packages/blocks/src/social`:
//! `editor/html-parsers.ts`, `utils/parse-trend.ts`, `rich-text/index.tsx`):
//!
//! | Node | HTML |
//! |---|---|
//! | `securityTag` | `<span type="security-tag" counter_id="ST/US/AAPL" name="Apple Inc." trend="1"></span>` |
//! | `mention` | `<span type="mention" member_id="1001" name="Alice">@Alice</span>` |
//! | `hashtag` | `<span type="hashtag" name="Earnings" value="#Earnings#">#Earnings#</span>` |
//!
//! `trend` is `"0"` (neutral), `"1"` (bullish) or `"2"` (bearish) and absent
//! until picked. A stock tag's span is empty, as the web's fixtures have it:
//! the editor shows `$name` from the attribute. Reading takes a `counter_id`
//! of two segments (`US/AAPL`, the web's fallback) or three (`ST/US/AAPL`,
//! what its search returns and the editor writes), a missing `name` becomes
//! the code, and a mention may be a `[data-mention]` element as the web reads.
//! The web editor writes no hashtag span (a picked topic is a separate
//! `hashtags` list); the node reads and writes the form the server renders.

use std::sync::Arc;

use nsh_base::rich_editor::{
    extensions::{
        Extension,
        suggestion::{SuggestionOptions, suggestion},
    },
    model::{
        AttrParse, AttrSpec, AttrType, Attrs, DomElement, DomOutputSpec, Node, NodeSpec, ParseRule,
        TextRender,
    },
    state::{ClickEvent, EditorState, NodeSelection, Plugin, PluginKey, PluginSpec, Transaction},
};
use serde_json::Value;

/// An attribute with a default of `null`.
fn optional(validate: AttrType) -> AttrSpec {
    let mut spec = AttrSpec::default();
    spec.default = Some(Value::Null);
    spec.validate = Some(validate);
    spec.parse_html = Some(AttrParse::Skip);
    spec.rendered = false;
    spec
}

/// A required string attribute.
fn required() -> AttrSpec {
    let mut spec = AttrSpec::default();
    spec.validate = Some(AttrType::String);
    // The parse rules read the DOM attributes (by default each attribute is
    // read as its own name, a `"1"` as a number); `to_dom` writes them.
    spec.parse_html = Some(AttrParse::Skip);
    spec.rendered = false;
    spec
}

/// A string attribute, empty until set.
fn text_attr() -> AttrSpec {
    let mut spec = required();
    spec.default = Some(Value::from(""));
    spec
}

/// The attribute `name` of a node as a string.
fn str_attr<'a>(node: &'a Node, name: &str) -> &'a str {
    node.attrs()
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// The code of a `counter_id`: its last segment (`ST/US/AAPL` and `US/AAPL`
/// are both `AAPL`).
fn code_of(counter_id: &str) -> &str {
    counter_id.rsplit('/').next().unwrap_or(counter_id)
}

/// A trend as the web's `parseTrendAttr` reads it: `"0"`, `"1"` and `"2"`
/// are kept, anything else is not set.
fn trend_of(raw: Option<&str>) -> Value {
    match raw.map(str::trim) {
        Some(t @ ("0" | "1" | "2")) => Value::from(t),
        _ => Value::Null,
    }
}

/// The element's attribute `name`, none when absent or empty.
fn attr<'a>(el: &'a DomElement, name: &str) -> Option<&'a str> {
    el.attr(name).filter(|v| !v.is_empty())
}

fn base() -> NodeSpec {
    let mut spec = NodeSpec::default();
    spec.group = Some("inline".into());
    spec.inline = true;
    spec.atom = true;
    spec.selectable = true;
    spec
}

/// Selects a stock tag a press lands beside. The view puts a press on an
/// inline atom at its nearer side as a caret (`Hit::Text`) and offers no
/// `handle_click_on` for it, so the plugin looks at both neighbors of the
/// position: the tag before it (the press was on its right half) or after
/// it (its left half). The selected tag is what the page opens its menu
/// for; Shift and Mod keep their own meaning.
struct SelectTagOnPress;

impl PluginSpec for SelectTagOnPress {
    fn key(&self) -> PluginKey {
        PluginKey::new("selectSecurityTag")
    }

    fn handle_click(
        &self,
        state: &EditorState,
        pos: usize,
        event: &ClickEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        if event.shift || event.mod_key || event.read_only {
            return false;
        }
        let doc = state.doc();
        let Ok(at) = doc.resolve(pos) else {
            return false;
        };
        let is_tag = |node: Option<nsh_base::rich_editor::model::Node>| {
            node.is_some_and(|n| n.ty().name() == "securityTag")
        };
        let from = if is_tag(at.node_after()) {
            pos
        } else if is_tag(at.node_before()) {
            pos - 1
        } else {
            return false;
        };
        let mut tr = state.tr();
        tr.set_selection(NodeSelection::create(doc, from));
        dispatch(tr);
        true
    }
}

/// `securityTag`: a stock, `counterId` its id on the server, `name` the name
/// shown, `trend` `"0"` (neutral), `"1"` (bullish), `"2"` (bearish) or `null`.
/// A press on it selects it, for the page's menu of its trend.
pub fn security_tag() -> Extension {
    Extension::node("securityTag", |_| {
        let mut spec = base();
        spec.attrs = vec![
            ("counterId".into(), required()),
            ("name".into(), text_attr()),
            ("trend".into(), optional(AttrType::String)),
        ];
        spec.parse_dom = vec![
            ParseRule::tag("span[type=\"security-tag\"]").with_get_attrs(|input| {
                let el = input.element()?;
                let counter_id = attr(el, "counter_id")?;
                let mut attrs = Attrs::new();
                attrs.insert("counterId".into(), Value::from(counter_id));
                let name = attr(el, "name").unwrap_or_else(|| code_of(counter_id));
                attrs.insert("name".into(), Value::from(name));
                attrs.insert("trend".into(), trend_of(el.attr("trend")));
                Some(attrs)
            }),
        ];
        // An empty span: the editor shows `$name` from the attribute.
        spec.to_dom = Some(
            DomOutputSpec::tag("span")
                .attr("type", "security-tag")
                .attr_of("counter_id", "counterId")
                .attr_of("name", "name")
                .attr_of("trend", "trend"),
        );
        spec.render_text = Some(TextRender::new(|node| {
            format!("${}", str_attr(node, "name"))
        }));
        spec
    })
    .add_plugins(|_| vec![Arc::new(SelectTagOnPress) as Plugin])
}

/// `mention`: a member, `memberId` their id on the server, `name` the name.
pub fn mention() -> Extension {
    Extension::node("mention", |_| {
        let mut spec = base();
        spec.attrs = vec![
            ("memberId".into(), required()),
            ("name".into(), text_attr()),
        ];
        // `[type="mention"]` or `[data-mention]`, as `parseMentionsFromHTML`.
        let rule = |selector: &str| {
            ParseRule::tag(selector.to_owned()).with_get_attrs(|input| {
                let el = input.element()?;
                let text = el.text_content();
                let name = attr(el, "name").map_or_else(
                    || text.trim().trim_start_matches('@').to_owned(),
                    str::to_owned,
                );
                let id = attr(el, "member_id")
                    .or_else(|| attr(el, "data-user-id"))
                    .or_else(|| attr(el, "data-id"))
                    .map_or_else(|| name.clone(), str::to_owned);
                if id.is_empty() {
                    return None;
                }
                let mut attrs = Attrs::new();
                attrs.insert("memberId".into(), Value::from(id));
                attrs.insert("name".into(), Value::from(name));
                Some(attrs)
            })
        };
        spec.parse_dom = vec![rule("span[type=\"mention\"]"), rule("[data-mention]")];
        spec.to_dom = Some(
            DomOutputSpec::tag("span")
                .attr("type", "mention")
                .attr_of("member_id", "memberId")
                .attr_of("name", "name")
                .child(DomOutputSpec::Text("@".into()))
                .child(DomOutputSpec::AttrText("name".into())),
        );
        spec.render_text = Some(TextRender::new(|node| {
            format!("@{}", str_attr(node, "name"))
        }));
        spec
    })
}

/// `hashtag`: a topic, `name` its name, as the server renders one
/// (`value="#name#"`). The web editor does not write it: a picked topic goes
/// to a separate list there.
pub fn hashtag() -> Extension {
    Extension::node("hashtag", |_| {
        let mut spec = base();
        spec.attrs = vec![("name".into(), required())];
        spec.parse_dom = vec![
            ParseRule::tag("span[type=\"hashtag\"]").with_get_attrs(|input| {
                let el = input.element()?;
                // `name`, else `value="#name#"` (the renderer's two forms).
                let name = attr(el, "name").map_or_else(
                    || {
                        attr(el, "value")
                            .map(|v| v.trim().trim_matches('#').to_owned())
                            .unwrap_or_default()
                    },
                    str::to_owned,
                );
                if name.is_empty() {
                    return None;
                }
                let mut attrs = Attrs::new();
                attrs.insert("name".into(), Value::from(name));
                Some(attrs)
            }),
        ];
        spec.to_dom = Some(DomOutputSpec::render(|src| {
            let name = src.attr("name").and_then(Value::as_str).unwrap_or_default();
            DomOutputSpec::tag("span")
                .attr("type", "hashtag")
                .attr("name", name)
                .attr("value", format!("#{name}#"))
                .child(DomOutputSpec::Text(format!("#{name}#")))
        }));
        spec.render_text = Some(TextRender::new(|node| {
            format!("#{}#", str_attr(node, "name"))
        }));
        spec
    })
}

/// The suggestions of the three triggers, `$` (key `security`), `@` (key
/// `mention`) and `#` (key `hashtag`), whose state the page reads with
/// `editor.suggestion(key)`. A trigger works after any character (Chinese
/// text has no spaces to put before it) and the list's keys (arrows, Enter,
/// Tab) are the plugin's: it is an extension above the default priority
/// because the plugins of a `createRichEditor` call come after the keymap,
/// where Enter has split the paragraph already.
pub fn suggestions() -> Extension {
    Extension::new("postSuggestions")
        .with_priority(200)
        .add_plugins(|_| {
            [("security", "$"), ("mention", "@"), ("hashtag", "#")]
                .into_iter()
                .map(|(key, char)| {
                    let mut options = SuggestionOptions::default();
                    options.key = key.into();
                    options.trigger.char = char.into();
                    options.trigger.allowed_prefixes = None;
                    options.capture_keys = ["ArrowUp", "ArrowDown", "Enter", "Tab"]
                        .map(String::from)
                        .to_vec();
                    suggestion(options)
                })
                .collect()
        })
}
