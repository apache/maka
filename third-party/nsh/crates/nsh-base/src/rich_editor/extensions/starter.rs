//! A starter set of optional pieces, none of which the kernel needs: the
//! nodes and marks of Tiptap's StarterKit with its names (`bulletList`,
//! `codeBlock`, `hardBreak`, ...), task lists, highlight, sub- and
//! superscript, text styles and text alignment ([`nodes`], [`marks`],
//! [`schema`]), and Tiptap's key bindings, input rules, paste rules and
//! plugins for them. An app takes the pieces it wants and adds its own;
//! the commands take any schema's types.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::{
    extension::{Extension, ExtensionManager},
    input_rules::{InputMatch, InputRule, input_rules as input_rules_plugin},
    keymap::{keymap as keymap_plugin, normalize_key_name},
    kit,
    paste_rules::{PasteRule, paste_rules},
    typography::{TypographyOptions, typography},
};
use crate::rich_editor::{
    commands::{BoxCommand, CommandRegistry, chain_commands},
    model::{
        AttrParse, AttrRender, AttrSpec, Attrs, ClearMark, DomElement, DomOutputSpec, MarkSpec,
        NodeSpec, ParseRule, Schema, SchemaSpec, TextRender, Whitespace,
    },
    state::Plugin,
};

fn attr(default: Option<Value>) -> AttrSpec {
    AttrSpec {
        default,
        // Each type's `to_dom` writes its attributes in their HTML form
        // (`<h2>`, `class="language-x"`), as Tiptap's starter types do.
        rendered: false,
        ..Default::default()
    }
}

// A null-default attribute read from and written to the style property
// `property` (Tiptap's text style and highlight attributes).
pub(super) fn styled_attr(property: &str) -> AttrSpec {
    AttrSpec {
        default: Some(Value::Null),
        parse_html: Some(AttrParse::Style(property.into())),
        render_html: Some(AttrRender::Style(property.into())),
        ..Default::default()
    }
}

// Tiptap's `textAlign` global attribute: null by default, read from and
// written as the `text-align` style.
fn text_align() -> AttrSpec {
    styled_attr("text-align")
}

/// The starter's node specs, each `(name, spec)`.
pub mod nodes {
    use super::*;

    /// A list of tasks (Tiptap's `taskList`).
    pub fn task_list() -> (String, NodeSpec) {
        (
            "taskList".into(),
            NodeSpec {
                to_dom: Some(
                    DomOutputSpec::tag("ul")
                        .attr("data-type", "taskList")
                        .hole(),
                ),
                parse_dom: vec![ParseRule {
                    priority: Some(51),
                    ..ParseRule::tag(r#"ul[data-type="taskList"]"#)
                }],
                content: Some("taskItem+".into()),
                group: Some("block list".into()),
                ..Default::default()
            },
        )
    }

    /// A task: a paragraph, then any blocks, `checked` or not (Tiptap's
    /// `taskItem`).
    pub fn task_item() -> (String, NodeSpec) {
        (
            "taskItem".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::render(|src| {
                    let c = src
                        .attr("checked")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    DomOutputSpec::tag("li")
                        .attr("data-type", "taskItem")
                        .attr("data-checked", c)
                        .child(
                            DomOutputSpec::tag("label")
                                .child(DomOutputSpec::tag("input").attr("type", "checkbox").attr(
                                    "checked",
                                    if c {
                                        Value::from("checked")
                                    } else {
                                        Value::Null
                                    },
                                ))
                                .child(DomOutputSpec::tag("span")),
                        )
                        .child(DomOutputSpec::tag("div").hole())
                })),
                parse_dom: vec![
                    ParseRule {
                        priority: Some(51),
                        ..ParseRule::tag(r#"li[data-type="taskItem"]"#)
                    }
                    .with_get_attrs(|input| {
                        let checked = input.element()?.attr("data-checked") == Some("true");
                        Some(attrs_of("checked", Value::Bool(checked)))
                    }),
                ],
                content: Some("paragraph block*".into()),
                defining: true,
                attrs: vec![("checked".into(), attr(Some(Value::Bool(false))))],
                // The editor's view draws its checkbox.
                extra: [("render".to_owned(), Value::from("task"))].into(),
                ..Default::default()
            },
        )
    }

