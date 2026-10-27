//! Commands as data: `toggleMark("bold")` makes a [`RichCommand`], a plain
//! object an app keeps, passes to `editor.run` / `editor.can`, binds to
//! keys and chains. Each resolves against the editor's schema into the
//! kernel's command, which runs in Rust.

use std::sync::Arc;

use nsh_core::{JsonValue, prelude::*};

use super::json::{AttrsJson, Content};
use crate::rich_editor::{
    commands::{self as cmd, BoxCommand, CommandRegistry, Dispatch, command},
    extensions::{history, input_rules},
    formats::{DocFormat, MarkdownFormat, MarkdownNames, slice_from_text},
    model::{Attrs, Fragment, Node, Schema, Slice},
    state::{EditorState, NodeSelection, TextSelection},
    transform::MarkMatch,
};

/// Which command a [`RichCommand`] runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum RichCommandName {
    /// Adds the mark `name` (with `attrs`) to the selection, or removes it
    /// where present.
    #[default]
    ToggleMark,
    /// Adds the mark `name` (with `attrs`) to the selection.
    SetMark,
    /// Removes the marks of type `name` from the selection.
    UnsetMark,
    /// Makes the selected textblocks nodes of type `name` (with `attrs`).
    SetBlockType,
    /// Wraps the selected blocks in a node of type `name`.
    WrapIn,
    /// Wraps the selected blocks in a list of type `name`.
    WrapInList,
    /// Lifts the selected list items (items of type `name`) out of their
    /// list.
    LiftListItem,
    /// Moves the selected list items (items of type `name`) into a list
    /// inside the item before.
    SinkListItem,
    /// Splits the list item (of type `name`) at the selection.
    SplitListItem,
    /// Lifts the selected blocks out of their parent.
    Lift,
    /// Undoes the last change (the `history` plugin's).
    Undo,
    /// Redoes the last undone change.
    Redo,
    /// Undoes the input rule that just applied.
    UndoInputRule,
    /// Selects the whole document.
    SelectAll,
    /// Types `text` over the selection.
    InsertText,
    /// Inserts `content` (in `format`) over the selection.
    InsertContent,
    /// Sets attribute `attr` of the node at `pos` to `value`.
    SetNodeAttribute,
    /// Selects text from `pos` (the anchor) to `head`.
    SetTextSelection,
    /// Selects the node at `pos`.
    SetNodeSelection,
    /// Deletes the selection.
    DeleteSelection,
    /// Splits the textblock at the selection.
    SplitBlock,
    /// Splits the textblock at the selection, keeping the stored marks.
    SplitBlockKeepMarks,
    /// Joins the textblock at the cursor with the one before.
    JoinBackward,
    /// Joins the textblock at the cursor with the one after.
    JoinForward,
    /// Joins the selected block with the one above.
    JoinUp,
    /// Joins the selected block with the one below.
    JoinDown,
    /// Inserts a newline in a code block.
    NewlineInCode,
    /// Leaves a code block: a paragraph after it.
    ExitCode,
    /// Inserts a paragraph next to a selected block node.
    CreateParagraphNear,
    /// Lifts an empty textblock out of its parent.
    LiftEmptyBlock,
    /// Selects the node around the selection.
    SelectParentNode,
    /// Selects the node before the cursor.
    SelectNodeBackward,
    /// Selects the node after the cursor.
    SelectNodeForward,
    /// Moves the cursor to the start of its textblock.
    SelectTextblockStart,
    /// Moves the cursor to the end of its textblock.
    SelectTextblockEnd,
    /// Runs `commands` one after another as one transaction; applies only
    /// when every one does (Tiptap's `chain`).
    Chain,
    /// Runs the first of `commands` that applies (ProseMirror's
    /// `chainCommands`).
    First,
    /// Runs the command registered as `name` (Tiptap's names: `toggleList`,
    /// `setNode`, ... and the ones extensions add) with `args`.
    Command,
}

