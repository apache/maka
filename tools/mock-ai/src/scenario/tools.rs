/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Cross-harness tool catalog and schema-validated action binder.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::plan::ToolCallPayload;
use crate::protocol::{
    NormalizedRequest, NormalizedTool, Protocol, ToolDeclKind, tool_declarations,
};
use crate::schema_synth::{SynthMode, synthesize_tool_arguments};

use super::{BadToolMode, BenchmarkTrack, digest, valid_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolKind {
    Function,
    Freeform,
    ProviderBuiltin,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ToolDeclaration {
    pub name: String,
    pub namespace: Option<String>,
    pub kind: ToolKind,
    pub schema: Option<Arc<Value>>,
    pub schema_digest: Option<u64>,
    pub format: Option<Value>,
    description: Option<String>,
}

impl ToolDeclaration {
    fn from_wire(value: &Value, namespace: Option<&str>, protocol: Protocol) -> Option<Self> {
        let tool = value
            .get("function")
            .or_else(|| value.get("custom"))
            .unwrap_or(value);
        let kind = value.get("type").and_then(Value::as_str);
        let schema = tool.get("parameters").or_else(|| tool.get("input_schema"));
        let name = tool.get("name").and_then(Value::as_str).or(kind)?;
        Some(Self::new(
            name,
            if protocol == Protocol::AnthropicMessages && kind == Some("custom") {
                None
            } else {
                kind
            },
            schema,
            tool.get("format"),
            tool.get("description").and_then(Value::as_str),
            namespace,
        ))
    }

    fn new(
        name: &str,
        kind: Option<&str>,
        schema: Option<&Value>,
        format: Option<&Value>,
        description: Option<&str>,
        namespace: Option<&str>,
    ) -> Self {
        let kind = match kind {
            Some("custom" | "freeform") => ToolKind::Freeform,
            Some("function") | None => ToolKind::Function,
            Some(_) => ToolKind::ProviderBuiltin,
        };
        Self {
            name: name.into(),
            namespace: namespace.map(str::to_owned),
            kind,
            schema: schema.map(|v| Arc::new(v.clone())),
            schema_digest: schema.map(digest),
            format: format.cloned(),
            description: description.map(str::to_owned),
        }
    }

    fn base_name(&self) -> &str {
        if self.namespace.is_some() {
            &self.name
        } else {
            self.name
                .rsplit_once("__")
                .map_or(&self.name, |(_, suffix)| suffix)
        }
    }

    fn has_property(&self, name: &str) -> bool {
        self.schema
            .as_deref()
            .is_some_and(|schema| schema_has(schema, schema, "properties", name, 0))
    }

    fn requires(&self, name: &str) -> bool {
        self.schema
            .as_deref()
            .is_some_and(|schema| schema_has(schema, schema, "required", name, 0))
    }

    fn format_matches(&self, grammar: impl FnOnce(&str) -> bool) -> bool {
        match self
            .format
            .as_ref()
            .and_then(|format| format["type"].as_str())
        {
            None | Some("text") => true,
            Some("grammar") => self.format.as_ref().is_some_and(|format| {
                format["syntax"] == "lark" && format["definition"].as_str().is_some_and(grammar)
            }),
            Some(_) => false,
        }
    }
}

fn schema_has(root: &Value, schema: &Value, keyword: &str, name: &str, depth: u8) -> bool {
    depth < 8
        && (schema.get(keyword).is_some_and(|value| {
            value.get(name).is_some()
                || value
                    .as_array()
                    .is_some_and(|names| names.iter().any(|v| v == name))
        }) || schema["$ref"]
            .as_str()
            .and_then(|r| r.strip_prefix('#'))
            .and_then(|p| root.pointer(p))
            .is_some_and(|target| schema_has(root, target, keyword, name, depth + 1))
            || ["allOf", "anyOf", "oneOf"].iter().any(|&composition| {
                schema[composition].as_array().is_some_and(|branches| {
                    branches
                        .iter()
                        .any(|branch| schema_has(root, branch, keyword, name, depth + 1))
                })
            }))
}

#[derive(Debug, Clone, Default)]
pub struct ToolCatalog {
    declarations: Vec<ToolDeclaration>,
}

impl ToolCatalog {
    pub fn from_request(request: &NormalizedRequest) -> Self {
        let tools = &request.raw_body["tools"];
        if !tools.is_array() {
            return Self::from_normalized(&request.tools);
        }
        let declarations = tool_declarations(request.protocol, tools)
            .filter_map(|(tool, namespace)| {
                ToolDeclaration::from_wire(tool, namespace, request.protocol)
            })
            .collect();
        Self { declarations }
    }

    pub fn from_normalized(tools: &[NormalizedTool]) -> Self {
        Self {
            declarations: tools
                .iter()
                .map(|tool| {
                    let (kind, format) = match &tool.tool_kind {
                        ToolDeclKind::Function => (None, None),
                        ToolDeclKind::Freeform { format } => (Some("freeform"), format.as_ref()),
                        ToolDeclKind::ProviderBuiltin => (Some("builtin"), None),
                    };
                    ToolDeclaration::new(
                        &tool.name,
                        kind,
                        tool.parameters.as_ref(),
                        format,
                        None,
                        tool.namespace.as_deref(),
                    )
                })
                .collect(),
        }
    }

    pub fn declarations(&self) -> &[ToolDeclaration] {
        &self.declarations
    }

    pub(crate) fn constraint_digest(&self, tool_choice: &Value) -> u64 {
        let mut declarations: Vec<_> = self
            .declarations
            .iter()
            .map(|tool| {
                digest(&(
                    &tool.name,
                    &tool.namespace,
                    tool.kind,
                    tool.schema_digest,
                    &tool.format,
                    &tool.description,
                ))
            })
            .collect();
        declarations.sort_unstable();
        digest(&(declarations, tool_choice))
    }

    pub(crate) fn with_tool_choice(&self, choice: &Value) -> Result<Cow<'_, Self>, ToolBindError> {
        let kind = choice.as_str().or_else(|| choice["type"].as_str());
        match kind {
            None | Some("auto" | "required" | "any") => Ok(Cow::Borrowed(self)),
            Some("none") => Err(unsupported("tool call", vec!["tool_choice is none".into()])),
            Some("function" | "custom" | "tool") => {
                let name = choice["name"]
                    .as_str()
                    .or_else(|| choice["function"]["name"].as_str())
                    .or_else(|| choice["custom"]["name"].as_str())
                    .ok_or_else(|| {
                        unsupported("tool call", vec!["forced tool choice has no name".into()])
                    })?;
                let namespace = choice["namespace"].as_str();
                Ok(Cow::Owned(Self {
                    declarations: self
                        .declarations
                        .iter()
                        .filter(|tool| tool.name == name && tool.namespace.as_deref() == namespace)
                        .cloned()
                        .collect(),
                }))
            }
            Some(kind) => Err(unsupported(
                "tool call",
                vec![format!("unsupported tool_choice {kind:?}")],
            )),
        }
    }

    pub(crate) fn validate_replay(
        &self,
        cache: &ValidatorCache,
        name: &str,
        namespace: Option<&str>,
        payload: &ToolCallPayload,
    ) -> Result<(), ToolBindError> {
        let mut matches = self
            .declarations
            .iter()
            .filter(|tool| tool.name == name && tool.namespace.as_deref() == namespace);
        let Some(tool) = matches.next().filter(|_| matches.next().is_none()) else {
            return Err(unsupported(
                name,
                vec!["replay requires one matching tool declaration".into()],
            ));
        };
        match (tool.kind, payload) {
            (ToolKind::Function, ToolCallPayload::FunctionArgs(args)) => cache
                .validator(tool)
                .and_then(|validator| {
                    validator.validate(args).map_err(|error| {
                        format!(
                            "argument {} violates schema {}",
                            error.instance_path(),
                            error.schema_path()
                        )
                    })
                })
                .map_err(|error| unsupported(name, vec![error])),
            (ToolKind::Freeform, ToolCallPayload::FreeformInput(_))
                if code_mode(tool).is_some()
                    || tool.base_name() == "apply_patch"
                        && tool.format_matches(is_patch_grammar) =>
            {
                Ok(())
            }
            _ => Err(unsupported(
                name,
                vec!["tool declaration no longer supports the issued payload".into()],
            )),
        }
    }

    pub fn bind(
        &self,
        cache: &ValidatorCache,
        track: BenchmarkTrack,
        workspace: &Path,
        actions: &[ToolAction<'_>],
    ) -> Result<Vec<BoundToolCall>, ToolBindError> {
        for action in actions {
            action.validate()?;
        }
        let mut differences = Vec::new();
        if actions.is_empty() {
            return Err(ToolBindError::InvalidAction("empty tool batch".into()));
        }
        if track == BenchmarkTrack::Native {
            let mut code = Vec::new();
            for tool in self.declarations.iter().filter(|t| t.base_name() == "exec") {
                if let Some(encoding) = code_mode(tool) {
                    let recipe = Binding {
                        name: tool.name.clone(),
                        namespace: tool.namespace.clone(),
                        encoding,
                        slots: (0..actions.len()).collect(),
                        metadata: Metadata::default(),
                    };
                    let payload = recipe.encode(workspace, actions)?;
                    match cache.validate(tool, &payload) {
                        Ok(()) => code.push(BoundToolCall { recipe, payload }),
                        Err(error) => differences.push(format!("{}: {error}", tool.name)),
                    }
                }
            }
            match code.len() {
                1 => return Ok(code),
                0 => {}
                _ => {
                    return Err(unsupported(
                        "exec",
                        vec!["multiple compatible code-mode declarations".into()],
                    ));
                }
            }
        }
        actions
            .iter()
            .enumerate()
            .map(|(slot, action)| {
                let mut differences = differences.clone();
                for preference in [Preference::Direct, Preference::Alternate] {
                    let mut matches = Vec::new();
                    for tool in &self.declarations {
                        let Some(encoding) = direct_encoding(tool, track, *action, preference)
                        else {
                            continue;
                        };
                        let recipe = Binding {
                            name: tool.name.clone(),
                            namespace: tool.namespace.clone(),
                            encoding,
                            slots: vec![slot],
                            metadata: Metadata {
                                title: tool.requires("title")
                                    || (tool.base_name() == "exec" && tool.has_property("title")),
                                description: tool.requires("description"),
                                workdir: tool.requires("workdir"),
                            },
                        };
                        match recipe.encode(workspace, actions).and_then(|payload| {
                            cache
                                .validate(tool, &payload)
                                .map_err(|error| unsupported(action.label(), vec![error]))?;
                            Ok(payload)
                        }) {
                            Ok(payload) => matches.push(BoundToolCall { recipe, payload }),
                            Err(error) => differences
                                .push(format!("{} ({:?}): {error}", tool.name, tool.schema_digest)),
                        }
                    }
                    match matches.len() {
                        1 => return Ok(matches.pop().expect("one match")),
                        0 => {}
                        _ => {
                            return Err(unsupported(
                                action.label(),
                                vec![format!(
                                    "multiple schema matches: {}",
                                    matches
                                        .iter()
                                        .map(|m| m.recipe.name.as_str())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                )],
                            ));
                        }
                    }
                }
                if differences.is_empty() {
                    differences.extend(self.declarations.iter().map(|tool| {
                        let properties = tool
                            .schema
                            .as_ref()
                            .and_then(|s| s["properties"].as_object())
                            .map(|props| props.keys().map(String::as_str).collect::<Vec<_>>())
                            .unwrap_or_default();
                        format!("{} {:?} properties {properties:?}", tool.name, tool.kind)
                    }));
                }
                Err(unsupported(action.label(), differences))
            })
            .collect()
    }

    pub(crate) fn bind_bad(
        &self,
        cache: &ValidatorCache,
        mode: BadToolMode,
        seed: u64,
    ) -> Result<BadBinding, ToolBindError> {
        let mut candidates: Vec<_> = self
            .declarations
            .iter()
            .filter(|tool| tool.kind == ToolKind::Function && tool.schema.is_some())
            .collect();
        candidates.sort_by(|a, b| a.name.cmp(&b.name));
        for tool in candidates {
            let schema = tool.schema.as_ref().expect("candidate has schema");
            let validator = cache
                .validator(tool)
                .map_err(|error| unsupported("bad tool call", vec![error]))?;
            let mut rng = fastrand::Rng::with_seed(seed);
            let valid = synthesize_tool_arguments(schema, &mut rng, SynthMode::Valid);
            if !valid.is_object() || !validator.is_valid(&valid) {
                continue;
            }
            let recipe = BadBinding {
                name: tool.name.clone(),
                namespace: tool.namespace.clone(),
                schema: Arc::clone(schema),
                mode,
            };
            let payload = recipe.encode(seed);
            if mode == BadToolMode::MalformedJson || !validator.is_valid(&payload.into_value()) {
                return Ok(recipe);
            }
        }
        Err(unsupported(
            "bad tool call",
            vec!["no function schema supports the requested violation".into()],
        ))
    }
}

type CachedValidators = HashMap<u64, Vec<(Arc<Value>, Arc<jsonschema::Validator>)>>;

#[derive(Default)]
pub struct ValidatorCache {
    validators: Mutex<CachedValidators>,
}

impl ValidatorCache {
    fn validator(&self, tool: &ToolDeclaration) -> Result<Arc<jsonschema::Validator>, String> {
        let schema = tool.schema.as_ref().ok_or("missing JSON Schema")?;
        let digest = tool.schema_digest.expect("schema digest");
        let get = |validators: &Vec<(Arc<Value>, Arc<jsonschema::Validator>)>| {
            validators
                .iter()
                .find(|(cached, _)| cached == schema)
                .map(|(_, validator)| Arc::clone(validator))
        };
        if let Some(validator) = self.validators.lock().unwrap().get(&digest).and_then(get) {
            return Ok(validator);
        }
        let validator = Arc::new(jsonschema::validator_for(schema).map_err(|err| err.to_string())?);
        let mut cache = self.validators.lock().unwrap();
        let bucket = cache.entry(digest).or_default();
        if let Some(existing) = get(bucket) {
            return Ok(existing);
        }
        bucket.push((Arc::clone(schema), Arc::clone(&validator)));
        Ok(validator)
    }

    fn validate(&self, tool: &ToolDeclaration, payload: &CallPayload) -> Result<(), String> {
        match payload {
            CallPayload::Function(value) => self.validator(tool)?.validate(value).map_err(|err| {
                format!(
                    "argument {} violates schema {}",
                    err.instance_path(),
                    err.schema_path()
                )
            }),
            CallPayload::Freeform(_) => Ok(()),
            CallPayload::MalformedJson(_) => unreachable!("intentional violation uses bind_bad"),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ToolBindError {
    #[error("unsupported {action}: {differences:?}")]
    UnsupportedAction {
        action: String,
        differences: Vec<String>,
    },
    #[error("invalid action: {0}")]
    InvalidAction(String),
}

fn unsupported(action: &str, differences: Vec<String>) -> ToolBindError {
    ToolBindError::UnsupportedAction {
        action: action.into(),
        differences,
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ToolAction<'a> {
    Read {
        path: &'a str,
    },
    Write {
        path: &'a str,
        content: &'a str,
    },
    Edit {
        path: &'a str,
        old: &'a str,
        new: &'a str,
        hunk: &'a EditHunk,
    },
    Shell {
        command: &'a str,
        title: &'a str,
    },
}

impl ToolAction<'_> {
    fn label(self) -> &'static str {
        match self {
            Self::Read { .. } => "read file",
            Self::Write { .. } => "write file",
            Self::Edit { .. } => "edit file",
            Self::Shell { .. } => "shell",
        }
    }

    fn validate(self) -> Result<(), ToolBindError> {
        match self {
            Self::Read { path } | Self::Write { path, .. } | Self::Edit { path, .. }
                if !valid_path(path) =>
            {
                Err(ToolBindError::InvalidAction(format!(
                    "invalid fixture path {path:?}"
                )))
            }
            Self::Edit { old, new, .. } if old.is_empty() || old == new => Err(
                ToolBindError::InvalidAction("edit requires a nonempty changing match".into()),
            ),
            Self::Shell { command, title }
                if command.trim().is_empty()
                    || command.contains('\0')
                    || title.trim().is_empty() =>
            {
                Err(ToolBindError::InvalidAction(
                    "shell command and title must be nonempty".into(),
                ))
            }
            _ => Ok(()),
        }
    }
}

/// Complete lines touched by a unique edit. Native edit tools still receive the exact substrings.
#[derive(Debug)]
pub struct EditHunk {
    before: String,
    after: String,
    ends_with_newline: bool,
}

impl EditHunk {
    pub fn new(content: &str, old: &str, new: &str) -> Result<Self, ToolBindError> {
        let mut matches = content.match_indices(old);
        let Some((start, _)) = matches.next().filter(|_| !old.is_empty() && old != new) else {
            return Err(ToolBindError::InvalidAction(
                "edit has no changing match".into(),
            ));
        };
        if matches.next().is_some()
            || content[start
                + content[start..]
                    .chars()
                    .next()
                    .expect("nonempty match")
                    .len_utf8()..]
                .contains(old)
        {
            return Err(ToolBindError::InvalidAction(
                "edit matches more than once".into(),
            ));
        }
        let end = start + old.len();
        let first = content[..start].rfind('\n').map_or(0, |i| i + 1);
        let last = if old.ends_with('\n') && (new.is_empty() || new.ends_with('\n')) {
            end
        } else {
            content[end..]
                .find('\n')
                .map_or(content.len(), |i| end + i + 1)
        };
        Ok(Self {
            before: content[first..last].into(),
            after: format!("{}{}{}", &content[first..start], new, &content[end..last]),
            ends_with_newline: content.ends_with('\n'),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallPayload {
    Function(Value),
    Freeform(String),
    MalformedJson(String),
}

impl CallPayload {
    pub(crate) fn into_value(self) -> Value {
        match self {
            Self::Function(value) => value,
            Self::Freeform(text) | Self::MalformedJson(text) => Value::String(text),
        }
    }
}

#[derive(Debug)]
pub struct BoundToolCall {
    pub recipe: Binding,
    pub payload: CallPayload,
}

#[derive(Debug)]
pub struct Binding {
    pub name: String,
    pub namespace: Option<String>,
    pub slots: Vec<usize>,
    encoding: Encoding,
    metadata: Metadata,
}

#[derive(Clone, Copy, Debug)]
enum Encoding {
    Read(PathKey),
    Write(PathKey),
    Edit(PathKey, EditKeys),
    Command(&'static str),
    Patch(Option<&'static str>),
    Code { freeform: bool, use_patch: bool },
}

#[derive(Clone, Copy, Debug)]
enum PathKey {
    Path,
    FilePath,
}

#[derive(Clone, Copy, Debug)]
enum EditKeys {
    Snake,
    Camel,
    Text,
    List,
}

#[derive(Debug, Default)]
struct Metadata {
    title: bool,
    description: bool,
    workdir: bool,
}

impl Binding {
    pub(crate) fn is_code_mode(&self) -> bool {
        matches!(self.encoding, Encoding::Code { .. })
    }

    pub(crate) fn encode(
        &self,
        workspace: &Path,
        actions: &[ToolAction<'_>],
    ) -> Result<CallPayload, ToolBindError> {
        if let Encoding::Code {
            freeform,
            use_patch,
        } = self.encoding
        {
            let code = code_mode_source(workspace, actions, use_patch)?;
            return Ok(if freeform {
                CallPayload::Freeform(code)
            } else {
                CallPayload::Function(json!({ "code": code }))
            });
        }
        let action = actions[self.slots[0]];
        let path_arg = |path: &str, key| -> Result<(_, _), ToolBindError> {
            match key {
                PathKey::Path => Ok(("path", path.to_owned())),
                PathKey::FilePath => Ok(("file_path", absolute_path(workspace, path)?)),
            }
        };
        let value = match (self.encoding, action) {
            (Encoding::Read(key), ToolAction::Read { path }) => {
                let (key, path) = path_arg(path, key)?;
                json!({ key: path })
            }
            (Encoding::Write(key), ToolAction::Write { path, content }) => {
                let (key, path) = path_arg(path, key)?;
                json!({ key: path, "content": content })
            }
            (Encoding::Edit(path_key, edit_keys), ToolAction::Edit { path, old, new, .. }) => {
                let (key, path) = path_arg(path, path_key)?;
                match edit_keys {
                    EditKeys::Snake => json!({ key: path, "old_string": old, "new_string": new }),
                    EditKeys::Camel => json!({ key: path, "oldString": old, "newString": new }),
                    EditKeys::Text => json!({ key: path, "oldText": old, "newText": new }),
                    EditKeys::List => {
                        json!({ key: path, "edits": [{ "oldText": old, "newText": new }] })
                    }
                }
            }
            (Encoding::Command(key), ToolAction::Shell { command, title }) => {
                self.command(workspace, key, command, title)?
            }
            (Encoding::Command(key), ToolAction::Read { path }) => self.command(
                workspace,
                key,
                &format!("cat -- {}", shell_quote(path)),
                "Read fixture file",
            )?,
            (Encoding::Patch(key), ToolAction::Write { .. } | ToolAction::Edit { .. }) => {
                let patch = patch_text(workspace, action)?;
                let Some(key) = key else {
                    return Ok(CallPayload::Freeform(patch));
                };
                json!({ key: patch })
            }
            _ => unreachable!("binding selected for action"),
        };
        Ok(CallPayload::Function(value))
    }

    fn command(
        &self,
        workspace: &Path,
        key: &str,
        command: &str,
        title: &str,
    ) -> Result<Value, ToolBindError> {
        let mut args = json!({ key: command });
        if self.metadata.title {
            args["title"] = json!(title);
        }
        if self.metadata.description {
            args["description"] = json!(title);
        }
        if self.metadata.workdir {
            args["workdir"] = json!(absolute_path(workspace, "")?);
        }
        Ok(args)
    }
}

fn absolute_path(workspace: &Path, path: &str) -> Result<String, ToolBindError> {
    if workspace.is_absolute()
        && let Some(path) = workspace.join(path).to_str()
    {
        return Ok(path.into());
    }
    Err(ToolBindError::InvalidAction(
        "tool requires an absolute UTF-8 workspace path".into(),
    ))
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Preference {
    Direct,
    Alternate,
}

fn direct_encoding(
    tool: &ToolDeclaration,
    track: BenchmarkTrack,
    action: ToolAction<'_>,
    preference: Preference,
) -> Option<Encoding> {
    let name = tool.base_name().to_ascii_lowercase();
    let path_key = if tool.has_property("path") {
        Some(PathKey::Path)
    } else if tool.has_property("file_path") {
        Some(PathKey::FilePath)
    } else {
        None
    };
    let edit_keys = if tool.has_property("edits") {
        Some(EditKeys::List)
    } else if tool.has_property("old_string") && tool.has_property("new_string") {
        Some(EditKeys::Snake)
    } else if tool.has_property("oldString") && tool.has_property("newString") {
        Some(EditKeys::Camel)
    } else if tool.has_property("oldText") && tool.has_property("newText") {
        Some(EditKeys::Text)
    } else {
        None
    };
    if track == BenchmarkTrack::SharedMcp {
        if tool.kind != ToolKind::Function || preference != Preference::Direct {
            return None;
        }
        let shared_name = if tool.name.starts_with("bench_") || name.starts_with("bench_") {
            Some(name.trim_start_matches("bench_"))
        } else if tool
            .namespace
            .as_deref()
            .or_else(|| tool.name.rsplit_once("__").map(|(prefix, _)| prefix))
            .is_some_and(|ns| ns == "bench" || ns == "mcp__bench")
        {
            Some(name.as_str())
        } else {
            None
        };
        return match (shared_name?, action) {
            ("read_file", ToolAction::Read { .. }) => Some(Encoding::Read(path_key?)),
            ("write_file", ToolAction::Write { .. }) if tool.has_property("content") => {
                Some(Encoding::Write(path_key?))
            }
            ("edit_file", ToolAction::Edit { .. }) => Some(Encoding::Edit(path_key?, edit_keys?)),
            ("exec_shell", ToolAction::Shell { .. }) if tool.has_property("command") => {
                Some(Encoding::Command("command"))
            }
            _ => None,
        };
    }

    if preference == Preference::Alternate {
        return match (name.as_str(), tool.kind, action) {
            ("exec_command", ToolKind::Function, ToolAction::Read { .. })
                if tool.has_property("cmd") =>
            {
                Some(Encoding::Command("cmd"))
            }
            ("shell_command", ToolKind::Function, ToolAction::Read { .. })
                if tool.has_property("command") =>
            {
                Some(Encoding::Command("command"))
            }
            (
                "apply_patch" | "applypatch",
                ToolKind::Function,
                ToolAction::Edit { .. } | ToolAction::Write { .. },
            ) if tool.has_property("patch") => Some(Encoding::Patch(Some("patch"))),
            (
                "apply_patch" | "applypatch",
                ToolKind::Function,
                ToolAction::Edit { .. } | ToolAction::Write { .. },
            ) if tool.has_property("input") => Some(Encoding::Patch(Some("input"))),
            (
                "apply_patch",
                ToolKind::Freeform,
                ToolAction::Edit { .. } | ToolAction::Write { .. },
            ) if tool.format_matches(|grammar| {
                grammar.contains("*** Begin Patch") && grammar.contains("*** End Patch")
            }) =>
            {
                Some(Encoding::Patch(None))
            }
            _ => None,
        };
    }
    if tool.kind != ToolKind::Function {
        return None;
    }
    match (name.as_str(), action) {
        ("read", ToolAction::Read { .. }) => Some(Encoding::Read(path_key?)),
        ("write", ToolAction::Write { .. }) if tool.has_property("content") => {
            Some(Encoding::Write(path_key?))
        }
        ("edit", ToolAction::Edit { .. }) => Some(Encoding::Edit(path_key?, edit_keys?)),
        ("bash" | "shell" | "shell_command", ToolAction::Shell { .. })
            if tool.has_property("command") =>
        {
            Some(Encoding::Command("command"))
        }
        ("exec_command", ToolAction::Shell { .. }) if tool.has_property("cmd") => {
            Some(Encoding::Command("cmd"))
        }
        ("exec", ToolAction::Shell { .. })
            if tool.has_property("command") && !tool.has_property("code") =>
        {
            Some(Encoding::Command("command"))
        }
        _ => None,
    }
}

fn is_patch_grammar(grammar: &str) -> bool {
    grammar.contains("*** Begin Patch") && grammar.contains("*** End Patch")
}

fn code_mode(tool: &ToolDeclaration) -> Option<Encoding> {
    if tool
        .description
        .as_deref()
        .is_some_and(|s| s.contains("Python") && !s.contains("JavaScript"))
    {
        return None;
    }
    let use_patch = tool.description.as_deref().is_some_and(|d| {
        (d.contains("ApplyPatch(") || d.contains("apply_patch(")) && !d.contains("Edit(")
    });
    match tool.kind {
        ToolKind::Function if tool.has_property("code") && !tool.has_property("command") => {
            Some(Encoding::Code {
                freeform: false,
                use_patch,
            })
        }
        ToolKind::Freeform
            if (tool
                .format
                .as_ref()
                .is_some_and(|format| format["type"] == "grammar")
                || tool
                    .description
                    .as_deref()
                    .is_some_and(|description| description.contains("JavaScript")))
                && tool.format_matches(|grammar| {
                    grammar.contains("plain_source: SOURCE") && grammar.contains(r"\/\/ @exec:")
                }) =>
        {
            Some(Encoding::Code {
                freeform: true,
                use_patch,
            })
        }
        _ => None,
    }
}

fn code_mode_source(
    workspace: &Path,
    actions: &[ToolAction<'_>],
    use_patch: bool,
) -> Result<String, ToolBindError> {
    let mut code = String::from("text(JSON.stringify(await Promise.all([\n");
    for (slot, action) in actions.iter().enumerate() {
        let (tool, input) = match *action {
            ToolAction::Read { path } => ("Read", json!({ "path": path })),
            ToolAction::Write { .. } | ToolAction::Edit { .. } if use_patch => (
                "ApplyPatch",
                json!({ "patch": patch_text(workspace, *action)? }),
            ),
            ToolAction::Write { path, content } => {
                ("Write", json!({ "path": path, "content": content }))
            }
            ToolAction::Edit { path, old, new, .. } => (
                "Edit",
                json!({ "path": path, "old_string": old, "new_string": new }),
            ),
            ToolAction::Shell { command, title } => {
                ("Shell", json!({ "command": command, "title": title }))
            }
        };
        writeln!(
            code,
            "  (async () => ({{slot:{slot}, result:await tools.{tool}({input})}}))(),"
        )
        .expect("writing to String");
    }
    code.push_str("])));");
    Ok(code)
}

fn patch_text(workspace: &Path, action: ToolAction<'_>) -> Result<String, ToolBindError> {
    let existing_write = match action {
        ToolAction::Write { path, .. } => std::fs::read_to_string(workspace.join(path)).ok(),
        _ => None,
    };
    let preserves_line_endings = match action {
        ToolAction::Write { content, .. } => {
            (content.is_empty() || content.ends_with('\n'))
                && existing_write
                    .as_deref()
                    .is_none_or(|old| old.is_empty() || old.ends_with('\n'))
        }
        ToolAction::Edit { hunk, .. } => {
            hunk.ends_with_newline && (hunk.after.is_empty() || hunk.after.ends_with('\n'))
        }
        _ => unreachable!("patch action"),
    };
    if !preserves_line_endings {
        return Err(unsupported(
            action.label(),
            vec!["apply_patch cannot preserve the requested missing final newline".into()],
        ));
    }
    let mut patch = String::from("*** Begin Patch\n");
    match action {
        ToolAction::Write { path, content } => {
            if let Some(old) = existing_write.as_deref() {
                writeln!(patch, "*** Update File: {path}\n@@").expect("writing to String");
                patch_lines(&mut patch, '-', old);
                patch_lines(&mut patch, '+', content);
            } else {
                writeln!(patch, "*** Add File: {path}").expect("writing to String");
                patch_lines(&mut patch, '+', content);
            }
        }
        ToolAction::Edit { path, hunk, .. } => {
            writeln!(patch, "*** Update File: {path}\n@@").expect("writing to String");
            patch_lines(&mut patch, '-', &hunk.before);
            patch_lines(&mut patch, '+', &hunk.after);
        }
        _ => unreachable!("patch action"),
    }
    patch.push_str("*** End Patch");
    if valid_patch(&patch) {
        Ok(patch)
    } else {
        Err(unsupported(
            action.label(),
            vec!["generated patch does not match apply_patch grammar".into()],
        ))
    }
}

fn patch_lines(patch: &mut String, prefix: char, content: &str) {
    for line in content.split_terminator('\n') {
        writeln!(patch, "{prefix}{line}").expect("writing to String");
    }
}

// This is the Add/Update subset of Codex's grammar that the binder emits.
fn valid_patch(patch: &str) -> bool {
    let Some(body) = patch
        .strip_prefix("*** Begin Patch\n")
        .and_then(|s| s.strip_suffix("\n*** End Patch"))
    else {
        return false;
    };
    let mut lines = body.split('\n');
    let Some(header) = lines.next() else {
        return false;
    };
    if let Some(path) = header.strip_prefix("*** Add File: ") {
        return valid_path(path) && lines.all(|line| line.starts_with('+'));
    }
    if let Some(path) = header.strip_prefix("*** Update File: ") {
        return valid_path(path)
            && lines.next() == Some("@@")
            && lines.clone().next().is_some()
            && lines.all(|line| line.starts_with(['-', '+']));
    }
    false
}

#[derive(Debug)]
pub(crate) struct BadBinding {
    pub(crate) name: String,
    pub(crate) namespace: Option<String>,
    schema: Arc<Value>,
    mode: BadToolMode,
}

impl BadBinding {
    pub(crate) fn encode(&self, seed: u64) -> CallPayload {
        let mode = match self.mode {
            BadToolMode::MissingRequired => SynthMode::MissingRequired,
            BadToolMode::WrongType => SynthMode::WrongType,
            BadToolMode::MalformedJson => SynthMode::MalformedJson,
        };
        let value =
            synthesize_tool_arguments(&self.schema, &mut fastrand::Rng::with_seed(seed), mode);
        match (self.mode, value) {
            (BadToolMode::MalformedJson, Value::String(raw)) => CallPayload::MalformedJson(raw),
            (_, value) => CallPayload::Function(value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Transport, normalize_request};

    fn function(name: &str, properties: Value, required: &[&str]) -> Value {
        json!({"type": "function", "name": name, "parameters": {
            "type": "object", "properties": properties, "required": required, "additionalProperties": false
        }})
    }

    fn catalog(tools: Vec<Value>) -> ToolCatalog {
        let request = normalize_request(
            0,
            Protocol::OpenaiResponsesHttp,
            Transport::Http,
            "/v1/responses".into(),
            Default::default(),
            Default::default(),
            json!({"tools": tools}),
        );
        ToolCatalog::from_request(&request)
    }

    #[test]
    fn binds_native_file_and_shell_shapes() {
        struct Harness {
            name: &'static str,
            tools: [&'static str; 4],
            path_key: &'static str,
            edit: EditKeys,
            shell_metadata: Option<&'static str>,
        }
        use EditKeys::{Camel, List, Snake, Text};
        let harnesses = [
            Harness {
                name: "Maka Direct",
                tools: ["Read", "Write", "Edit", "Shell"],
                path_key: "path",
                edit: Snake,
                shell_metadata: Some("title"),
            },
            Harness {
                name: "Claude Code",
                tools: ["Read", "Write", "Edit", "Bash"],
                path_key: "file_path",
                edit: Snake,
                shell_metadata: Some("description"),
            },
            Harness {
                name: "OpenCode v2",
                tools: ["read", "write", "edit", "shell"],
                path_key: "path",
                edit: Camel,
                shell_metadata: Some("description"),
            },
            Harness {
                name: "Pi 1.0",
                tools: ["read", "write", "edit", "bash"],
                path_key: "path",
                edit: List,
                shell_metadata: None,
            },
            Harness {
                name: "Pi-Durable",
                tools: ["read", "write", "edit", "bash"],
                path_key: "path",
                edit: List,
                shell_metadata: None,
            },
            Harness {
                name: "Dim",
                tools: ["read", "write", "edit", "exec"],
                path_key: "path",
                edit: Text,
                shell_metadata: None,
            },
            Harness {
                name: "DeepSeek Harness",
                tools: ["read", "write", "edit", "bash"],
                path_key: "file_path",
                edit: Snake,
                shell_metadata: Some("description"),
            },
            Harness {
                name: "ZCode",
                tools: ["Read", "Write", "Edit", "Bash"],
                path_key: "file_path",
                edit: Snake,
                shell_metadata: None,
            },
            Harness {
                name: "Kimi Code TS",
                tools: ["Read", "Write", "Edit", "Shell"],
                path_key: "path",
                edit: Snake,
                shell_metadata: None,
            },
        ];
        let cache = ValidatorCache::default();
        let workspace = Path::new("/bench/work");
        let hunk = EditHunk::new("marker\n", "marker", "changed").unwrap();
        for h in harnesses {
            let [read, write, edit, shell] = h.tools;
            let key = h.path_key;
            let file = if key == "file_path" {
                "/bench/work/src/a.txt"
            } else {
                "src/a.txt"
            };
            let string = json!({"type": "string"});
            let mut read_props = json!({key: string});
            if h.name == "Kimi Code TS" {
                read_props["line_offset"] = json!({"type": "integer"});
                read_props["n_lines"] = json!({"type": "integer"});
            }
            let (edit_props, required, expected) = match h.edit {
                Snake => (
                    json!({key: string, "old_string": string, "new_string": string}),
                    vec![key, "old_string", "new_string"],
                    json!({key: file, "old_string": "marker", "new_string": "changed"}),
                ),
                Camel => (
                    json!({key: string, "oldString": string, "newString": string}),
                    vec![key, "oldString", "newString"],
                    json!({key: file, "oldString": "marker", "newString": "changed"}),
                ),
                Text => (
                    json!({key: string, "oldText": string, "newText": string}),
                    vec![key, "oldText", "newText"],
                    json!({key: file, "oldText": "marker", "newText": "changed"}),
                ),
                List => (
                    json!({key: string, "edits": {"type": "array", "minItems": 1, "items": {
                        "type": "object", "required": ["oldText", "newText"],
                        "properties": {"oldText": string, "newText": string}, "additionalProperties": false
                    }}}),
                    vec![key, "edits"],
                    json!({key: file, "edits": [{"oldText": "marker", "newText": "changed"}]}),
                ),
            };
            let mut shell_props = json!({"command": string});
            let mut shell_expected = json!({"command": "printf ok"});
            let mut shell_required = vec!["command"];
            if let Some(metadata) = h.shell_metadata {
                shell_props[metadata] = json!({"type": "string", "minLength": 1});
                if h.name == "OpenCode v2" {
                    shell_required.push(metadata);
                    shell_expected[metadata] = json!("fixture");
                }
            }
            let catalog = catalog(vec![
                function(read, read_props, &[key]),
                function(
                    write,
                    json!({key: string, "content": string}),
                    &[key, "content"],
                ),
                function(edit, edit_props, &required),
                function(shell, shell_props, &shell_required),
            ]);
            let actions = [
                ToolAction::Read { path: "src/a.txt" },
                ToolAction::Write {
                    path: "src/a.txt",
                    content: "data\n",
                },
                ToolAction::Edit {
                    path: "src/a.txt",
                    old: "marker",
                    new: "changed",
                    hunk: &hunk,
                },
                ToolAction::Shell {
                    command: "printf ok",
                    title: "fixture",
                },
            ];
            let actual = catalog
                .bind(&cache, BenchmarkTrack::Native, workspace, &actions)
                .unwrap_or_else(|error| panic!("{}: {error}", h.name));
            assert_eq!(
                actual
                    .into_iter()
                    .map(|call| (call.recipe.name, call.payload))
                    .collect::<Vec<_>>(),
                h.tools
                    .into_iter()
                    .zip([
                        json!({key: file}),
                        json!({key: file, "content": "data\n"}),
                        expected,
                        shell_expected,
                    ])
                    .map(|(name, value)| (name.to_owned(), CallPayload::Function(value)))
                    .collect::<Vec<_>>(),
                "{}",
                h.name
            );
        }
    }

    #[test]
    fn maka_exec_wraps_slots_and_dim_exec_stays_a_shell_tool() {
        let string = json!({"type": "string"});
        let shell = function("exec", json!({"command": string}), &["command"]);
        let ambiguous_exec = function(
            "exec",
            json!({"command": string, "code": string}),
            &["command"],
        );
        let function_exec = function("exec", json!({"code": string}), &["code"]);
        let freeform_exec = json!({"type": "custom", "name": "exec", "format": {
            "type": "grammar", "syntax": "lark",
            "definition": r"start: pragma_source | plain_source
plain_source: SOURCE
PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
SOURCE: /[\s\S]+/"
        }});
        let read = ToolAction::Read { path: "src/a.txt" };
        let run = ToolAction::Shell {
            command: "printf ok",
            title: "fixture",
        };
        let validators = ValidatorCache::default();
        let workspace = Path::new("/bench/work");
        let dim = catalog(vec![shell]);
        assert!(matches!(
            dim.bind(&validators, BenchmarkTrack::Native, workspace, &[read]),
            Err(ToolBindError::UnsupportedAction { .. })
        ));
        assert_eq!(
            dim.bind(&validators, BenchmarkTrack::Native, workspace, &[run])
                .unwrap()[0]
                .payload,
            CallPayload::Function(json!({"command": "printf ok"}))
        );
        assert!(matches!(
            catalog(vec![ambiguous_exec]).bind(
                &validators,
                BenchmarkTrack::Native,
                workspace,
                &[run]
            ),
            Err(ToolBindError::UnsupportedAction { .. })
        ));
        for (tool, freeform) in [(function_exec, false), (freeform_exec, true)] {
            let maka = catalog(vec![tool]);
            let bound = maka
                .bind(&validators, BenchmarkTrack::Native, workspace, &[read, run])
                .unwrap();
            let [only] = bound.as_slice() else {
                panic!("expected one Code Mode call")
            };
            assert_eq!(only.recipe.slots, [0, 1]);
            let code = concat!(
                "text(JSON.stringify(await Promise.all([\n",
                "  (async () => ({slot:0, result:await tools.Read({\"path\":\"src/a.txt\"})}))(),\n",
                "  (async () => ({slot:1, result:await tools.Shell({\"command\":\"printf ok\",\"title\":\"fixture\"})}))(),\n",
                "])));",
            );
            assert_eq!(
                only.payload,
                if freeform {
                    CallPayload::Freeform(code.into())
                } else {
                    CallPayload::Function(json!({"code": code}))
                }
            );
        }
    }

    #[test]
    fn codex_patch_preserves_literal_line_prefixes_and_read_uses_shell_schema() {
        let codex = catalog(vec![
            json!({"type": "custom", "name": "apply_patch", "format": {
                "type": "grammar", "syntax": "lark",
                "definition": "start: \"*** Begin Patch\" hunk \"*** End Patch\""
            }}),
            function("exec_command", json!({"cmd": {"type": "string"}}), &["cmd"]),
        ]);
        let hunk = EditHunk::new("prefix old\nend\n", "old", "new\n*** End Patch").unwrap();
        let actions = [
            ToolAction::Edit {
                path: "src/a.txt",
                old: "old",
                new: "new\n*** End Patch",
                hunk: &hunk,
            },
            ToolAction::Write {
                path: "a.txt",
                content: "---\n",
            },
            ToolAction::Read { path: "a'b.txt" },
        ];
        let calls = codex
            .bind(
                &ValidatorCache::default(),
                BenchmarkTrack::Native,
                Path::new("/repo"),
                &actions,
            )
            .unwrap();
        assert_eq!(calls[0].payload, CallPayload::Freeform(
            "*** Begin Patch\n*** Update File: src/a.txt\n@@\n-prefix old\n+prefix new\n+*** End Patch\n*** End Patch".into()
        ));
        assert_eq!(
            calls[1].payload,
            CallPayload::Freeform(
                "*** Begin Patch\n*** Add File: a.txt\n+---\n*** End Patch".into()
            )
        );
        assert_eq!(
            calls[2].payload,
            CallPayload::Function(json!({"cmd": "cat -- 'a'\\''b.txt'"}))
        );
        assert!(!valid_patch(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n*** End Patch"
        ));
    }

    #[test]
    fn shared_mcp_matches_prefix_and_rejects_schema_incompatible_arguments() {
        let catalog = catalog(vec![
            function("Read", json!({"path": {"type": "string"}}), &["path"]),
            function(
                "mcp__bench__read_file",
                json!({"path": {"type": "string", "pattern": "^src/"}}),
                &["path"],
            ),
            function(
                "bench_write_file",
                json!({"path": {"type": "string"}, "content": {"type": "string"}}),
                &["path", "content"],
            ),
            function(
                "bench_edit_file",
                json!({"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}),
                &["path", "old_string", "new_string"],
            ),
            function(
                "mcp__bench__exec_shell",
                json!({"command": {"type": "string"}}),
                &["command"],
            ),
        ]);
        let cache = ValidatorCache::default();
        let hunk = EditHunk::new("old\n", "old", "new").unwrap();
        let good = catalog
            .bind(
                &cache,
                BenchmarkTrack::SharedMcp,
                Path::new("/repo"),
                &[
                    ToolAction::Read { path: "src/a.txt" },
                    ToolAction::Write {
                        path: "a.txt",
                        content: "",
                    },
                    ToolAction::Edit {
                        path: "src/a.txt",
                        old: "old",
                        new: "new",
                        hunk: &hunk,
                    },
                    ToolAction::Shell {
                        command: "printf ok",
                        title: "fixture",
                    },
                ],
            )
            .unwrap();
        assert_eq!(good[0].recipe.name, "mcp__bench__read_file");
        assert_eq!(good[1].recipe.name, "bench_write_file");
        assert_eq!(good[2].recipe.name, "bench_edit_file");
        assert_eq!(
            good[2].payload,
            CallPayload::Function(
                json!({"path": "src/a.txt", "old_string": "old", "new_string": "new"})
            )
        );
        assert_eq!(good[3].recipe.name, "mcp__bench__exec_shell");
        assert_eq!(
            good[3].payload,
            CallPayload::Function(json!({"command": "printf ok"}))
        );
        let error = catalog
            .bind(
                &cache,
                BenchmarkTrack::SharedMcp,
                Path::new("/repo"),
                &[ToolAction::Read {
                    path: "other/a.txt",
                }],
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("/properties/path/pattern"),
            "{error}"
        );
        assert!(matches!(
            EditHunk::new("aaa", "aa", "b"),
            Err(ToolBindError::InvalidAction(_))
        ));
    }
}