    /// The document: one block or more.
    pub fn doc() -> (String, NodeSpec) {
        (
            "doc".into(),
            NodeSpec {
                content: Some("block+".into()),
                ..Default::default()
            },
        )
    }

    /// A paragraph of inline content.
    pub fn paragraph() -> (String, NodeSpec) {
        (
            "paragraph".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::tag("p").hole()),
                parse_dom: vec![ParseRule::tag("p")],
                content: Some("inline*".into()),
                group: Some("block".into()),
                attrs: vec![("textAlign".into(), text_align())],
                ..Default::default()
            },
        )
    }

    /// A quoted block of blocks.
    pub fn blockquote() -> (String, NodeSpec) {
        (
            "blockquote".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::tag("blockquote").hole()),
                parse_dom: vec![ParseRule::tag("blockquote")],
                content: Some("block+".into()),
                group: Some("block".into()),
                defining: true,
                ..Default::default()
            },
        )
    }

    /// A horizontal rule (a leaf block).
    pub fn horizontal_rule() -> (String, NodeSpec) {
        (
            "horizontalRule".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::tag("hr")),
                parse_dom: vec![ParseRule::tag("hr")],
                group: Some("block".into()),
                ..Default::default()
            },
        )
    }

    /// A heading with a `level` from 1 to 6 (default 1).
    pub fn heading() -> (String, NodeSpec) {
        (
            "heading".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::render(|src| {
                    let level = src.attr("level").and_then(Value::as_u64).unwrap_or(1);
                    DomOutputSpec::tag(format!("h{}", level.clamp(1, 6))).hole()
                })),
                parse_dom: (1..=6)
                    .map(|level| {
                        ParseRule::tag(format!("h{level}"))
                            .with_attrs(attrs_of("level", Value::from(level)))
                    })
                    .collect(),
                content: Some("inline*".into()),
                group: Some("block".into()),
                defining: true,
                attrs: vec![
                    ("level".into(), attr(Some(Value::from(1)))),
                    ("textAlign".into(), text_align()),
                ],
                ..Default::default()
            },
        )
    }

    /// A block of code: text without marks, with a `language` (default
    /// null).
    pub fn code_block() -> (String, NodeSpec) {
        (
            "codeBlock".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::render(|src| {
                    let code = match src.attr("language").and_then(Value::as_str) {
                        Some(lang) => {
                            DomOutputSpec::tag("code").attr("class", format!("language-{lang}"))
                        }
                        None => DomOutputSpec::tag("code"),
                    };
                    DomOutputSpec::tag("pre").child(code.hole())
                })),
                parse_dom: vec![
                    ParseRule {
                        preserve_whitespace: Some(Whitespace::Full),
                        ..ParseRule::tag("pre")
                    }
                    .with_get_attrs(|input| {
                        let pre = input.element()?;
                        Some(attrs_of(
                            "language",
                            code_language(pre).map_or(Value::Null, Value::from),
                        ))
                    }),
                ],
                content: Some("text*".into()),
                marks: Some(String::new()),
                group: Some("block".into()),
                code: true,
                defining: true,
                attrs: vec![("language".into(), attr(Some(Value::Null)))],
                ..Default::default()
            },
        )
    }

    /// Text.
    pub fn text() -> (String, NodeSpec) {
        (
            "text".into(),
            NodeSpec {
                group: Some("inline".into()),
                ..Default::default()
            },
        )
    }

    /// An inline image with a `src`, an `alt`, a `title`, a `width` and a
    /// `height`.
    pub fn image() -> (String, NodeSpec) {
        (
            "image".into(),
            NodeSpec {
                to_dom: Some(
                    DomOutputSpec::tag("img")
                        .attr_of("src", "src")
                        .attr_of("alt", "alt")
                        .attr_of("title", "title"),
                ),
                parse_dom: vec![ParseRule::tag("img[src]").with_get_attrs(|input| {
                    let img = input.element()?;
                    let mut attrs = Attrs::new();
                    let get = |name: &str| img.attr(name).map_or(Value::Null, Value::from);
                    attrs.insert("src".into(), get("src"));
                    attrs.insert("alt".into(), get("alt"));
                    attrs.insert("title".into(), get("title"));
                    attrs.insert("width".into(), get("width"));
                    attrs.insert("height".into(), get("height"));
                    Some(attrs)
                })],
                inline: true,
                group: Some("inline".into()),
                draggable: true,
                attrs: vec![
                    ("src".into(), attr(None)),
                    ("alt".into(), attr(Some(Value::Null))),
                    ("title".into(), attr(Some(Value::Null))),
                    ("width".into(), attr(Some(Value::Null))),
                    ("height".into(), attr(Some(Value::Null))),
                ],
                // The editor's view draws it.
                extra: [("render".to_owned(), Value::from("image"))].into(),
                ..Default::default()
            },
        )
    }

    /// A line break in a textblock.
    pub fn hard_break() -> (String, NodeSpec) {
        (
            "hardBreak".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::tag("br")),
                render_text: Some(TextRender::Template("\n".into())),
                parse_dom: vec![ParseRule::tag("br")],
                inline: true,
                group: Some("inline".into()),
                selectable: false,
                leaf_text: Some("\n".into()),
                linebreak_replacement: true,
                ..Default::default()
            },
        )
    }

    /// A list with a `start` (its first number, default 1).
    pub fn ordered_list() -> (String, NodeSpec) {
        (
            "orderedList".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::render(|src| {
                    let start = src.attr("start");
                    let start = start.and_then(Value::as_i64).filter(|&s| s != 1);
                    DomOutputSpec::tag("ol").attr("start", start).hole()
                })),
                parse_dom: vec![ParseRule::tag("ol").with_get_attrs(|input| {
                    let start = input
                        .element()?
                        .attr("start")
                        .and_then(|s| s.trim().parse::<i64>().ok())
                        .unwrap_or(1);
                    Some(attrs_of("start", Value::from(start)))
                })],
                content: Some("listItem+".into()),
                group: Some("block list".into()),
                attrs: vec![("start".into(), attr(Some(Value::from(1))))],
                // The editor's view numbers its items from `start`.
                extra: [
                    ("listMarker".to_owned(), Value::from("ordered")),
                    ("listMarkerStart".to_owned(), Value::from("start")),
                ]
                .into(),
                ..Default::default()
            },
        )
    }

    /// A bulleted list.
    pub fn bullet_list() -> (String, NodeSpec) {
        (
            "bulletList".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::tag("ul").hole()),
                parse_dom: vec![ParseRule::tag("ul")],
                content: Some("listItem+".into()),
                group: Some("block list".into()),
                // The editor's view marks its items with bullets.
                extra: [("listMarker".to_owned(), Value::from("bullet"))].into(),
                ..Default::default()
            },
        )
    }

    /// A list item: a paragraph, then any blocks.
    pub fn list_item() -> (String, NodeSpec) {
        (
            "listItem".into(),
            NodeSpec {
                to_dom: Some(DomOutputSpec::tag("li").hole()),
                parse_dom: vec![ParseRule::tag("li")],
                content: Some("paragraph block*".into()),
                defining: true,
                ..Default::default()
            },
        )
    }
}