/// A command as data, made by `toggleMark`, `setBlockType`, `chain`, ...:
/// what `editor.run` and `editor.can` take and keymaps bind.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct RichCommand {
    /// Which command.
    pub(crate) command: RichCommandName,
    /// The mark or node type it is about.
    #[prop(skip_none)]
    pub(crate) name: Option<String>,
    /// The attributes of the mark or node it makes.
    #[prop(skip_none)]
    pub(crate) attrs: Option<AttrsJson>,
    /// The text it types.
    #[prop(skip_none)]
    pub(crate) text: Option<String>,
    /// The content it inserts.
    #[prop(skip_none)]
    pub(crate) content: Option<Content>,
    /// The format of `content` when it is a string.
    #[prop(skip_none)]
    pub(crate) format: Option<RichFormat>,
    /// A document position.
    #[prop(skip_none)]
    pub(crate) pos: Option<usize>,
    /// A second position: a text selection's head.
    #[prop(skip_none)]
    pub(crate) head: Option<usize>,
    /// The attribute it sets.
    #[prop(skip_none)]
    pub(crate) attr: Option<String>,
    /// The value it sets the attribute to.
    #[prop(skip_none)]
    pub(crate) value: Option<JsonValue>,
    /// The commands `chain` and `first` run.
    #[prop(skip_none)]
    pub(crate) commands: Option<Vec<RichCommand>>,
    /// A named command's arguments, as an object.
    #[prop(skip_none)]
    pub(crate) args: Option<JsonValue>,
}

/// A format documents are read from and written to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum RichFormat {
    /// ProseMirror's JSON.
    Json,
    /// Markdown (CommonMark with GitHub's strikethrough), mapped to the
    /// starter schema's names.
    Markdown,
    /// Plain text: one paragraph per line.
    #[default]
    Text,
}

impl RichCommand {
    /// The command registered as `name`, with `args`.
    pub(crate) fn named(name: impl Into<String>, args: JsonValue) -> Self {
        Self {
            command: RichCommandName::Command,
            name: Some(name.into()),
            args: Some(args),
            ..Self::default()
        }
    }

    /// A command without parameters.
    pub(crate) fn plain(command: RichCommandName) -> Self {
        Self {
            command,
            ..Self::default()
        }
    }

    /// A command about type `name`.
    pub(crate) fn about(command: RichCommandName, name: String, attrs: Option<AttrsJson>) -> Self {
        Self {
            command,
            name: Some(name),
            attrs,
            ..Self::default()
        }
    }
}

/// `attrs` as the kernel's attributes (`null` and left out: none).
pub(crate) fn attrs_of(attrs: &Option<AttrsJson>) -> Result<Option<Attrs>, String> {
    match attrs.as_ref().map(|a| &a.0) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Object(map)) => Ok(Some(
            map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        )),
        Some(other) => Err(format!("attributes are an object, got {other}")),
    }
}

/// Content read into a fragment of `schema`, in `format` when it is a
/// string (a whole document keeps its children).
pub(crate) fn fragment_of(
    schema: &Schema,
    content: &Content,
    format: Option<RichFormat>,
) -> Result<Fragment, String> {
    match content {
        Content::Json(json @ JsonValue::Array(_)) => {
            Fragment::from_json(schema, json).map_err(|e| e.to_string())
        }
        Content::Json(json) => {
            let node = Node::from_json(schema, json).map_err(|e| e.to_string())?;
            Ok(if node.ty() == &schema.top_node_type() {
                node.content().clone()
            } else {
                Fragment::from(vec![node])
            })
        }
        Content::Text(text) => match format.unwrap_or_default() {
            RichFormat::Json => {
                let json: JsonValue = serde_json::from_str(text).map_err(|e| e.to_string())?;
                fragment_of(schema, &Content::Json(json), None)
            }
            RichFormat::Markdown => MarkdownFormat::new(MarkdownNames::default())
                .parse_fragment(schema, text)
                .map_err(|e| e.to_string()),
            RichFormat::Text => {
                let doc = crate::rich_editor::formats::PlainTextFormat::default()
                    .parse(schema, text)
                    .map_err(|e| e.to_string())?;
                Ok(doc.content().clone())
            }
        },
    }
}

/// Content read into a whole document of `schema`.
pub(crate) fn doc_of(
    schema: &Schema,
    content: &Content,
    format: Option<RichFormat>,
) -> Result<Node, String> {
    let content = fragment_of(schema, content, format)?;
    let doc = schema
        .top_node_type()
        .create_and_fill(None, content, vec![])
        .ok_or_else(|| "the content does not fit the schema's top node".to_owned())?;
    doc.check().map_err(|e| e.to_string())?;
    Ok(doc)
}

