//! The JSON forms TS sees typed: documents, marks, selections, states,
//! transactions and schema specs cross as JSON (ProseMirror's shapes), each
//! with a declared TypeScript interface instead of `unknown`.

use nsh_core::{
    JsonValue,
    element::{JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, TsTypes},
};
use serde_json::{Map, Value};

/// Declares the JSON interfaces the editor's API shares, once each.
fn declare_all(types: &mut TsTypes) {
    types.declare("RichMarkJSON", |_| {
        "/** A mark in ProseMirror's JSON shape: its type's name and its attributes. */\n\
         export interface RichMarkJSON {\n  \
         /** The mark type's name (`\"bold\"`). */\n  type: string;\n  \
         /** Its attributes, when it has any. */\n  attrs?: Record<string, unknown>;\n}"
            .into()
    });
    types.declare("RichNodeJSON", |_| {
        "/** A node in ProseMirror's JSON shape: a document, a block, an inline node or a text. */\n\
         export interface RichNodeJSON {\n  \
         /** The node type's name (`\"paragraph\"`, `\"text\"`). */\n  type: string;\n  \
         /** Its attributes, when it has any. */\n  attrs?: Record<string, unknown>;\n  \
         /** Its children, when it has any. */\n  content?: RichNodeJSON[];\n  \
         /** Its marks, when it has any. */\n  marks?: RichMarkJSON[];\n  \
         /** A text node's text. */\n  text?: string;\n}"
            .into()
    });
    types.declare("RichSelectionJSON", |_| {
        "/** A selection in ProseMirror's JSON shape (`{ type: \"text\", anchor, head }`, `{ type: \"node\", anchor }`, `{ type: \"all\" }`, or a custom kind's). */\n\
         export interface RichSelectionJSON {\n  \
         /** Its kind: `\"text\"`, `\"node\"`, `\"all\"` or a custom kind's id. */\n  type: string;\n  \
         /** Where it starts: the fixed end. */\n  anchor?: number;\n  \
         /** Where it ends: the end that moves. */\n  head?: number;\n  \
         /** `\"upstream\"` when the caret shows at the end of the line before a wrap. */\n  affinity?: string;\n  \
         [key: string]: unknown;\n}"
            .into()
    });
    types.declare("RichEditorStateJSON", |_| {
        "/** An editor state's JSON form: the document, the selection, the stored marks and each plugin's state that has a JSON form, under its key. */\n\
         export interface RichEditorStateJSON {\n  \
         /** The document. */\n  doc: RichNodeJSON;\n  \
         /** The selection. */\n  selection: RichSelectionJSON;\n  \
         /** The marks the next typed text gets, when set. */\n  storedMarks?: RichMarkJSON[];\n  \
         [plugin: string]: unknown;\n}"
            .into()
    });
    types.declare("RichStepJSON", |_| {
        "/** A step in ProseMirror's JSON shape (`{ stepType: \"replace\", from, to, slice }`, `\"addMark\"`, `\"attr\"`, ...). */\n\
         export interface RichStepJSON {\n  \
         /** The step's kind. */\n  stepType: string;\n  \
         [key: string]: unknown;\n}"
            .into()
    });
    types.declare("RichTransactionJSON", |_| {
        "/** A transaction as JSON: its steps, the selection and stored marks it sets, its metadata and origin. `editor.dispatch` and `applyTransaction` take one; plugins' hooks and `dispatchTransaction` get one. */\n\
         export interface RichTransactionJSON {\n  \
         /** The steps, in order, against the state the transaction started from. */\n  steps: RichStepJSON[];\n  \
         /** The selection it sets, when it sets one. */\n  selection?: RichSelectionJSON;\n  \
         /** The stored marks it sets, when it sets them (`null` clears them). */\n  storedMarks?: RichMarkJSON[] | null;\n  \
         /** Its metadata (`addToHistory: false` keeps it out of the history; a plugin's key, its data). */\n  meta?: Record<string, unknown>;\n  \
         /** Where it came from: `\"user\"`, `\"input\"`, `\"paste\"`, `\"drop\"`, `\"history\"`, `\"api\"`, `\"remote:<who>\"` or `\"plugin:<key>\"`. */\n  origin?: string;\n  \
         /** Whether its steps change the document (set on the transactions the editor hands out). */\n  docChanged?: boolean;\n  \
         /** When it was made, in milliseconds. */\n  time?: number;\n  \
         /** The editor's id for it, while it waits for `applyTransaction` (set on the transactions `dispatchTransaction` gets). */\n  id?: number;\n}"
            .into()
    });
    types.declare("RichSchemaSpec", |_| {
        "/** A schema in ProseMirror's shape. `nodes` and `marks` are objects (in key order) or arrays of `[name, spec]` pairs; the first block type is the default one. */\n\
         export interface RichSchemaSpec {\n  \
         /** The node types: `content` (a content expression such as `\"inline*\"`), `group`, `inline`, `atom`, `marks`, `attrs: { name: { default, validate } }`, `code`, `defining`, `isolating`, `selectable`, `parseDOM` (how pasted HTML becomes the node: an array of rules `{ tag?: string, style?: string, priority?: number, consuming?: boolean, context?: string, attrs?: object, getAttrs?: { [attr: string]: string } (each attribute read from the element attribute named), ignore?: boolean, skip?: boolean, closeParent?: boolean, preserveWhitespace?: boolean | \"full\", contentElement?: string }`), `toDOM` (how the node renders as HTML: ProseMirror's array form, `[\"h1\", { class: \"x\", \"data-id\": { attr: \"id\" } }, 0]`, `0` the content's place, `{ attr: name }` an attribute's value), `renderText` (its plain text, `{name}` an attribute's value), attributes' `parseHTML` / `renderHTML` (`\"data-x\"`, `{ attribute: name }`, `{ style: property }` or `false`; the DOM attribute of the attribute's name by default), `keepOnSplit`, `rendered`, ... (more keys are kept as the type's extra data). */\n  \
         nodes: Record<string, Record<string, unknown>> | [string, Record<string, unknown>][];\n  \
         /** The mark types: `attrs`, `inclusive`, `excludes`, `group`, `spanning`, `parseDOM` (as the nodes' rules; a `style` rule such as `\"font-weight=bold\"` matches inline styles), `toDOM`, `code`, `exitable`, `keepOnSplit`, ... */\n  \
         marks?: Record<string, Record<string, unknown>> | [string, Record<string, unknown>][];\n  \
         /** The top node type's name (`\"doc\"` by default). */\n  topNode?: string;\n}"
            .into()
    });
}