/// The starter's mark specs, each `(name, spec)`.
pub mod marks {
    use super::*;

    /// A highlight, with a `color` (default null; Tiptap's `highlight`).
    pub fn highlight() -> (String, MarkSpec) {
        (
            "highlight".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("mark").hole()),
                parse_dom: vec![ParseRule::tag("mark")],
                attrs: vec![("color".into(), styled_attr("background-color"))],
                ..Default::default()
            },
        )
    }

    /// Subscript, which excludes superscript.
    pub fn subscript() -> (String, MarkSpec) {
        (
            "subscript".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("sub").hole()),
                parse_dom: vec![ParseRule::tag("sub")],
                excludes: Some("superscript".into()),
                ..Default::default()
            },
        )
    }

    /// Superscript, which excludes subscript.
    pub fn superscript() -> (String, MarkSpec) {
        (
            "superscript".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("sup").hole()),
                parse_dom: vec![ParseRule::tag("sup")],
                excludes: Some("subscript".into()),
                ..Default::default()
            },
        )
    }

    /// Text styles: `color`, `fontFamily`, `fontSize` and `backgroundColor`
    /// (each default null), written as a `<span style>` (Tiptap's
    /// `textStyle`).
    pub fn text_style() -> (String, MarkSpec) {
        (
            "textStyle".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("span").hole()),
                // Only spans carrying one of its styles: a span styled
                // otherwise (`font-weight`) is no text style. Not
                // consuming, so the other rules still read the span.
                parse_dom: vec![ParseRule {
                    priority: Some(101),
                    consuming: Some(false),
                    ..ParseRule::tag("span[style]").with_get_attrs(|input| {
                        let el = input.element()?;
                        ["color", "font-family", "font-size", "background-color"]
                            .iter()
                            .any(|p| el.style(p).is_some_and(|v| !v.trim().is_empty()))
                            .then(Attrs::new)
                    })
                }],
                attrs: vec![
                    ("color".into(), styled_attr("color")),
                    ("fontFamily".into(), styled_attr("font-family")),
                    ("fontSize".into(), styled_attr("font-size")),
                    ("backgroundColor".into(), styled_attr("background-color")),
                ],
                spanning: true,
                ..Default::default()
            },
        )
    }

    /// A link with an `href` and a `title`; text typed at its end is not
    /// linked.
    pub fn link() -> (String, MarkSpec) {
        (
            "link".into(),
            MarkSpec {
                to_dom: Some(
                    DomOutputSpec::tag("a")
                        .attr_of("href", "href")
                        .attr_of("title", "title")
                        .hole(),
                ),
                parse_dom: vec![ParseRule::tag("a[href]").with_get_attrs(|input| {
                    let a = input.element()?;
                    let mut attrs = attrs_of("href", Value::from(a.attr("href")?));
                    attrs.insert(
                        "title".into(),
                        a.attr("title").map_or(Value::Null, Value::from),
                    );
                    Some(attrs)
                })],
                attrs: vec![
                    ("href".into(), attr(None)),
                    ("title".into(), attr(Some(Value::Null))),
                ],
                inclusive: false,
                exitable: true,
                ..Default::default()
            },
        )
    }

    /// Italic (emphasis).
    pub fn italic() -> (String, MarkSpec) {
        (
            "italic".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("em").hole()),
                parse_dom: vec![
                    ParseRule::tag("i"),
                    ParseRule::tag("em"),
                    ParseRule::style("font-style=italic"),
                    ParseRule {
                        clear_mark: Some(ClearMark::named("italic")),
                        ..ParseRule::style("font-style=normal")
                    },
                ],
                ..Default::default()
            },
        )
    }

    /// Bold (strong emphasis).
    pub fn bold() -> (String, MarkSpec) {
        (
            "bold".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("strong").hole()),
                parse_dom: vec![
                    ParseRule::tag("strong"),
                    // Google Docs wraps copied content in a `<b>` of normal
                    // weight, which is not bold.
                    ParseRule::tag("b").with_get_attrs(|input| {
                        let b = input.element()?;
                        (b.style("font-weight").as_deref() != Some("normal")).then(Attrs::new)
                    }),
                    ParseRule {
                        clear_mark: Some(ClearMark::named("bold")),
                        ..ParseRule::style("font-weight")
                    }
                    .with_get_attrs(|input| {
                        let value = input.style_value()?;
                        (!is_bold_weight(value)).then(Attrs::new)
                    }),
                    ParseRule::style("font-weight").with_get_attrs(|input| {
                        is_bold_weight(input.style_value()?).then(Attrs::new)
                    }),
                ],
                ..Default::default()
            },
        )
    }

    /// Inline code: it excludes every other mark (`excludes: "_"`), and the
    /// caret can leave it at its end. Its spec's `extra` has `code: true`
    /// too, for readers of the earlier form.
    pub fn code() -> (String, MarkSpec) {
        let mut extra = Attrs::new();
        extra.insert("code".into(), Value::Bool(true));
        (
            "code".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("code").hole()),
                code: true,
                excludes: Some("_".into()),
                exitable: true,
                parse_dom: vec![ParseRule::tag("code")],
                extra,
                ..Default::default()
            },
        )
    }

    /// Strikethrough.
    pub fn strike() -> (String, MarkSpec) {
        (
            "strike".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("s").hole()),
                parse_dom: vec![
                    ParseRule::tag("s"),
                    ParseRule::tag("del"),
                    ParseRule::tag("strike"),
                    ParseRule::style("text-decoration").with_get_attrs(|input| {
                        input
                            .style_value()?
                            .contains("line-through")
                            .then(Attrs::new)
                    }),
                    ParseRule::style("text-decoration-line").with_get_attrs(|input| {
                        input
                            .style_value()?
                            .contains("line-through")
                            .then(Attrs::new)
                    }),
                ],
                ..Default::default()
            },
        )
    }

    /// Underline.
    pub fn underline() -> (String, MarkSpec) {
        (
            "underline".into(),
            MarkSpec {
                to_dom: Some(DomOutputSpec::tag("u").hole()),
                parse_dom: vec![
                    ParseRule::tag("u"),
                    ParseRule::style("text-decoration").with_get_attrs(|input| {
                        input.style_value()?.contains("underline").then(Attrs::new)
                    }),
                    ParseRule::style("text-decoration-line").with_get_attrs(|input| {
                        input.style_value()?.contains("underline").then(Attrs::new)
                    }),
                ],
                ..Default::default()
            },
        )
    }
}

