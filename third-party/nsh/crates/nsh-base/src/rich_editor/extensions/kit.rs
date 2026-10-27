//! The built-in extensions: Tiptap's StarterKit's (`Document`,
//! `Paragraph`, `Text`, `Heading`, `Blockquote`, `BulletList`,
//! `OrderedList`, `ListItem`, `CodeBlock`, `HardBreak`, `HorizontalRule`,
//! `Bold`, `Italic`, `Strike`, `Code`, `Underline`, `Link`, `History`,
//! `TrailingNode`, `ListKeymap`) with `TaskList` / `TaskItem`, `Image`,
//! `Highlight`, `Subscript`, `Superscript`, `TextStyle`, `TextAlign` and
//! `Typography`, each with its Tiptap name, options, shortcuts, rules and
//! commands, and [`starter_kit`], the extension bringing them (each left
//! out with `configure({ name: false })` or configured with `configure({
//! name: {...} })`). The core keymap ([`core_keymap`]) is the core
//! extension every editor has. The pieces each extension adds are
//! functions of the schema too, so the starter's plain functions
//! (`starter::keymap`, `starter::type_rules`, ...) are made of them.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{
    clear_document::clear_document,
    code_block::{CodeBlockOptions, code_block_keymap, fence_language},
    core_keymap::core_keymap as core_bindings,
    extension::{Extension, GlobalAttributes},
    helpers::{set_hard_break, update_attribute},
    history::{HistoryOptions, history as history_plugin, redo, undo},
    input_rules::{
        GetAttrs, InputMatch, InputRule, JoinPredicate, mark_input_rule, node_input_rule, number,
        textblock_type_input_rule, wrapping_input_rule,
    },
    list_keymap::{ListKeymapOptions, list_keymap as list_bindings},
    paste_rules::{PasteAction, PasteRule},
    starter::{attrs_of, marks, nodes, not_blank, not_followed_by, regex, styled_attr},
    trailing_node::{TrailingNodeOptions, trailing_node as trailing_node_plugin},
    typography::{TypographyOptions, typography as typography_rules},
};
use crate::rich_editor::{
    commands::{
        BoxCommand, CommandFactory, command, lift_list_item, registry::content_fragment,
        sink_list_item, split_list_item, tiptap, toggle_mark, wrap_in,
    },
    model::{Attrs, MarkType, NodeType, Schema},
};

// --- Options -----------------------------------------------------------------

fn opt_bool(options: &Value, key: &str, default: bool) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn opt_strings(options: &Value, key: &str, default: &[&str]) -> Vec<String> {
    match options.get(key).and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        None => default.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// The heading levels of `options` (`levels`, 1 to 6 by default).
fn levels(options: &Value) -> Vec<u64> {
    match options.get("levels").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_u64)
            .filter(|l| (1..=6).contains(l))
            .collect(),
        None => (1..=6).collect(),
    }
}