/// A JSON value whose TypeScript type is one of the declared interfaces.
macro_rules! json_type {
    ($(#[$doc:meta])* $name:ident => $ts:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Default, PartialEq)]
        pub(crate) struct $name(pub(crate) JsonValue);

        impl JsValue for $name {
            fn ts_type(types: &mut TsTypes) -> String {
                declare_all(types);
                $ts.into()
            }

            fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
                JsonValue::from_js(value).map(Self)
            }

            fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
                self.0.to_js(host)
            }
        }
    };
}

json_type!(
    /// TS: `RichNodeJSON`.
    NodeJson => "RichNodeJSON"
);
json_type!(
    /// TS: `RichSelectionJSON`.
    SelectionJson => "RichSelectionJSON"
);
json_type!(
    /// TS: `RichEditorStateJSON`.
    StateJson => "RichEditorStateJSON"
);
json_type!(
    /// TS: `RichTransactionJSON`.
    TransactionJson => "RichTransactionJSON"
);
json_type!(
    /// TS: `Record<string, unknown>`: a node's or mark's attributes.
    AttrsJson => "Record<string, unknown>"
);

/// TS: `RichSchemaSpec`. Read in the JS object's key order (serde_json's
/// maps sort their keys, and the first block type is the default one):
/// `nodes` and `marks` objects become arrays of `[name, spec]` pairs.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SchemaSpecJson(pub(crate) JsonValue);

impl JsValue for SchemaSpecJson {
    fn ts_type(types: &mut TsTypes) -> String {
        declare_all(types);
        "RichSchemaSpec".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() != JsKind::Object {
            return Err(value.expected("a schema spec object"));
        }
        let mut out = Map::new();
        for key in value.keys()? {
            let field = value.field(&key)?;
            let field = field.get();
            let json = match key.as_str() {
                "nodes" | "marks" => ordered_entries(field)?,
                _ => field.to_json()?,
            };
            out.insert(key, json);
        }
        Ok(Self(Value::Object(out)))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

/// An object's entries as `[name, value]` pairs in key order (an array is
/// kept as it is).
pub(crate) fn ordered_entries(value: JsIn<'_>) -> Result<Value, PropError> {
    if value.kind() != JsKind::Object {
        return value.to_json();
    }
    let mut pairs = Vec::new();
    for key in value.keys()? {
        let field = value.field(&key)?;
        pairs.push(Value::Array(vec![
            Value::String(key),
            field.get().to_json()?,
        ]));
    }
    Ok(Value::Array(pairs))
}

/// What content an editor starts with or is set to: a document's JSON or a
/// string in a format. TS: `string | RichNodeJSON`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Content {
    /// A string, read in the format given with it.
    Text(String),
    /// A document (or a node, or an array of nodes) as JSON.
    Json(JsonValue),
}

impl Default for Content {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

impl JsValue for Content {
    fn ts_type(types: &mut TsTypes) -> String {
        declare_all(types);
        "string | RichNodeJSON | RichNodeJSON[]".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.as_string() {
            Some(text) => Ok(Self::Text(text)),
            None if matches!(value.kind(), JsKind::Object | JsKind::Array) => {
                value.to_json().map(Self::Json)
            }
            None => Err(value.expected("a string or a document's JSON")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Text(text) => text.to_js(host),
            Self::Json(json) => json.to_js(host),
        }
    }
}