/// The starter schema's spec: every node of [`nodes`] and mark of
/// [`marks`], as the starter kit's extensions make them
/// ([`kit::starter_kit`]), for an app to extend before making its schema.
pub fn schema_spec() -> SchemaSpec {
    ExtensionManager::schema_spec(starter_manager().extensions())
}

/// The starter schema (the paragraph is the default block).
pub fn schema() -> Schema {
    starter_manager().schema().clone()
}

// The core extensions and the starter kit, resolved once.
fn starter_manager() -> &'static ExtensionManager {
    static MANAGER: OnceLock<ExtensionManager> = OnceLock::new();
    MANAGER.get_or_init(|| {
        ExtensionManager::with_core(vec![kit::starter_kit()]).expect("the starter kit is valid")
    })
}

// The starter kit's extensions in runtime order; their pieces are made
// against the schema they are asked for (an app's may have more types or
// fewer).
fn for_schema(_schema: &Schema) -> Vec<&'static Extension> {
    starter_manager().runtime_order()
}

fn commands() -> &'static CommandRegistry {
    starter_manager().commands()
}

/// Whether a CSS `font-weight` is bold: `bold`, `bolder` or 600 and up
/// (ProseMirror's basic schema takes 700 to 900; 600 is semibold, which
/// office suites write for bold too).
fn is_bold_weight(value: &str) -> bool {
    let value = value.trim();
    matches!(value, "bold" | "bolder") || value.parse::<f32>().is_ok_and(|w| w >= 600.0)
}