/// `command` resolved against `schema` with the built-in named commands.
pub(crate) fn resolve(command: &RichCommand, schema: &Schema) -> Result<BoxCommand, String> {
    resolve_with(command, schema, &CommandRegistry::builtin())
}

/// `command` resolved against `schema`: the kernel's command it runs, named
/// commands from `registry`.
pub(crate) fn resolve_with(
    command: &RichCommand,
    schema: &Schema,
    registry: &CommandRegistry,
) -> Result<BoxCommand, String> {
    use RichCommandName as N;
    // The marks' commands with arguments (`extendEmptyMarkRange`) are
    // Tiptap's, from the registry.
    if let (N::ToggleMark | N::SetMark | N::UnsetMark, Some(JsonValue::Object(args))) =
        (command.command, &command.args)
    {
        let mut args = args.clone();
        args.insert("name".into(), command.name.clone().into());
        if let Some(attrs) = &command.attrs {
            args.insert("attrs".into(), attrs.0.clone());
        }
        let name = match command.command {
            N::ToggleMark => "toggleMark",
            N::SetMark => "setMark",
            _ => "unsetMark",
        };
        return registry.make(name, &JsonValue::Object(args), schema);
    }
    let name = || {
        command
            .name
            .clone()
            .ok_or_else(|| format!("{:?} needs a type `name`", command.command))
    };
    let node = || {
        let name = name()?;
        schema
            .node_type(&name)
            .ok_or_else(|| format!("the schema has no node type `{name}`"))
    };
    let mark = || {
        let name = name()?;
        schema
            .mark_type(&name)
            .ok_or_else(|| format!("the schema has no mark type `{name}`"))
    };
    let attrs = || attrs_of(&command.attrs);
    let plain = |f: fn(&EditorState, Dispatch<'_>) -> bool| -> BoxCommand { Arc::new(f) };
    Ok(match command.command {
        N::ToggleMark => cmd::toggle_mark(mark()?, attrs()?, true),
        N::SetMark => {
            let mark = mark()?.create(attrs()?).map_err(|e| e.to_string())?;
            command_fn(move |state, dispatch| set_mark(state, dispatch, &mark))
        }
        N::UnsetMark => {
            let ty = mark()?;
            command_fn(move |state, dispatch| {
                let selection = state.selection();
                let mut tr = state.tr();
                if selection.empty() {
                    tr.remove_stored_mark_type(&ty);
                } else {
                    for range in selection.ranges() {
                        let _ = tr.remove_mark(
                            range.from.pos,
                            range.to.pos,
                            MarkMatch::Type(ty.clone()),
                        );
                    }
                }
                if let Some(dispatch) = dispatch {
                    dispatch(tr);
                }
                true
            })
        }
        N::SetBlockType => cmd::set_block_type(node()?, attrs()?),
        N::WrapIn => cmd::wrap_in(node()?, attrs()?),
        N::WrapInList => cmd::wrap_in_list(node()?, attrs()?),
        N::LiftListItem => cmd::lift_list_item(node()?),
        N::SinkListItem => cmd::sink_list_item(node()?),
        N::SplitListItem => cmd::split_list_item(node()?, attrs()?),
        N::Lift => plain(cmd::lift),
        N::Undo => plain(history::undo),
        N::Redo => plain(history::redo),
        N::UndoInputRule => plain(input_rules::undo_input_rule),
        N::SelectAll => plain(cmd::select_all),
        N::DeleteSelection => plain(cmd::delete_selection),
        N::SplitBlock => plain(cmd::split_block),
        N::SplitBlockKeepMarks => plain(cmd::split_block_keep_marks),
        N::JoinBackward => plain(cmd::join_backward),
        N::JoinForward => plain(cmd::join_forward),
        N::JoinUp => plain(cmd::join_up),
        N::JoinDown => plain(cmd::join_down),
        N::NewlineInCode => plain(cmd::newline_in_code),
        N::ExitCode => plain(cmd::exit_code),
        N::CreateParagraphNear => plain(cmd::create_paragraph_near),
        N::LiftEmptyBlock => plain(cmd::lift_empty_block),
        N::SelectParentNode => plain(cmd::select_parent_node),
        N::SelectNodeBackward => plain(cmd::select_node_backward),
        N::SelectNodeForward => plain(cmd::select_node_forward),
        N::SelectTextblockStart => plain(cmd::select_textblock_start),
        N::SelectTextblockEnd => plain(cmd::select_textblock_end),
        N::InsertText => {
            let text = command.text.clone().ok_or("insertText needs a `text`")?;
            command_fn(move |state, dispatch| {
                if let Some(dispatch) = dispatch {
                    let mut tr = state.tr();
                    tr.insert_text(&text, None, None);
                    dispatch(tr);
                }
                true
            })
        }
        N::InsertContent => {
            let content = command
                .content
                .clone()
                .ok_or("insertContent needs `content`")?;
            let format = command.format;
            let schema = schema.clone();
            command_fn(move |state, dispatch| {
                let slice = match &content {
                    Content::Text(text) if format.unwrap_or_default() == RichFormat::Text => {
                        slice_from_text(&schema, text, state.selection().resolved_from())
                    }
                    _ => match fragment_of(&schema, &content, format) {
                        Ok(fragment) => Slice::max_open(fragment, true),
                        Err(error) => {
                            log::warn!("insertContent: {error}");
                            return false;
                        }
                    },
                };
                if let Some(dispatch) = dispatch {
                    let mut tr = state.tr();
                    tr.replace_selection(slice);
                    dispatch(tr);
                }
                true
            })
        }
        N::SetNodeAttribute => {
            let pos = command.pos.ok_or("setNodeAttribute needs a `pos`")?;
            let attr = command
                .attr
                .clone()
                .ok_or("setNodeAttribute needs an `attr`")?;
            let value = command.value.clone().unwrap_or(JsonValue::Null);
            command_fn(move |state, dispatch| {
                let mut tr = state.tr();
                if tr.set_node_attribute(pos, &attr, value.clone()).is_err() {
                    return false;
                }
                if let Some(dispatch) = dispatch {
                    dispatch(tr);
                }
                true
            })
        }
        N::SetTextSelection => {
            let anchor = command.pos.ok_or("setTextSelection needs a `pos`")?;
            let head = command.head;
            command_fn(move |state, dispatch| {
                let size = state.doc().content().size();
                if anchor > size || head.is_some_and(|head| head > size) {
                    return false;
                }
                if let Some(dispatch) = dispatch {
                    let mut tr = state.tr();
                    tr.set_selection(TextSelection::create(state.doc(), anchor, head));
                    dispatch(tr);
                }
                true
            })
        }
        N::SetNodeSelection => {
            let pos = command.pos.ok_or("setNodeSelection needs a `pos`")?;
            command_fn(move |state, dispatch| {
                let Ok(at) = state.doc().resolve(pos) else {
                    return false;
                };
                if !at
                    .node_after()
                    .is_some_and(|n| NodeSelection::is_selectable(&n))
                {
                    return false;
                }
                if let Some(dispatch) = dispatch {
                    let mut tr = state.tr();
                    tr.set_selection(NodeSelection::create(state.doc(), pos));
                    dispatch(tr);
                }
                true
            })
        }
        N::Chain => cmd::chain(resolve_all(command, schema, registry)?),
        N::First => cmd::chain_commands(resolve_all(command, schema, registry)?),
        N::Command => registry.make(
            &name()?,
            command.args.as_ref().unwrap_or(&JsonValue::Null),
            schema,
        )?,
    })
}

fn command_fn(
    f: impl Fn(&EditorState, Dispatch<'_>) -> bool + Send + Sync + 'static,
) -> BoxCommand {
    command(f)
}

fn resolve_all(
    command: &RichCommand,
    schema: &Schema,
    registry: &CommandRegistry,
) -> Result<Vec<BoxCommand>, String> {
    command
        .commands
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|c| resolve_with(c, schema, registry))
        .collect()
}

/// Adds `mark` to the selection, or to the stored marks at a cursor.
fn set_mark(
    state: &EditorState,
    dispatch: Dispatch<'_>,
    mark: &crate::rich_editor::model::Mark,
) -> bool {
    let selection = state.selection();
    let mut tr = state.tr();
    if selection.empty() {
        tr.add_stored_mark(mark);
    } else {
        for range in selection.ranges() {
            if tr
                .add_mark(range.from.pos, range.to.pos, mark.clone())
                .is_err()
            {
                return false;
            }
        }
    }
    if let Some(dispatch) = dispatch {
        dispatch(tr);
    }
    true
}