fn args_attrs(args: &Value) -> Attrs {
    args.as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

fn factory(
    f: impl Fn(&Value, &Schema) -> Result<BoxCommand, String> + Send + Sync + 'static,
) -> CommandFactory {
    Arc::new(f)
}

fn node_of(schema: &Schema, name: &str) -> Result<NodeType, String> {
    schema
        .node_type(name)
        .ok_or_else(|| format!("the schema has no node type `{name}`"))
}

fn mark_of(schema: &Schema, name: &str) -> Result<MarkType, String> {
    schema
        .mark_type(name)
        .ok_or_else(|| format!("the schema has no mark type `{name}`"))
}

fn never() -> BoxCommand {
    command(|_, _| false)
}

// Inserts the node `content` describes (`{ type, attrs }`) at the selection.
fn insert_node(schema: &Schema, content: Value) -> Result<BoxCommand, String> {
    let fragment = content_fragment(schema, &content)?;
    Ok(tiptap::insert_content(fragment, Default::default()))
}

// --- The pieces, as functions of the schema ------------------------------------

/// The history's bindings: `Mod-z` undo, `Shift-Mod-z` / `Mod-y` redo, and
/// the Russian layout's `Mod-я` / `Shift-Mod-я`.
pub fn history_keys() -> Vec<(String, BoxCommand)> {
    vec![
        ("Mod-z".into(), command(undo)),
        ("Shift-Mod-z".into(), command(redo)),
        ("Mod-y".into(), command(redo)),
        ("Mod-я".into(), command(undo)),
        ("Shift-Mod-я".into(), command(redo)),
    ]
}

/// The bindings of the mark `name`'s extension (`Mod-b` bold, ...), when
/// `schema` has it.
pub fn mark_keys(schema: &Schema, name: &str) -> Vec<(String, BoxCommand)> {
    let bindings: &[&str] = match name {
        "bold" => &["Mod-b", "Mod-B"],
        "italic" => &["Mod-i", "Mod-I"],
        "underline" => &["Mod-u", "Mod-U"],
        "strike" => &["Mod-Shift-s"],
        "code" => &["Mod-e"],
        "highlight" => &["Mod-Shift-h"],
        "subscript" => &["Mod-,"],
        "superscript" => &["Mod-."],
        _ => &[],
    };
    let Some(ty) = schema.mark_type(name) else {
        return Vec::new();
    };
    bindings
        .iter()
        .map(|key| ((*key).into(), toggle_mark(ty.clone(), None, true)))
        .collect()
}

/// `Mod-Alt-0`: the selection's blocks to paragraphs.
pub fn paragraph_keys(schema: &Schema) -> Vec<(String, BoxCommand)> {
    schema
        .node_type("paragraph")
        .map(|ty| vec![("Mod-Alt-0".into(), tiptap::set_node(ty, Attrs::new()))])
        .unwrap_or_default()
}

/// `Mod-Alt-1`..`6`: headings of `levels`, toggling back to paragraphs.
pub fn heading_keys(schema: &Schema, levels: &[u64]) -> Vec<(String, BoxCommand)> {
    let (Some(ty), Some(paragraph)) = (schema.node_type("heading"), schema.node_type("paragraph"))
    else {
        return Vec::new();
    };
    levels
        .iter()
        .map(|level| {
            (
                format!("Mod-Alt-{level}"),
                tiptap::toggle_node(
                    ty.clone(),
                    paragraph.clone(),
                    attrs_of("level", Value::from(*level)),
                ),
            )
        })
        .collect()
}

/// `Mod-Shift-b`: in or out of a quote.
pub fn blockquote_keys(schema: &Schema) -> Vec<(String, BoxCommand)> {
    schema
        .node_type("blockquote")
        .map(|ty| vec![("Mod-Shift-b".into(), tiptap::toggle_wrap(ty, Attrs::new()))])
        .unwrap_or_default()
}

/// `key` toggling a list of `list` with items of `item`.
pub fn list_keys(schema: &Schema, list: &str, item: &str, key: &str) -> Vec<(String, BoxCommand)> {
    match (schema.node_type(list), schema.node_type(item)) {
        (Some(list), Some(item)) => vec![(
            key.into(),
            tiptap::toggle_list(list, item, false, Attrs::new()),
        )],
        _ => Vec::new(),
    }
}

/// `Mod-Shift-l` / `e` / `r` / `j`: the text alignment of the blocks of
/// `types` (`paragraph`, `heading`).
pub fn text_align_keys(schema: &Schema, types: &[String]) -> Vec<(String, BoxCommand)> {
    let aligned: Vec<_> = types.iter().filter_map(|n| schema.node_type(n)).collect();
    [
        ("Mod-Shift-l", "left"),
        ("Mod-Shift-e", "center"),
        ("Mod-Shift-r", "right"),
        ("Mod-Shift-j", "justify"),
    ]
    .into_iter()
    .map(|(key, align)| {
        (
            key.into(),
            update_attribute(aligned.clone(), "textAlign", Value::from(align)),
        )
    })
    .collect()
}

/// `Mod-Enter` / `Shift-Enter`: a hard break.
pub fn hard_break_keys(schema: &Schema, keep_marks: bool) -> Vec<(String, BoxCommand)> {
    let Some(ty) = schema.node_type("hardBreak") else {
        return Vec::new();
    };
    let line_break = set_hard_break(ty, keep_marks);
    vec![
        ("Mod-Enter".into(), line_break.clone()),
        ("Shift-Enter".into(), line_break),
    ]
}

/// A list item's `Enter`, `Tab` and `Shift-Tab`.
pub fn list_item_keys(schema: &Schema) -> Vec<(String, BoxCommand)> {
    let Some(ty) = schema.node_type("listItem") else {
        return Vec::new();
    };
    vec![
        ("Enter".into(), split_list_item(ty.clone(), None)),
        ("Tab".into(), sink_list_item(ty.clone())),
        ("Shift-Tab".into(), lift_list_item(ty)),
    ]
}

/// A task item's `Enter` and `Shift-Tab` (Tiptap's are not nested by
/// default: no `Tab`), `Tab` too when `nested`.
pub fn task_item_keys(schema: &Schema, nested: bool) -> Vec<(String, BoxCommand)> {
    let Some(ty) = schema.node_type("taskItem") else {
        return Vec::new();
    };
    let mut keys: Vec<(String, BoxCommand)> =
        vec![("Enter".into(), split_list_item(ty.clone(), None))];
    if nested {
        keys.push(("Tab".into(), sink_list_item(ty.clone())));
    }
    keys.push(("Shift-Tab".into(), lift_list_item(ty)));
    keys
}

/// `> ` at a textblock's start: a quote.
pub fn blockquote_rules(schema: &Schema) -> Vec<InputRule> {
    schema
        .node_type("blockquote")
        .map(|ty| vec![wrapping_input_rule(regex(r"^\s*>\s$"), ty, None, None)])
        .unwrap_or_default()
}

/// `- `, `* ` or `+ `: a bullet list.
pub fn bullet_list_rules(schema: &Schema) -> Vec<InputRule> {
    schema
        .node_type("bulletList")
        .map(|ty| {
            vec![wrapping_input_rule(
                regex(r"^\s*([-+*])\s$"),
                ty,
                None,
                None,
            )]
        })
        .unwrap_or_default()
}

/// `1. `: an ordered list starting there, joining the list before it when
/// it continues its numbering.
pub fn ordered_list_rules(schema: &Schema) -> Vec<InputRule> {
    let Some(ty) = schema.node_type("orderedList") else {
        return Vec::new();
    };
    let get_attrs: GetAttrs =
        Arc::new(|found| found.group(1).map(|start| attrs_of("start", number(start))));
    let join: JoinPredicate = Arc::new(|found, node| {
        let wanted = found.group(1).and_then(|n| n.parse::<u64>().ok());
        let start = node
            .attrs()
            .get("start")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        wanted == Some(node.child_count() as u64 + start)
    });
    vec![wrapping_input_rule(
        regex(r"^(\d+)\.\s$"),
        ty,
        Some(get_attrs),
        Some(join),
    )]
}

/// `[ ] ` / `[x] `: a task, checked or not.
pub fn task_item_rules(schema: &Schema) -> Vec<InputRule> {
    let Some(ty) = schema.node_type("taskItem") else {
        return Vec::new();
    };
    let get_attrs: GetAttrs = Arc::new(|found| {
        let checked = found
            .groups
            .last()
            .and_then(|g| g.as_ref())
            .is_some_and(|(_, t)| t == "x");
        Some(attrs_of("checked", Value::Bool(checked)))
    });
    vec![wrapping_input_rule(
        regex(r"^\s*(\[([( |x])?\])\s$"),
        ty,
        Some(get_attrs),
        None,
    )]
}

/// ```` ```lang ```` / `~~~lang` (on space or Enter): a code block.
pub fn code_block_rules(schema: &Schema) -> Vec<InputRule> {
    let Some(ty) = schema.node_type("codeBlock") else {
        return Vec::new();
    };
    ["```", "~~~"]
        .into_iter()
        .map(|fence| {
            let get_attrs: GetAttrs =
                Arc::new(|found| Some(attrs_of("language", fence_language(found.group(1)))));
            textblock_type_input_rule(
                regex(&format!(r"^{fence}([a-z]+)?[\s\n]$")),
                ty.clone(),
                Some(get_attrs),
            )
        })
        .collect()
}

/// `#` .. `######` and a space: a heading of a level of `levels`.
pub fn heading_rules(schema: &Schema, levels: &[u64]) -> Vec<InputRule> {
    let Some(ty) = schema.node_type("heading") else {
        return Vec::new();
    };
    let min = levels.iter().copied().min().unwrap_or(1);
    levels
        .iter()
        .map(|&level| {
            textblock_type_input_rule(
                regex(&format!(r"^(#{{{min},{level}}})\s$")),
                ty.clone(),
                Some(Arc::new(move |_| {
                    Some(attrs_of("level", Value::from(level)))
                })),
            )
        })
        .collect()
}

/// `---`, `___ ` or `*** `: a horizontal rule.
pub fn horizontal_rule_rules(schema: &Schema) -> Vec<InputRule> {
    schema
        .node_type("horizontalRule")
        .map(|ty| {
            vec![node_input_rule(
                regex(r"^(?:---|\u{2014}-|___\s|\*\*\*\s)$"),
                ty,
                None,
            )]
        })
        .unwrap_or_default()
}

/// `![alt](src "title")`: an image.
pub fn image_rules(schema: &Schema) -> Vec<InputRule> {
    let Some(ty) = schema.node_type("image") else {
        return Vec::new();
    };
    let get_attrs: GetAttrs = Arc::new(|found| {
        let group = |i| found.group(i).map_or(Value::Null, Value::from);
        let mut attrs = attrs_of("src", group(3));
        attrs.insert("alt".into(), group(2));
        attrs.insert("title".into(), group(4));
        Some(attrs)
    });
    vec![node_input_rule(
        regex(r#"(?:^|\s)(!\[(.+|:?)\]\((\S+)(?:(?:\s+)["'](\S+)["'])?\))$"#),
        ty,
        Some(get_attrs),
    )]
}

/// The input rules of the mark `name`'s extension: `**bold**` /
/// `__bold__`, `*italic*` / `_italic_`, `~~strike~~`, `==highlight==` and
/// `` `code` ``.
pub fn mark_rules(schema: &Schema, name: &str) -> Vec<InputRule> {
    let Some(ty) = schema.mark_type(name) else {
        return Vec::new();
    };
    if name == "code" {
        // Tiptap's finder: the backticks alone (the character before
        // stays), not after another backtick.
        return vec![
            mark_input_rule(regex("`([^`]+)`$"), ty, None).with_finder(|text| {
                let captures = regex("`([^`]+)`$").captures(text)?;
                let start = captures.get(0)?.start();
                if text[..start].ends_with('`') {
                    return None;
                }
                Some(InputMatch::from_captures(text, &captures))
            }),
        ];
    }
    mark_patterns(name)
        .iter()
        .map(|(pattern, _)| {
            mark_input_rule(regex(&format!("{pattern}$")), ty.clone(), None).accepting(not_blank)
        })
        .collect()
}

// The delimited forms of a mark and their delimiters.
fn mark_patterns(name: &str) -> &'static [(&'static str, &'static str)] {
    match name {
        "bold" => &[
            (r"(?:^|\s)(\*\*([^*]+)\*\*)", "**"),
            (r"(?:^|\s)(__([^_]+)__)", "__"),
        ],
        "italic" => &[
            (r"(?:^|\s)(\*([^*]+)\*)", "*"),
            (r"(?:^|\s)(_([^_]+)_)", "_"),
        ],
        "strike" => &[(r"(?:^|\s)(~~([^~]+)~~)", "~~")],
        "highlight" => &[(r"(?:^|\s)(==([^=]+)==)", "==")],
        _ => &[],
    }
}

/// The paste rules of the mark `name`'s extension: its delimited form in
/// pasted text.
pub fn mark_paste_rules(schema: &Schema, name: &str) -> Vec<PasteRule> {
    let Some(ty) = schema.mark_type(name) else {
        return Vec::new();
    };
    if name == "code" {
        return vec![PasteRule::regex(
            regex("`([^`]+)`"),
            |text, start, found| {
                !text[..start].ends_with('`') && !text[start + found.text.len()..].starts_with('`')
            },
            PasteAction::Mark(ty, None),
        )];
    }
    mark_patterns(name)
        .iter()
        .map(|(pattern, delimiter)| {
            PasteRule::regex(
                regex(pattern),
                not_followed_by(delimiter),
                PasteAction::Mark(ty.clone(), None),
            )
        })
        .collect()
}

// --- The extensions ------------------------------------------------------------

/// The core keymap (Tiptap's core `keymap` extension): Enter, Backspace,
/// Delete, select all and the platform's editing keys, and the
/// `clearDocument` plugin.
pub fn core_keymap() -> Extension {
    Extension::new("keymap")
        .add_keyboard_shortcuts(|_| core_bindings())
        .add_plugins(|_| vec![clear_document()])
}

/// The document (`doc`): one block or more; the top node.
pub fn document() -> Extension {
    Extension::node("doc", |_| nodes::doc().1).with_top_node()
}

/// `paragraph`: `Mod-Alt-0`; `setParagraph`.
pub fn paragraph() -> Extension {
    Extension::node("paragraph", |_| {
        let mut spec = nodes::paragraph().1;
        spec.attrs.retain(|(name, _)| name != "textAlign");
        spec
    })
    .add_keyboard_shortcuts(|cx| paragraph_keys(cx.schema))
    .add_commands(|_| {
        vec![(
            "setParagraph".into(),
            factory(|_, s| Ok(tiptap::set_node(node_of(s, "paragraph")?, Attrs::new()))),
        )]
    })
}

/// `text`.
pub fn text() -> Extension {
    Extension::node("text", |_| nodes::text().1)
}

/// `heading` with the option `levels` (1 to 6): `Mod-Alt-1`..`6`, `# `
/// rules; `setHeading({ level })`, `toggleHeading({ level })`.
pub fn heading() -> Extension {
    Extension::node("heading", |_| {
        let mut spec = nodes::heading().1;
        spec.attrs.retain(|(name, _)| name != "textAlign");
        spec
    })
    .with_options(json!({ "levels": [1, 2, 3, 4, 5, 6] }))
    .add_keyboard_shortcuts(|cx| heading_keys(cx.schema, &levels(cx.options)))
    .add_input_rules(|cx| heading_rules(cx.schema, &levels(cx.options)))
    .add_commands(|options| {
        let allowed = levels(options);
        let level_ok = move |args: &Value| {
            args.get("level")
                .and_then(Value::as_u64)
                .is_some_and(|l| allowed.contains(&l))
        };
        let set_ok = level_ok.clone();
        vec![
            (
                "setHeading".into(),
                factory(move |args, s| {
                    if !set_ok(args) {
                        return Ok(never());
                    }
                    Ok(tiptap::set_node(node_of(s, "heading")?, args_attrs(args)))
                }),
            ),
            (
                "toggleHeading".into(),
                factory(move |args, s| {
                    if !level_ok(args) {
                        return Ok(never());
                    }
                    Ok(tiptap::toggle_node(
                        node_of(s, "heading")?,
                        node_of(s, "paragraph")?,
                        args_attrs(args),
                    ))
                }),
            ),
        ]
    })
}

/// `blockquote`: `Mod-Shift-b`, `> `; `setBlockquote`,
/// `toggleBlockquote`, `unsetBlockquote`.
pub fn blockquote() -> Extension {
    Extension::node("blockquote", |_| nodes::blockquote().1)
        .add_keyboard_shortcuts(|cx| blockquote_keys(cx.schema))
        .add_input_rules(|cx| blockquote_rules(cx.schema))
        .add_commands(|_| {
            vec![
                (
                    "setBlockquote".into(),
                    factory(|_, s| Ok(wrap_in(node_of(s, "blockquote")?, None))),
                ),
                (
                    "toggleBlockquote".into(),
                    factory(|_, s| {
                        Ok(tiptap::toggle_wrap(node_of(s, "blockquote")?, Attrs::new()))
                    }),
                ),
                (
                    "unsetBlockquote".into(),
                    factory(|_, s| Ok(tiptap::lift(node_of(s, "blockquote")?, Attrs::new()))),
                ),
            ]
        })
}

/// `horizontalRule`: `---`; `setHorizontalRule`.
pub fn horizontal_rule() -> Extension {
    Extension::node("horizontalRule", |_| nodes::horizontal_rule().1)
        .add_input_rules(|cx| horizontal_rule_rules(cx.schema))
        .add_commands(|_| {
            vec![(
                "setHorizontalRule".into(),
                factory(|_, s| insert_node(s, json!({ "type": "horizontalRule" }))),
            )]
        })
}

/// `codeBlock` with Tiptap's options (`exitOnTripleEnter`,
/// `exitOnArrowDown`, `exitOnArrowUp`, `enableTabIndentation`, `tabSize`):
/// its keys, fences; `setCodeBlock({ language })`, `toggleCodeBlock`.
pub fn code_block() -> Extension {
    Extension::node("codeBlock", |_| nodes::code_block().1)
        .with_options(json!({
            "exitOnTripleEnter": true,
            "exitOnArrowDown": true,
            "exitOnArrowUp": true,
            "enableTabIndentation": false,
            "tabSize": 4,
        }))
        .add_keyboard_shortcuts(|cx| {
            let Some(ty) = cx.schema.node_type("codeBlock") else {
                return Vec::new();
            };
            let o = cx.options;
            let options = CodeBlockOptions {
                exit_on_triple_enter: opt_bool(o, "exitOnTripleEnter", true),
                exit_on_arrow_down: opt_bool(o, "exitOnArrowDown", true),
                exit_on_arrow_up: opt_bool(o, "exitOnArrowUp", true),
                enable_tab_indentation: opt_bool(o, "enableTabIndentation", false),
                tab_size: o.get("tabSize").and_then(Value::as_u64).unwrap_or(4) as usize,
                ..CodeBlockOptions::default()
            };
            code_block_keymap(&ty, cx.schema.node_type("paragraph"), &options)
        })
        .add_input_rules(|cx| code_block_rules(cx.schema))
        .add_commands(|_| {
            vec![
                (
                    "setCodeBlock".into(),
                    factory(|args, s| {
                        Ok(tiptap::set_node(node_of(s, "codeBlock")?, args_attrs(args)))
                    }),
                ),
                (
                    "toggleCodeBlock".into(),
                    factory(|args, s| {
                        Ok(tiptap::toggle_node(
                            node_of(s, "codeBlock")?,
                            node_of(s, "paragraph")?,
                            args_attrs(args),
                        ))
                    }),
                ),
            ]
        })
}

/// `image`: `![alt](src)`; `setImage({ src, alt, title })`.
pub fn image() -> Extension {
    Extension::node("image", |_| nodes::image().1)
        .add_input_rules(|cx| image_rules(cx.schema))
        .add_commands(|_| {
            vec![(
                "setImage".into(),
                factory(|args, s| insert_node(s, json!({ "type": "image", "attrs": args }))),
            )]
        })
}

/// `hardBreak` with the option `keepMarks` (true): `Mod-Enter`,
/// `Shift-Enter`; `setHardBreak`.
pub fn hard_break() -> Extension {
    Extension::node("hardBreak", |_| nodes::hard_break().1)
        .with_options(json!({ "keepMarks": true }))
        .add_keyboard_shortcuts(|cx| {
            hard_break_keys(cx.schema, opt_bool(cx.options, "keepMarks", true))
        })
        .add_commands(|options| {
            let keep = opt_bool(options, "keepMarks", true);
            vec![(
                "setHardBreak".into(),
                factory(move |_, s| Ok(set_hard_break(node_of(s, "hardBreak")?, keep))),
            )]
        })
}

// A list extension: its node, toggle key, rules and toggle command.
fn list(
    name: &'static str,
    spec: fn() -> (String, crate::rich_editor::model::NodeSpec),
    item: &'static str,
    key: &'static str,
    rules: fn(&Schema) -> Vec<InputRule>,
    toggle: &'static str,
) -> Extension {
    Extension::node(name, move |_| spec().1)
        .with_options(json!({ "itemTypeName": item, "keepMarks": false }))
        .add_keyboard_shortcuts(move |cx| {
            let item = cx.options["itemTypeName"].as_str().unwrap_or(item);
            list_keys(cx.schema, name, item, key)
        })
        .add_input_rules(move |cx| rules(cx.schema))
        .add_commands(move |options| {
            let item = options["itemTypeName"].as_str().unwrap_or(item).to_owned();
            let keep = opt_bool(options, "keepMarks", false);
            vec![(
                toggle.into(),
                factory(move |_, s| {
                    Ok(tiptap::toggle_list(
                        node_of(s, name)?,
                        node_of(s, &item)?,
                        keep,
                        Attrs::new(),
                    ))
                }),
            )]
        })
}

/// `bulletList`: `Mod-Shift-8`, `- `; `toggleBulletList`.
pub fn bullet_list() -> Extension {
    list(
        "bulletList",
        nodes::bullet_list,
        "listItem",
        "Mod-Shift-8",
        bullet_list_rules,
        "toggleBulletList",
    )
}

/// `orderedList`: `Mod-Shift-7`, `1. `; `toggleOrderedList`.
pub fn ordered_list() -> Extension {
    list(
        "orderedList",
        nodes::ordered_list,
        "listItem",
        "Mod-Shift-7",
        ordered_list_rules,
        "toggleOrderedList",
    )
}

/// `taskList`: `Mod-Shift-9`; `toggleTaskList`.
pub fn task_list() -> Extension {
    list(
        "taskList",
        nodes::task_list,
        "taskItem",
        "Mod-Shift-9",
        |_| Vec::new(),
        "toggleTaskList",
    )
}

/// `listItem`: `Enter`, `Tab`, `Shift-Tab`.
pub fn list_item() -> Extension {
    Extension::node("listItem", |_| nodes::list_item().1)
        .add_keyboard_shortcuts(|cx| list_item_keys(cx.schema))
}

/// `taskItem` with the option `nested` (false): `Enter`, `Shift-Tab`
/// (`Tab` when nested), `[ ] ` / `[x] `.
pub fn task_item() -> Extension {
    Extension::node("taskItem", |_| nodes::task_item().1)
        .with_options(json!({ "nested": false }))
        .add_keyboard_shortcuts(|cx| {
            task_item_keys(cx.schema, opt_bool(cx.options, "nested", false))
        })
        .add_input_rules(|cx| task_item_rules(cx.schema))
}

// A mark extension: its spec, keys, rules and `set` / `toggle` / `unset`
// commands (`setBold`, `toggleBold`, `unsetBold`).
fn mark(
    name: &'static str,
    spec: fn() -> (String, crate::rich_editor::model::MarkSpec),
) -> Extension {
    let title = {
        let mut chars = name.chars();
        chars
            .next()
            .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
            .unwrap_or_default()
    };
    Extension::mark(name, move |_| spec().1)
        .add_keyboard_shortcuts(move |cx| mark_keys(cx.schema, name))
        .add_input_rules(move |cx| mark_rules(cx.schema, name))
        .add_paste_rules(move |cx| mark_paste_rules(cx.schema, name))
        .add_commands(move |_| mark_commands(name, &title, false))
}

fn mark_commands(name: &'static str, title: &str, extend: bool) -> Vec<(String, CommandFactory)> {
    vec![
        (
            format!("set{title}"),
            factory(move |args, s| Ok(tiptap::set_mark(mark_of(s, name)?, args_attrs(args)))),
        ),
        (
            format!("toggle{title}"),
            factory(move |args, s| {
                Ok(tiptap::toggle_mark(
                    mark_of(s, name)?,
                    args_attrs(args),
                    extend,
                ))
            }),
        ),
        (
            format!("unset{title}"),
            factory(move |_, s| Ok(tiptap::unset_mark(mark_of(s, name)?, extend))),
        ),
    ]
}

/// `bold`: `Mod-b`, `**text**`; `setBold`, `toggleBold`, `unsetBold`.
pub fn bold() -> Extension {
    mark("bold", marks::bold)
}

/// `italic`: `Mod-i`, `*text*`; `setItalic`, `toggleItalic`,
/// `unsetItalic`.
pub fn italic() -> Extension {
    mark("italic", marks::italic)
}

/// `strike`: `Mod-Shift-s`, `~~text~~`; `setStrike`, `toggleStrike`,
/// `unsetStrike`.
pub fn strike() -> Extension {
    mark("strike", marks::strike)
}

/// `code`: `Mod-e`, `` `text` ``; `setCode`, `toggleCode`, `unsetCode`.
pub fn code() -> Extension {
    mark("code", marks::code)
}

/// `underline`: `Mod-u`; `setUnderline`, `toggleUnderline`,
/// `unsetUnderline`.
pub fn underline() -> Extension {
    mark("underline", marks::underline)
}

/// `highlight`: `Mod-Shift-h`, `==text==`; `setHighlight({ color })`,
/// `toggleHighlight`, `unsetHighlight`.
pub fn highlight() -> Extension {
    mark("highlight", marks::highlight)
}

/// `subscript`: `Mod-,`; `setSubscript`, `toggleSubscript`,
/// `unsetSubscript`.
pub fn subscript() -> Extension {
    mark("subscript", marks::subscript)
}

/// `superscript`: `Mod-.`; `setSuperscript`, `toggleSuperscript`,
/// `unsetSuperscript`.
pub fn superscript() -> Extension {
    mark("superscript", marks::superscript)
}

/// `textStyle` (`color`, `fontFamily`, `fontSize`, `backgroundColor`);
/// `setTextStyle(attrs)`, `unsetTextStyle`.
pub fn text_style() -> Extension {
    Extension::mark("textStyle", |_| marks::text_style().1).add_commands(|_| {
        let mut commands = mark_commands("textStyle", "TextStyle", false);
        commands.retain(|(name, _)| name != "toggleTextStyle");
        commands
    })
}

/// `link` (`href`, `title`). Its commands (`setLink`, `toggleLink`,
/// `unsetLink`) are built in (`extensions::link`), as are autolinking,
/// linking on paste and opening on click, which that module's plugins add.
pub fn link() -> Extension {
    Extension::mark("link", |_| marks::link().1)
}

/// `textAlign` with Tiptap's options (`types`: `heading`, `paragraph`;
/// `alignments`; `defaultAlignment`): the `textAlign` attribute of those
/// types, `Mod-Shift-l` / `e` / `r` / `j`; `setTextAlign(alignment)`,
/// `unsetTextAlign`.
pub fn text_align() -> Extension {
    Extension::new("textAlign")
        .with_options(json!({
            "types": ["heading", "paragraph"],
            "alignments": ["left", "center", "right", "justify"],
            "defaultAlignment": null,
        }))
        .add_global_attributes(|options| {
            let mut attr = styled_attr("text-align");
            attr.default = Some(
                options
                    .get("defaultAlignment")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            vec![GlobalAttributes::new(
                opt_strings(options, "types", &["heading", "paragraph"]),
                vec![("textAlign".into(), attr)],
            )]
        })
        .add_keyboard_shortcuts(|cx| {
            // Paragraphs first, as the starter's keymap always had them.
            let mut types = opt_strings(cx.options, "types", &["heading", "paragraph"]);
            types.sort_by_key(|t| t != "paragraph");
            text_align_keys(cx.schema, &types)
        })
        .add_commands(|options| {
            let types = opt_strings(options, "types", &["heading", "paragraph"]);
            let alignments = opt_strings(
                options,
                "alignments",
                &["left", "center", "right", "justify"],
            );
            let unset_types = types.clone();
            vec![
                (
                    "setTextAlign".into(),
                    factory(move |args, s| {
                        let alignment = args
                            .as_str()
                            .or_else(|| args.get("alignment").and_then(Value::as_str))
                            .ok_or("setTextAlign needs an alignment")?;
                        if !alignments.iter().any(|a| a == alignment) {
                            return Ok(never());
                        }
                        let types = types.iter().filter_map(|n| s.node_type(n)).collect();
                        Ok(update_attribute(types, "textAlign", Value::from(alignment)))
                    }),
                ),
                (
                    "unsetTextAlign".into(),
                    factory(move |_, s| {
                        let types = unset_types.iter().filter_map(|n| s.node_type(n)).collect();
                        Ok(update_attribute(types, "textAlign", Value::Null))
                    }),
                ),
            ]
        })
}

/// The undo history (`history`; Tiptap 3's `undoRedo`) with the options
/// `depth` (100) and `newGroupDelay` (500 ms): its keys and plugin.
pub fn history() -> Extension {
    Extension::new("history")
        .with_options(json!({ "depth": 100, "newGroupDelay": 500 }))
        .add_keyboard_shortcuts(|_| history_keys())
        .add_plugins(|cx| {
            let mut options = HistoryOptions::default();
            if let Some(depth) = cx.options.get("depth").and_then(Value::as_u64) {
                options.depth = depth as usize;
            }
            if let Some(delay) = cx.options.get("newGroupDelay").and_then(Value::as_u64) {
                options.new_group_delay_ms = delay;
            }
            vec![history_plugin(options)]
        })
}

/// `trailingNode` with the options `node` (the default block) and
/// `notAfter`: keeps a node of that type at the document's end.
pub fn trailing_node() -> Extension {
    Extension::new("trailingNode").add_plugins(|cx| {
        let mut options = TrailingNodeOptions::default();
        options.node = cx
            .options
            .get("node")
            .and_then(Value::as_str)
            .map(str::to_owned);
        options.not_after = opt_strings(cx.options, "notAfter", &[]);
        vec![trailing_node_plugin(options)]
    })
}

/// `typography`: Tiptap's typographic replacements, each turned off with
/// `false` or replaced with a string (`emDash`, `ellipsis`,
/// `openDoubleQuote`, ..., `threeQuarters`).
pub fn typography() -> Extension {
    Extension::new("typography")
        .add_input_rules(|cx| typography_rules(&typography_options(cx.options)))
}

fn typography_options(options: &Value) -> TypographyOptions {
    let mut out = TypographyOptions::default();
    let fields: [(&str, &mut Option<String>); 22] = [
        ("emDash", &mut out.em_dash),
        ("ellipsis", &mut out.ellipsis),
        ("openDoubleQuote", &mut out.open_double_quote),
        ("closeDoubleQuote", &mut out.close_double_quote),
        ("openSingleQuote", &mut out.open_single_quote),
        ("closeSingleQuote", &mut out.close_single_quote),
        ("leftArrow", &mut out.left_arrow),
        ("rightArrow", &mut out.right_arrow),
        ("copyright", &mut out.copyright),
        ("trademark", &mut out.trademark),
        ("servicemark", &mut out.servicemark),
        ("registeredTrademark", &mut out.registered_trademark),
        ("oneHalf", &mut out.one_half),
        ("plusMinus", &mut out.plus_minus),
        ("notEqual", &mut out.not_equal),
        ("laquo", &mut out.laquo),
        ("raquo", &mut out.raquo),
        ("multiplication", &mut out.multiplication),
        ("superscriptTwo", &mut out.superscript_two),
        ("superscriptThree", &mut out.superscript_three),
        ("oneQuarter", &mut out.one_quarter),
        ("threeQuarters", &mut out.three_quarters),
    ];
    for (key, field) in fields {
        match options.get(key) {
            Some(Value::Bool(false)) => *field = None,
            Some(Value::String(text)) => *field = Some(text.clone()),
            _ => {}
        }
    }
    out
}

/// `listKeymap`: Tiptap's list keymap (Backspace and Delete at list items'
/// edges, Tab).
pub fn list_keymap() -> Extension {
    Extension::new("listKeymap")
        .add_keyboard_shortcuts(|_| list_bindings(&ListKeymapOptions::default()))
}

/// The starter kit's extensions with their option keys (Tiptap's
/// StarterKit names, `document` for the `doc` node), in the order the
/// starter schema has its types.
pub fn starter_kit_extensions() -> Vec<(&'static str, Extension)> {
    vec![
        ("document", document()),
        ("paragraph", paragraph()),
        ("blockquote", blockquote()),
        ("horizontalRule", horizontal_rule()),
        ("heading", heading()),
        ("codeBlock", code_block()),
        ("text", text()),
        ("image", image()),
        ("hardBreak", hard_break()),
        ("orderedList", ordered_list()),
        ("bulletList", bullet_list()),
        ("listItem", list_item()),
        ("taskList", task_list()),
        ("taskItem", task_item()),
        ("link", link()),
        ("italic", italic()),
        ("bold", bold()),
        ("code", code()),
        ("strike", strike()),
        ("underline", underline()),
        ("highlight", highlight()),
        ("subscript", subscript()),
        ("superscript", superscript()),
        ("textStyle", text_style()),
        ("textAlign", text_align()),
        ("history", history()),
        ("trailingNode", trailing_node()),
        ("typography", typography()),
        ("listKeymap", list_keymap()),
    ]
}

/// `starterKit`: every extension of [`starter_kit_extensions`]; an option
/// named as one (`heading`, `bold`, `history` or `undoRedo`, ...) set to
/// `false` leaves it out, an object configures it.
pub fn starter_kit() -> Extension {
    Extension::new("starterKit").add_extensions(|options| {
        starter_kit_extensions()
            .into_iter()
            .filter_map(|(key, extension)| {
                let option = options.get(key).or_else(|| match key {
                    "history" => options.get("undoRedo"),
                    _ => None,
                });
                match option {
                    Some(Value::Bool(false)) => None,
                    Some(value @ Value::Object(_)) => Some(extension.configure(value.clone())),
                    _ => Some(extension),
                }
            })
            .collect()
    })
}

/// The built-in extension `name` (its extension name, `starterKit`, or a
/// starter kit option key: `document`, `undoRedo`).
pub fn builtin(name: &str) -> Option<Extension> {
    match name {
        "starterKit" => return Some(starter_kit()),
        "keymap" => return Some(core_keymap()),
        "doc" | "document" => return Some(document()),
        "undoRedo" => return Some(history()),
        _ => {}
    }
    starter_kit_extensions()
        .into_iter()
        .find(|(key, extension)| *key == name || extension.name == name)
        .map(|(_, extension)| extension)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::extensions::{ExtensionManager, starter};

    #[test]
    fn the_starter_kit_makes_the_starter_schema() {
        let manager = ExtensionManager::with_core(vec![starter_kit()]).unwrap();
        let spec = ExtensionManager::schema_spec(manager.extensions());
        let names = |items: Vec<&String>| items.into_iter().cloned().collect::<Vec<_>>();
        // The order the starter schema has always had: the paragraph is
        // the default block, and marks keep their rank.
        assert_eq!(
            names(spec.nodes.iter().map(|(n, _)| n).collect()),
            [
                "doc",
                "paragraph",
                "blockquote",
                "horizontalRule",
                "heading",
                "codeBlock",
                "text",
                "image",
                "hardBreak",
                "orderedList",
                "bulletList",
                "listItem",
                "taskList",
                "taskItem"
            ]
        );
        assert_eq!(
            names(spec.marks.iter().map(|(n, _)| n).collect()),
            [
                "link",
                "italic",
                "bold",
                "code",
                "strike",
                "underline",
                "highlight",
                "subscript",
                "superscript",
                "textStyle"
            ]
        );
        let attrs = |name: &str| {
            spec.nodes
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, s)| s.attrs.iter().map(|(a, _)| a.clone()).collect::<Vec<_>>())
                .unwrap()
        };
        assert_eq!(attrs("paragraph"), ["textAlign"]);
        assert_eq!(attrs("heading"), ["level", "textAlign"]);
        assert_eq!(manager.schema().top_node_type().name(), "doc");
        assert_eq!(
            starter::schema().node_types().len(),
            manager.schema().node_types().len()
        );
    }

    #[test]
    fn configure_leaves_out_and_configures_children() {
        let kit = starter_kit().configure(json!({
            "bold": false,
            "heading": { "levels": [1, 2] },
            "undoRedo": false,
        }));
        let manager = ExtensionManager::with_core(vec![kit]).unwrap();
        assert!(manager.schema().mark_type("bold").is_none());
        assert!(manager.extension("history").is_none());
        assert_eq!(
            manager.extension("heading").unwrap().options["levels"],
            json!([1, 2])
        );
        assert!(manager.commands().contains("toggleHeading"));
        assert!(!manager.commands().contains("toggleBold"));
    }

    #[test]
    fn text_align_is_a_global_attribute() {
        let without = ExtensionManager::with_core(vec![
            starter_kit().configure(json!({ "textAlign": false })),
        ])
        .unwrap();
        let paragraph = without.schema().node_type("paragraph").unwrap();
        assert!(!paragraph.spec().attrs.iter().any(|(n, _)| n == "textAlign"));
        let only_headings = ExtensionManager::with_core(vec![
            starter_kit().configure(json!({ "textAlign": { "types": ["heading"] } })),
        ])
        .unwrap();
        let paragraph = only_headings.schema().node_type("paragraph").unwrap();
        let heading = only_headings.schema().node_type("heading").unwrap();
        assert!(!paragraph.spec().attrs.iter().any(|(n, _)| n == "textAlign"));
        assert!(heading.spec().attrs.iter().any(|(n, _)| n == "textAlign"));
    }

    #[test]
    fn typography_options_turn_rules_off() {
        let all = typography_rules(&typography_options(&json!({}))).len();
        let fewer = typography_rules(&typography_options(&json!({ "emDash": false }))).len();
        assert!(fewer < all);
    }

    #[test]
    fn builtins_are_found_by_name() {
        for name in [
            "starterKit",
            "bold",
            "document",
            "doc",
            "undoRedo",
            "listKeymap",
        ] {
            assert!(builtin(name).is_some(), "{name}");
        }
        assert_eq!(builtin("document").unwrap().name, "doc");
    }
}