/// The language of a `<pre>`: a `data-language` attribute, or a
/// `language-*` / `lang-*` class of it or of its `<code>`.
fn code_language(pre: &DomElement) -> Option<String> {
    if let Some(lang) = pre.attr("data-language").filter(|l| !l.is_empty()) {
        return Some(lang.to_owned());
    }
    let code = pre.query_selector("code");
    [Some(pre), code].into_iter().flatten().find_map(|el| {
        el.attr("class")?.split_ascii_whitespace().find_map(|c| {
            c.strip_prefix("language-")
                .or_else(|| c.strip_prefix("lang-"))
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
        })
    })
}

pub(super) fn attrs_of(key: &str, value: Value) -> Attrs {
    let mut attrs = Attrs::new();
    attrs.insert(key.into(), value);
    attrs
}

/// The keys bound to commands, by normalized name on both kinds of platform.
fn key_id(name: &str) -> String {
    format!(
        "{}|{}",
        normalize_key_name(name, false).unwrap_or_else(|_| name.to_owned()),
        normalize_key_name(name, true).unwrap_or_else(|_| name.to_owned())
    )
}

/// Merges groups of bindings into one keymap, as Tiptap's keymap plugins
/// stack: a key bound in several groups runs their commands in the order of
/// the groups until one applies.
pub fn merge_keymaps(groups: Vec<Vec<(String, BoxCommand)>>) -> Vec<(String, BoxCommand)> {
    let mut order: Vec<(String, String, Vec<BoxCommand>)> = Vec::new();
    for (name, command) in groups.into_iter().flatten() {
        let id = key_id(&name);
        match order.iter_mut().find(|(i, _, _)| i == &id) {
            Some((_, _, commands)) => commands.push(command),
            None => order.push((id, name, vec![command])),
        }
    }
    order
        .into_iter()
        .map(|(_, name, mut commands)| {
            let command = if commands.len() == 1 {
                commands.remove(0)
            } else {
                chain_commands(commands)
            };
            (name, command)
        })
        .collect()
}

