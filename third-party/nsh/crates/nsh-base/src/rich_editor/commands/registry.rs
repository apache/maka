//! Named commands: a table from a command's name (Tiptap's, camelCase) to
//! a factory that makes the kernel's command from JSON arguments and the
//! schema. JS runs commands by name (`command("toggleHeading", { level: 2
//! })`); extensions register theirs here. [`CommandRegistry::builtin`]
//! holds Tiptap's catalog and `prosemirror-commands`' plain commands.

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, OnceLock},
};

use serde_json::Value;

use super::{BoxCommand, Dispatch, base, chain, list, tiptap};
use crate::rich_editor::{
    extensions::{history, input_rules},
    model::{Attrs, Fragment, MarkType, NodeType, Schema},
    state::EditorState,
};

/// Makes a command from its JSON arguments (`null` when there are none)
/// and the editor's schema; an error says what is wrong with them.
pub type CommandFactory = Arc<dyn Fn(&Value, &Schema) -> Result<BoxCommand, String> + Send + Sync>;

/// Commands by name, made from JSON arguments.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct CommandRegistry {
    factories: HashMap<String, CommandFactory>,
}

impl fmt::Debug for CommandRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut names: Vec<_> = self.factories.keys().collect();
        names.sort();
        f.debug_set().entries(names).finish()
    }
}

impl CommandRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `factory` as `name` (replacing a command of that name).
    pub fn register(
        &mut self,
        name: impl Into<String>,
        factory: impl Fn(&Value, &Schema) -> Result<BoxCommand, String> + Send + Sync + 'static,
    ) -> &mut Self {
        self.factories.insert(name.into(), Arc::new(factory));
        self
    }

    /// Adds every command of `other`, replacing those of the same names.
    pub fn extend(&mut self, other: &CommandRegistry) -> &mut Self {
        self.factories
            .extend(other.factories.iter().map(|(k, v)| (k.clone(), v.clone())));
        self
    }

    /// Whether a command is registered as `name`.
    pub fn contains(&self, name: &str) -> bool {
        self.factories.contains_key(name)
    }

    /// The registered names, sorted.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.factories.keys().cloned().collect();
        names.sort();
        names
    }

    /// The command `name` made from `args` against `schema`.
    pub fn make(&self, name: &str, args: &Value, schema: &Schema) -> Result<BoxCommand, String> {
        let factory = self
            .factories
            .get(name)
            .ok_or_else(|| format!("no command named `{name}`"))?;
        factory(args, schema)
    }

    /// The built-in commands, shared (made once).
    pub fn builtin() -> Arc<CommandRegistry> {
        static BUILTIN: OnceLock<Arc<CommandRegistry>> = OnceLock::new();
        BUILTIN.get_or_init(|| Arc::new(builtin_registry())).clone()
    }
}

// --- Reading arguments -------------------------------------------------------

/// The arguments of a named command, read with errors that name it.
struct Args<'a> {
    name: &'a str,
    value: &'a Value,
}