/// The keyboard shortcuts of Tiptap's extensions for the starter's types
/// that `schema` has, without the core and list keymaps: history (`Mod-z`,
/// `Shift-Mod-z`, `Mod-y`, `Mod-я`, `Shift-Mod-я`), marks (`Mod-b`,
/// `Mod-i`, `Mod-u`, `Mod-Shift-s` strike, `Mod-e` code, `Mod-Shift-h`
/// highlight, `Mod-,` subscript, `Mod-.` superscript), blocks (`Mod-Alt-0`
/// paragraph, `Mod-Alt-1`..`6` headings, `Mod-Shift-b` quote,
/// `Mod-Shift-7` / `8` / `9` ordered, bullet and task lists), `Mod-Shift-l`
/// / `e` / `r` / `j` text alignment, `Mod-Enter` / `Shift-Enter` hard
/// breaks, and list items' Enter, Tab and Shift-Tab.
pub fn extension_keymap(schema: &Schema) -> Vec<(String, BoxCommand)> {
    let mut keys = kit::history_keys();
    for name in [
        "bold",
        "italic",
        "underline",
        "strike",
        "code",
        "highlight",
        "subscript",
        "superscript",
    ] {
        keys.extend(kit::mark_keys(schema, name));
    }
    keys.extend(kit::paragraph_keys(schema));
    keys.extend(kit::heading_keys(schema, &[1, 2, 3, 4, 5, 6]));
    keys.extend(kit::blockquote_keys(schema));
    keys.extend(kit::list_keys(
        schema,
        "orderedList",
        "listItem",
        "Mod-Shift-7",
    ));
    keys.extend(kit::list_keys(
        schema,
        "bulletList",
        "listItem",
        "Mod-Shift-8",
    ));
    keys.extend(kit::list_keys(
        schema,
        "taskList",
        "taskItem",
        "Mod-Shift-9",
    ));
    keys.extend(kit::text_align_keys(
        schema,
        &["paragraph".to_owned(), "heading".to_owned()],
    ));
    keys.extend(kit::hard_break_keys(schema, true));
    keys.extend(kit::list_item_keys(schema));
    keys.extend(kit::task_item_keys(schema, false));
    keys
}

/// All of the starter's key bindings for `schema`: the starter kit's
/// extensions' and the core's ([`core_keymap`]), merged in Tiptap's order
/// (later extensions first, the core last, with its
/// `core_keymap`; [`ExtensionManager::keymap`]).
pub fn keymap(schema: &Schema) -> Vec<(String, BoxCommand)> {
    merge_keymaps(
        for_schema(schema)
            .into_iter()
            .map(|e| e.keyboard_shortcuts(schema, commands()))
            .filter(|g| !g.is_empty())
            .collect(),
    )
}

pub(super) fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid expression")
}