impl<'a> Args<'a> {
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.value.get(key).filter(|v| !v.is_null())
    }

    fn string(&self, key: &str) -> Result<String, String> {
        self.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("{} needs a string `{key}`", self.name))
    }

    fn pos(&self, key: &str) -> Result<usize, String> {
        self.opt_pos(key)?
            .ok_or_else(|| format!("{} needs a position `{key}`", self.name))
    }

    fn opt_pos(&self, key: &str) -> Result<Option<usize>, String> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => v
                .as_f64()
                .filter(|n| *n >= 0.0 && n.fract() == 0.0)
                .map(|n| Some(n as usize))
                .ok_or_else(|| format!("{}: `{key}` is a position, got {v}", self.name)),
        }
    }

    fn bool(&self, key: &str) -> bool {
        self.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    fn attrs(&self, key: &str) -> Result<Attrs, String> {
        match self.get(key) {
            None => Ok(Attrs::new()),
            Some(Value::Object(map)) => {
                Ok(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            }
            Some(other) => Err(format!("{}: `{key}` is an object, got {other}", self.name)),
        }
    }

    fn node(&self, schema: &Schema, key: &str) -> Result<NodeType, String> {
        let name = self.string(key)?;
        schema
            .node_type(&name)
            .ok_or_else(|| format!("the schema has no node type `{name}`"))
    }

    fn mark(&self, schema: &Schema, key: &str) -> Result<MarkType, String> {
        let name = self.string(key)?;
        schema
            .mark_type(&name)
            .ok_or_else(|| format!("the schema has no mark type `{name}`"))
    }

    fn schema_type(&self, schema: &Schema, key: &str) -> Result<tiptap::SchemaType, String> {
        let name = self.string(key)?;
        tiptap::SchemaType::by_name(schema, &name)
            .ok_or_else(|| format!("the schema has no node or mark type `{name}`"))
    }

    // A range: `{ from, to }` under `key`, or a position.
    fn range(&self, key: &str) -> Result<(usize, usize), String> {
        let value = self
            .get(key)
            .ok_or_else(|| format!("{} needs `{key}`", self.name))?;
        let inner = Args {
            name: self.name,
            value,
        };
        if value.is_object() {
            let from = inner.pos("from")?;
            Ok((from, inner.opt_pos("to")?.unwrap_or(from)))
        } else {
            let pos = self.pos(key)?;
            Ok((pos, pos))
        }
    }
}

fn plain(f: fn(&EditorState, Dispatch<'_>) -> bool) -> BoxCommand {
    Arc::new(f)
}

/// Content as a fragment: ProseMirror JSON (a node, an array of nodes, a
/// whole document's children) or a string (plain text, one paragraph per
/// line, or inline text where it goes).
pub fn content_fragment(schema: &Schema, content: &Value) -> Result<Fragment, String> {
    match content {
        Value::String(text) => Ok(if text.contains('\n') {
            let paragraph = schema
                .node_types()
                .into_iter()
                .find(|t| t.is_textblock())
                .ok_or("the schema has no textblock")?;
            let blocks = text
                .split('\n')
                .map(|line| {
                    let content = if line.is_empty() {
                        Fragment::empty()
                    } else {
                        Fragment::from(vec![schema.text(line, vec![])])
                    };
                    paragraph
                        .create(None, content, vec![])
                        .map_err(|e| e.to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            Fragment::from(blocks)
        } else if text.is_empty() {
            Fragment::empty()
        } else {
            Fragment::from(vec![schema.text(text, vec![])])
        }),
        Value::Array(_) => Fragment::from_json(schema, content).map_err(|e| e.to_string()),
        json => {
            let node = schema.node_from_json(json).map_err(|e| e.to_string())?;
            Ok(if node.ty() == &schema.top_node_type() {
                node.content().clone()
            } else {
                Fragment::from(vec![node])
            })
        }
    }
}

fn focus_position(value: Option<&Value>) -> Result<tiptap::FocusPosition, String> {
    use tiptap::FocusPosition as F;
    Ok(match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => F::Keep,
        Some(Value::Bool(true)) => F::Start,
        Some(Value::String(s)) if s == "start" => F::Start,
        Some(Value::String(s)) if s == "end" => F::End,
        Some(Value::String(s)) if s == "all" => F::All,
        Some(Value::Number(n)) => F::Pos(n.as_f64().unwrap_or(0.0).max(0.0) as usize),
        Some(other) => return Err(format!("focus: unknown position {other}")),
    })
}

fn builtin_registry() -> CommandRegistry {
    let mut r = CommandRegistry::new();
    macro_rules! plain {
        ($($name:literal => $f:expr),* $(,)?) => {
            $(r.register($name, |_: &Value, _: &Schema| Ok(plain($f)));)*
        };
    }
    plain! {
        "selectAll" => base::select_all,
        "deleteSelection" => base::delete_selection,
        "splitBlock" => base::split_block,
        "splitBlockKeepMarks" => base::split_block_keep_marks,
        "joinBackward" => base::join_backward,
        "joinForward" => base::join_forward,
        "joinTextblockBackward" => base::join_textblock_backward,
        "joinTextblockForward" => base::join_textblock_forward,
        "joinUp" => base::join_up,
        "joinDown" => base::join_down,
        "newlineInCode" => base::newline_in_code,
        "exitCode" => base::exit_code,
        "createParagraphNear" => base::create_paragraph_near,
        "liftEmptyBlock" => base::lift_empty_block,
        "selectParentNode" => base::select_parent_node,
        "selectNodeBackward" => base::select_node_backward,
        "selectNodeForward" => base::select_node_forward,
        "selectTextblockStart" => base::select_textblock_start,
        "selectTextblockEnd" => base::select_textblock_end,
        "undo" => history::undo,
        "redo" => history::redo,
        "undoInputRule" => input_rules::undo_input_rule,
    }
    r.register("joinItemBackward", |_, _| Ok(tiptap::join_item_backward()));
    r.register("joinItemForward", |_, _| Ok(tiptap::join_item_forward()));
    r.register("clearNodes", |_, _| Ok(tiptap::clear_nodes()));
    r.register("unsetAllMarks", |_, _| Ok(tiptap::unset_all_marks()));
    r.register(
        "deleteCurrentNode",
        |_, _| Ok(tiptap::delete_current_node()),
    );
    r.register("scrollIntoView", |_, _| Ok(tiptap::scroll_into_view()));
    r.register("lift", |v, s| {
        let a = Args {
            name: "lift",
            value: v,
        };
        Ok(match a.get("name") {
            None => plain(base::lift),
            Some(_) => tiptap::lift(a.node(s, "name")?, a.attrs("attrs")?),
        })
    });
    r.register("wrapIn", |v, s| {
        let a = Args {
            name: "wrapIn",
            value: v,
        };
        Ok(base::wrap_in(a.node(s, "name")?, Some(a.attrs("attrs")?)))
    });
    r.register("setBlockType", |v, s| {
        let a = Args {
            name: "setBlockType",
            value: v,
        };
        Ok(base::set_block_type(
            a.node(s, "name")?,
            Some(a.attrs("attrs")?),
        ))
    });
    r.register("wrapInList", |v, s| {
        let a = Args {
            name: "wrapInList",
            value: v,
        };
        Ok(list::wrap_in_list(
            a.node(s, "name")?,
            Some(a.attrs("attrs")?),
        ))
    });
    r.register("liftListItem", |v, s| {
        let a = Args {
            name: "liftListItem",
            value: v,
        };
        Ok(list::lift_list_item(a.node(s, "name")?))
    });
    r.register("sinkListItem", |v, s| {
        let a = Args {
            name: "sinkListItem",
            value: v,
        };
        Ok(list::sink_list_item(a.node(s, "name")?))
    });
    r.register("splitListItem", |v, s| {
        let a = Args {
            name: "splitListItem",
            value: v,
        };
        Ok(list::split_list_item(
            a.node(s, "name")?,
            Some(a.attrs("attrs")?),
        ))
    });
    r.register("setNode", |v, s| {
        let a = Args {
            name: "setNode",
            value: v,
        };
        Ok(tiptap::set_node(a.node(s, "name")?, a.attrs("attrs")?))
    });
    r.register("toggleNode", |v, s| {
        let a = Args {
            name: "toggleNode",
            value: v,
        };
        Ok(tiptap::toggle_node(
            a.node(s, "name")?,
            a.node(s, "toggleName")?,
            a.attrs("attrs")?,
        ))
    });
    r.register("toggleWrap", |v, s| {
        let a = Args {
            name: "toggleWrap",
            value: v,
        };
        Ok(tiptap::toggle_wrap(a.node(s, "name")?, a.attrs("attrs")?))
    });
    r.register("toggleList", |v, s| {
        let a = Args {
            name: "toggleList",
            value: v,
        };
        Ok(tiptap::toggle_list(
            a.node(s, "listName")?,
            a.node(s, "itemName")?,
            a.bool("keepMarks"),
            a.attrs("attrs")?,
        ))
    });
    r.register("setMark", |v, s| {
        let a = Args {
            name: "setMark",
            value: v,
        };
        Ok(tiptap::set_mark(a.mark(s, "name")?, a.attrs("attrs")?))
    });
    r.register("unsetMark", |v, s| {
        let a = Args {
            name: "unsetMark",
            value: v,
        };
        Ok(tiptap::unset_mark(
            a.mark(s, "name")?,
            a.bool("extendEmptyMarkRange"),
        ))
    });
    r.register("toggleMark", |v, s| {
        let a = Args {
            name: "toggleMark",
            value: v,
        };
        Ok(tiptap::toggle_mark(
            a.mark(s, "name")?,
            a.attrs("attrs")?,
            a.bool("extendEmptyMarkRange"),
        ))
    });
    r.register("extendMarkRange", |v, s| {
        let a = Args {
            name: "extendMarkRange",
            value: v,
        };
        let attrs = a.get("attrs").map(|_| a.attrs("attrs")).transpose()?;
        Ok(tiptap::extend_mark_range(a.mark(s, "name")?, attrs))
    });
    r.register("updateAttributes", |v, s| {
        let a = Args {
            name: "updateAttributes",
            value: v,
        };
        Ok(tiptap::update_attributes(
            a.schema_type(s, "name")?,
            a.attrs("attrs")?,
        ))
    });
    r.register("resetAttributes", |v, s| {
        let a = Args {
            name: "resetAttributes",
            value: v,
        };
        let keys = match a.get("attrs") {
            Some(Value::String(k)) => vec![k.clone()],
            Some(Value::Array(keys)) => keys
                .iter()
                .filter_map(|k| k.as_str().map(str::to_owned))
                .collect(),
            _ => return Err("resetAttributes needs `attrs`: a name or names".into()),
        };
        Ok(tiptap::reset_attributes(a.schema_type(s, "name")?, keys))
    });
    r.register("deleteNode", |v, s| {
        let a = Args {
            name: "deleteNode",
            value: v,
        };
        Ok(tiptap::delete_node(a.node(s, "name")?))
    });
    r.register("deleteRange", |v, _| {
        let a = Args {
            name: "deleteRange",
            value: v,
        };
        let (from, to) = (a.pos("from")?, a.pos("to")?);
        Ok(tiptap::delete_range(from, to))
    });
    r.register("insertContentAt", |v, s| {
        let a = Args {
            name: "insertContentAt",
            value: v,
        };
        let (from, to) = a.range("position")?;
        let content = content_fragment(s, a.get("content").unwrap_or(&Value::Null))?;
        let mut options = tiptap::InsertContentOptions::default();
        if let Some(update) = a.get("options").and_then(|o| o.get("updateSelection")) {
            options.update_selection = update.as_bool().unwrap_or(true);
        }
        Ok(tiptap::insert_content_at(from, to, content, options))
    });
    r.register("cut", |v, _| {
        let a = Args {
            name: "cut",
            value: v,
        };
        let (from, to) = a.range("range")?;
        Ok(tiptap::cut(from, to, a.pos("targetPos")?))
    });
    r.register("setMeta", |v, _| {
        let a = Args {
            name: "setMeta",
            value: v,
        };
        Ok(tiptap::set_meta(
            a.string("key")?,
            a.get("value").cloned().unwrap_or(Value::Null),
        ))
    });
    r.register("setTextSelection", |v, _| {
        let a = Args {
            name: "setTextSelection",
            value: v,
        };
        let (from, to) = a.range("position")?;
        Ok(tiptap::set_text_selection(from, to))
    });
    r.register("setNodeSelection", |v, _| {
        let a = Args {
            name: "setNodeSelection",
            value: v,
        };
        Ok(tiptap::set_node_selection(a.pos("position")?))
    });
    r.register("focus", |v, _| {
        Ok(tiptap::focus(focus_position(v.get("position"))?))
    });
    r.register("chain", |v, s| {
        let commands = v
            .get("commands")
            .and_then(Value::as_array)
            .ok_or("chain needs `commands`")?;
        let made = commands
            .iter()
            .map(|c| {
                let name = c
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("a command needs a `name`")?;
                CommandRegistry::builtin().make(name, c.get("args").unwrap_or(&Value::Null), s)
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(chain(made))
    });
    crate::rich_editor::extensions::link::register_commands(&mut r);
    crate::rich_editor::extensions::character_count::register_commands(&mut r);
    crate::rich_editor::extensions::suggestion::register_commands(&mut r);
    r
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{super::test_util::*, *};

    #[test]
    fn builtin_names_make_commands() {
        let s = schema();
        let registry = CommandRegistry::builtin();
        assert!(registry.contains("toggleList"));
        assert!(registry.make("nope", &Value::Null, &s).is_err());
        assert!(registry.make("setNode", &json!({}), &s).is_err());
        let doc = n(&s, "doc", vec![p(&s, "ab")]);
        let heading = registry
            .make(
                "setNode",
                &json!({"name": "heading", "attrs": {"level": 2}}),
                &s,
            )
            .unwrap();
        let out = apply(&state(doc.clone(), 2, 2), heading.as_ref()).unwrap();
        assert_eq!(out.doc().child(0).ty().name(), "heading");
        let insert = registry
            .make(
                "insertContentAt",
                &json!({"position": 3, "content": "X"}),
                &s,
            )
            .unwrap();
        let out = apply(&state(doc, 2, 2), insert.as_ref()).unwrap();
        assert_eq!(out.doc().text_content(), "abX");
    }

    #[test]
    fn apps_register_their_own() {
        let mut registry = CommandRegistry::new();
        registry.extend(&CommandRegistry::builtin());
        registry.register("nothing", |_, _| Ok(super::super::command(|_, _| false)));
        assert!(registry.contains("nothing") && registry.contains("selectAll"));
    }
}