// Tiptap's expressions refuse delimiters around nothing but white space
// (`(?!\s+\*\*)`), which the `regex` crate cannot say.
pub(super) fn not_blank(found: &InputMatch) -> bool {
    found
        .groups
        .last()
        .and_then(|g| g.as_ref())
        .is_some_and(|(_, text)| !text.trim().is_empty())
}

/// Tiptap's input rules for the starter's types that `schema` has, after
/// the typography rules: `#`..`######` + space headings, `> ` quotes,
/// `- ` / `* ` / `+ ` bullet lists, `1. ` ordered lists (their `start`),
/// `[ ] ` / `[x] ` task lists, ```` ```lang ```` / `~~~lang` code blocks
/// (on space or Enter), `---` / `___ ` / `*** ` rules, `![alt](src
/// "title")` images, and `**bold**` / `__bold__`, `*italic*` / `_italic_`,
/// `~~strike~~`, `` `code` `` and `==highlight==`.
pub fn input_rules(schema: &Schema) -> Plugin {
    input_rules_plugin(input_rule_list(schema))
}

/// The rules of [`input_rules`] with Tiptap's default typography, for an
/// app to add to.
pub fn input_rule_list(schema: &Schema) -> Vec<InputRule> {
    let mut rules = typography(&TypographyOptions::default());
    rules.extend(type_rules(schema));
    rules
}

/// The rules of [`input_rules`] without typography.
pub fn type_rules(schema: &Schema) -> Vec<InputRule> {
    let mut rules = Vec::new();
    rules.extend(kit::blockquote_rules(schema));
    rules.extend(kit::bullet_list_rules(schema));
    rules.extend(kit::ordered_list_rules(schema));
    rules.extend(kit::task_item_rules(schema));
    rules.extend(kit::code_block_rules(schema));
    rules.extend(kit::heading_rules(schema, &[1, 2, 3, 4, 5, 6]));
    rules.extend(kit::horizontal_rule_rules(schema));
    rules.extend(kit::image_rules(schema));
    for name in ["bold", "italic", "strike", "highlight", "code"] {
        rules.extend(kit::mark_rules(schema, name));
    }
    rules
}

// Tiptap's paste expressions refuse a match followed by white space and
// the delimiter again (`(?!\s+\*\*)`).
pub(super) fn not_followed_by(
    delimiter: &'static str,
) -> impl Fn(&str, usize, &InputMatch) -> bool + Send + Sync + 'static {
    move |text, start, found| {
        let rest = &text[start + found.text.len()..];
        let trimmed = rest.trim_start();
        not_blank(found) && !(trimmed.len() < rest.len() && trimmed.starts_with(delimiter))
    }
}

/// Tiptap's paste rules for the starter's marks that `schema` has:
/// `**bold**` / `__bold__`, `*italic*` / `_italic_`, `~~strike~~`,
/// `` `code` `` and `==highlight==` in pasted text.
pub fn paste_rule_list(schema: &Schema) -> Vec<PasteRule> {
    ["bold", "italic", "strike", "highlight", "code"]
        .into_iter()
        .flat_map(|name| kit::mark_paste_rules(schema, name))
        .collect()
}

/// The starter's plugins for `schema`, as the core extensions and the
/// starter kit make them ([`ExtensionManager::plugins`]): the input rules'
/// and paste rules' plugins, the keymap ([`keymap`]), then the
/// extensions' plugins (the trailing node, the history, the core's
/// `clearDocument`).
pub fn plugins(schema: &Schema) -> Vec<Plugin> {
    let extensions = for_schema(schema);
    let mut plugins = Vec::new();
    let input: Vec<InputRule> = extensions
        .iter()
        .flat_map(|e| e.input_rules(schema, commands()))
        .collect();
    if !input.is_empty() {
        plugins.push(input_rules_plugin(input));
    }
    let paste: Vec<PasteRule> = extensions
        .iter()
        .flat_map(|e| e.paste_rules(schema, commands()))
        .collect();
    if !paste.is_empty() {
        plugins.push(paste_rules(paste));
    }
    plugins.push(keymap_plugin(keymap(schema)));
    for extension in extensions {
        plugins.extend(extension.plugins(schema, commands()));
    }
    plugins
}
