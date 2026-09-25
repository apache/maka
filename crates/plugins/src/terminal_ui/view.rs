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

//! A terminal view is a bounded component tree a plugin presents in the
//! TUI. It describes structure and meaning only: the terminal kernel owns
//! layout, focus, hover, scrolling and editing, so nothing here waits on the
//! plugin. Fields hold the drafts the user edits; actions submit named
//! fields with the view's revision; navigation reads another route of the
//! same view. Text is already localized for the requested locale.

use super::VERSION;
use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// One view shares Remote's payload budget.
pub const MAX_BYTES: usize = 64 * 1024;
pub const MAX_NODES: usize = 512;
pub const MAX_DEPTH: usize = 12;
pub const MAX_FIELDS: usize = 32;
pub const MAX_ACTIONS: usize = 32;
pub const MAX_TEXT: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct View {
    pub version: u32,
    pub title: String,
    /// Opaque business revision, echoed with every submission for CAS.
    pub revision: String,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub actions: Vec<Action>,
    pub root: Node,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub id: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub control: Control,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Control {
    Toggle {
        value: bool,
    },
    Text {
        value: String,
        max_bytes: usize,
        #[serde(default)]
        multiline: bool,
        #[serde(default)]
        placeholder: String,
        /// Drawn masked, for keys and passwords; its value is never shown.
        #[serde(default)]
        secret: bool,
    },
    /// One of a few values, chosen from a pop-up.
    Choice {
        value: String,
        options: Vec<Choice>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub id: String,
    pub label: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Only these fields are submitted; unrelated drafts are not implicit input.
    #[serde(default)]
    pub fields: Vec<String>,
    /// Opaque read-only recovery route. Declares that replaying this exact
    /// submission is idempotent, including after deletion of its result.
    #[serde(default)]
    pub recovery: Option<Value>,
    /// The shell asks before submitting, in its own trusted sheet.
    #[serde(default)]
    pub confirm: Option<Confirm>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub title: String,
    pub message: String,
    #[serde(default)]
    pub destructive: bool,
}

/// What a text span means; the theme decides how it looks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    #[default]
    Normal,
    Strong,
    Muted,
    Subtle,
    Accent,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    #[default]
    Normal,
    Primary,
    Destructive,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Span {
    pub text: String,
    #[serde(default)]
    pub tone: Tone,
}

/// What activating an item or button does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    /// Read another route of this view; Back returns.
    Route { route: Value },
    /// Submit a declared action.
    Action { action: String },
    /// Open a Maka session in the shell, such as one a plugin started.
    Session { session: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tab {
    pub id: String,
    pub label: String,
    pub route: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Node {
    Column {
        key: String,
        #[serde(default)]
        gap: u8,
        children: Vec<Node>,
    },
    Row {
        key: String,
        #[serde(default)]
        gap: u8,
        children: Vec<Node>,
    },
    /// Wrapped prose, or one clipped line.
    Text {
        key: String,
        spans: Vec<Span>,
        #[serde(default)]
        clip: bool,
    },
    Rule {
        key: String,
    },
    /// A region that scrolls once its content passes `rows`.
    Scroll {
        key: String,
        rows: u16,
        child: Box<Node>,
    },
    /// A master–detail pair; `ratio` is the left pane's share in percent.
    Split {
        key: String,
        #[serde(default = "half")]
        ratio: u8,
        left: Box<Node>,
        right: Box<Node>,
    },
    /// Sibling routes of the view, one of them current.
    Tabs {
        key: String,
        current: String,
        tabs: Vec<Tab>,
    },
    /// A list row: what it is, a secondary line, and trailing detail.
    Item {
        key: String,
        title: String,
        #[serde(default)]
        detail: String,
        #[serde(default)]
        meta: String,
        #[serde(default)]
        tone: Tone,
        #[serde(default)]
        current: bool,
        target: Target,
    },
    Button {
        key: String,
        action: String,
        #[serde(default)]
        role: Role,
        /// Defaults to the action's label.
        #[serde(default)]
        label: Option<String>,
    },
    /// A labelled editor for a text or choice field, or a labelled switch
    /// for a toggle field.
    Input {
        key: String,
        field: String,
        #[serde(default)]
        label: String,
    },
    Progress {
        key: String,
        value: u64,
        max: u64,
        #[serde(default)]
        label: String,
    },
    Markdown {
        key: String,
        text: String,
    },
    Code {
        key: String,
        text: String,
    },
    /// A locally interactive reader backed by a bounded page/live resource.
    Transcript {
        key: String,
        resource: super::transcript::Resource,
    },
    /// Where other plugins' views that fill `name` are shown, each given
    /// `context` as its starting route.
    Slot {
        key: String,
        name: String,
        #[serde(default)]
        context: Value,
    },
}

fn half() -> u8 {
    50
}

impl Node {
    pub fn key(&self) -> &str {
        match self {
            Self::Column { key, .. }
            | Self::Row { key, .. }
            | Self::Text { key, .. }
            | Self::Rule { key }
            | Self::Scroll { key, .. }
            | Self::Split { key, .. }
            | Self::Tabs { key, .. }
            | Self::Item { key, .. }
            | Self::Button { key, .. }
            | Self::Input { key, .. }
            | Self::Progress { key, .. }
            | Self::Markdown { key, .. }
            | Self::Code { key, .. }
            | Self::Transcript { key, .. }
            | Self::Slot { key, .. } => key,
        }
    }
    /// Direct children, in order.
    pub fn children(&self) -> Vec<&Node> {
        match self {
            Self::Column { children, .. } | Self::Row { children, .. } => children.iter().collect(),
            Self::Scroll { child, .. } => vec![child],
            Self::Split { left, right, .. } => vec![left, right],
            _ => vec![],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Recover {
        route: Value,
        locale: String,
    },
    Read {
        route: Value,
        locale: String,
    },
    Submit {
        route: Value,
        revision: String,
        action: String,
        fields: BTreeMap<String, Value>,
        grant: Option<crate::authorization::Id>,
        locale: String,
    },
}

/// A successful write is acknowledged independently of the following read.
/// Failure to refresh cannot turn a committed write into a retryable one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    /// No committed receipt was observed; this does not prove non-admission.
    Unrecorded,
    View {
        view: View,
    },
    Applied {
        route: Value,
    },
    Conflict,
    Rejected {
        message: String,
    },
    /// Inert proposal. Only an explicit application consent action may approve it.
    Consent {
        request: crate::authorization::Request,
    },
}

fn invalid() -> Error {
    Error::Invalid("Invalid terminal view".into())
}
fn bounded(value: &impl Serialize, max: usize) -> Result<(), Error> {
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > max {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn identifier(value: &str) -> Result<(), Error> {
    if value.is_empty() || value.len() > 256 || !safe(value, false) {
        return Err(invalid());
    }
    Ok(())
}
/// Keys join into paths, so a separator inside one would alias another node.
/// Room for a content digest, which plugins commonly use as a row identity.
fn key(value: &str) -> Result<(), Error> {
    identifier(value)?;
    if value.contains('/') || value.len() > 128 {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn safe(value: &str, multiline: bool) -> bool {
    !value.chars().any(|c| {
        (c.is_control() && !(multiline && matches!(c, '\n' | '\t')))
            || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    })
}
fn prose(value: &str, max: usize, multiline: bool) -> Result<(), Error> {
    if value.len() > max || !safe(value, multiline) {
        return Err(invalid());
    }
    Ok(())
}
fn label(value: &str) -> Result<(), Error> {
    if value.trim().is_empty() {
        return Err(invalid());
    }
    prose(value, 256, false)
}
fn locale(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 32
        || value
            .split('-')
            .any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric()))
    {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn route(value: &Value) -> Result<(), Error> {
    fn count(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), Error> {
        *nodes += 1;
        if depth > 8 || *nodes > 128 {
            return Err(invalid());
        }
        match value {
            Value::Array(items) => {
                for item in items {
                    count(item, depth + 1, nodes)?;
                }
            }
            Value::Object(items) => {
                for (key, item) in items {
                    if !safe(key, false) {
                        return Err(invalid());
                    }
                    count(item, depth + 1, nodes)?;
                }
            }
            Value::String(text) if !safe(text, false) => return Err(invalid()),
            _ => {}
        }
        Ok(())
    }
    count(value, 0, &mut 0)?;
    bounded(value, 8192)
}

/// What validating the tree records for the checks that span it.
#[derive(Default)]
struct Walk<'a> {
    nodes: usize,
    transcripts: usize,
    inputs: BTreeSet<&'a str>,
    actions: BTreeSet<&'a str>,
}

impl View {
    pub fn validate(&self) -> Result<(), Error> {
        if self.version != VERSION
            || self.fields.len() > MAX_FIELDS
            || self.actions.len() > MAX_ACTIONS
        {
            return Err(invalid());
        }
        label(&self.title)?;
        identifier(&self.revision)?;
        let mut fields = BTreeSet::new();
        for field in &self.fields {
            identifier(&field.id)?;
            if !fields.insert(field.id.as_str()) {
                return Err(invalid());
            }
            match &field.control {
                Control::Toggle { .. } => {}
                Control::Text {
                    value,
                    max_bytes,
                    multiline,
                    placeholder,
                    ..
                } => {
                    if *max_bytes == 0 || *max_bytes > MAX_TEXT || value.len() > *max_bytes {
                        return Err(invalid());
                    }
                    prose(value, *max_bytes, *multiline)?;
                    prose(placeholder, 256, false)?;
                }
                Control::Choice { value, options } => {
                    let mut seen = BTreeSet::new();
                    if options.is_empty() || options.len() > 32 {
                        return Err(invalid());
                    }
                    for option in options {
                        identifier(&option.value)?;
                        label(&option.label)?;
                        if !seen.insert(option.value.as_str()) {
                            return Err(invalid());
                        }
                    }
                    if !seen.contains(value.as_str()) {
                        return Err(invalid());
                    }
                }
            }
        }
        let mut actions = BTreeSet::new();
        for action in &self.actions {
            identifier(&action.id)?;
            label(&action.label)?;
            if let Some(value) = &action.recovery {
                // null represents absence on the wire, not a replay promise.
                if value.is_null() {
                    return Err(invalid());
                }
                route(value)?;
            }
            if let Some(confirm) = &action.confirm {
                label(&confirm.title)?;
                prose(&confirm.message, 1024, true)?;
            }
            let mut used = BTreeSet::new();
            if !actions.insert(action.id.as_str())
                || action
                    .fields
                    .iter()
                    .any(|id| !fields.contains(id.as_str()) || !used.insert(id))
            {
                return Err(invalid());
            }
        }
        let mut walk = Walk::default();
        self.node(&self.root, 0, &fields, &actions, &mut walk)?;
        bounded(self, MAX_BYTES - 64)
    }

    fn node<'a>(
        &self,
        node: &'a Node,
        depth: usize,
        fields: &BTreeSet<&str>,
        actions: &BTreeSet<&str>,
        walk: &mut Walk<'a>,
    ) -> Result<(), Error> {
        walk.nodes += 1;
        if depth > MAX_DEPTH || walk.nodes > MAX_NODES {
            return Err(invalid());
        }
        key(node.key())?;
        match node {
            Node::Column { gap, children, .. } | Node::Row { gap, children, .. } => {
                // Children count against the view's node budget, not a
                // container's: a checklist may hold its whole list.
                let mut keys = BTreeSet::new();
                if *gap > 4 {
                    return Err(invalid());
                }
                for child in children {
                    if !keys.insert(child.key()) {
                        return Err(invalid());
                    }
                }
            }
            Node::Text { spans, .. } => {
                if spans.len() > 32 {
                    return Err(invalid());
                }
                // Long prose is bounded by the view's own budget.
                for span in spans {
                    prose(&span.text, MAX_BYTES, true)?;
                }
            }
            Node::Rule { .. } => {}
            Node::Scroll { rows, .. } => {
                if !(1..=64).contains(rows) {
                    return Err(invalid());
                }
            }
            Node::Split {
                ratio, left, right, ..
            } => {
                if !(20..=80).contains(ratio) || left.key() == right.key() {
                    return Err(invalid());
                }
            }
            Node::Tabs { current, tabs, .. } => {
                let mut ids = BTreeSet::new();
                if tabs.is_empty() || tabs.len() > 16 {
                    return Err(invalid());
                }
                for tab in tabs {
                    key(&tab.id)?;
                    label(&tab.label)?;
                    route(&tab.route)?;
                    if !ids.insert(tab.id.as_str()) {
                        return Err(invalid());
                    }
                }
                if !ids.contains(current.as_str()) {
                    return Err(invalid());
                }
            }
            Node::Item {
                title,
                detail,
                meta,
                target,
                ..
            } => {
                label(title)?;
                prose(detail, 1024, false)?;
                prose(meta, 256, false)?;
                self.target(target, actions)?;
            }
            Node::Button {
                action,
                label: text,
                ..
            } => {
                if !actions.contains(action.as_str()) {
                    return Err(invalid());
                }
                if let Some(value) = text {
                    label(value)?;
                }
                walk.actions.insert(action);
            }
            Node::Input {
                field, label: name, ..
            } => {
                // One editor per field: two would race over the same draft.
                if !fields.contains(field.as_str()) || !walk.inputs.insert(field) {
                    return Err(invalid());
                }
                prose(name, 256, false)?;
            }
            Node::Progress {
                value,
                max,
                label: name,
                ..
            } => {
                if *max == 0 || value > max {
                    return Err(invalid());
                }
                prose(name, 256, false)?;
            }
            Node::Markdown { text: body, .. } | Node::Code { text: body, .. } => {
                prose(body, MAX_BYTES, true)?;
            }
            Node::Slot { name, context, .. } => {
                identifier(name)?;
                route(context)?;
            }
            Node::Transcript { resource, .. } => {
                walk.transcripts += 1;
                if walk.transcripts > 4 {
                    return Err(invalid());
                }
                resource.validate()?;
            }
        }
        for child in node.children() {
            self.node(child, depth + 1, fields, actions, walk)?;
        }
        Ok(())
    }

    fn target(&self, target: &Target, actions: &BTreeSet<&str>) -> Result<(), Error> {
        match target {
            Target::Route { route: value } => route(value),
            Target::Action { action } if actions.contains(action.as_str()) => Ok(()),
            Target::Action { .. } => Err(invalid()),
            Target::Session { session } => identifier(session),
        }
    }

    pub fn field(&self, id: &str) -> Option<&Field> {
        self.fields.iter().find(|field| field.id == id)
    }
    pub fn action(&self, id: &str) -> Option<&Action> {
        self.actions.iter().find(|action| action.id == id)
    }

    /// A presentation check, not authorization: the plugin must validate again.
    pub fn submission(
        &self,
        route: Value,
        action: &str,
        fields: BTreeMap<String, Value>,
        locale: String,
    ) -> Result<Request, Error> {
        self.validate()?;
        let action = self
            .actions
            .iter()
            .find(|item| item.id == action && item.enabled)
            .ok_or_else(invalid)?;
        if action.fields.len() != fields.len() {
            return Err(invalid());
        }
        for id in &action.fields {
            let field = self
                .fields
                .iter()
                .find(|field| &field.id == id && field.enabled)
                .ok_or_else(invalid)?;
            let value = fields.get(id).ok_or_else(invalid)?;
            match &field.control {
                Control::Toggle { .. } if value.is_boolean() => {}
                Control::Text {
                    max_bytes,
                    multiline,
                    ..
                } if value
                    .as_str()
                    .is_some_and(|text| text.len() <= *max_bytes && safe(text, *multiline)) => {}
                Control::Choice { options, .. }
                    if value.as_str().is_some_and(|value| {
                        options.iter().any(|option| option.value == value)
                    }) => {}
                _ => return Err(invalid()),
            }
        }
        let request = Request::Submit {
            route,
            revision: self.revision.clone(),
            action: action.id.clone(),
            fields,
            grant: None,
            locale,
        };
        request.validate()?;
        Ok(request)
    }
}

impl Request {
    pub fn locale(&self) -> &str {
        match self {
            Self::Read { locale, .. }
            | Self::Recover { locale, .. }
            | Self::Submit { locale, .. } => locale,
        }
    }
    pub fn validate(&self) -> Result<(), Error> {
        locale(self.locale())?;
        match self {
            Self::Read { route: value, .. } | Self::Recover { route: value, .. } => route(value)?,
            Self::Submit {
                route: value,
                revision,
                action,
                fields,
                ..
            } => {
                route(value)?;
                identifier(revision)?;
                identifier(action)?;
                if fields.len() > MAX_FIELDS {
                    return Err(invalid());
                }
                for (id, value) in fields {
                    identifier(id)?;
                    match value {
                        Value::Bool(_) => {}
                        Value::String(text) if text.len() <= MAX_TEXT && safe(text, true) => {}
                        _ => return Err(invalid()),
                    }
                }
            }
        }
        bounded(self, MAX_BYTES)
    }
}

impl Reply {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::View { view } => view.validate()?,
            Self::Applied { route: value } => route(value)?,
            Self::Rejected { message } => {
                label(message)?;
            }
            Self::Conflict | Self::Unrecorded => {}
            Self::Consent { request } => request.validate()?,
        }
        bounded(self, MAX_BYTES)
    }
}

/// Builders for presenters written in Rust. Each returns a plain node, so
/// a view reads as the tree it is.
pub mod build {
    use super::*;

    pub fn column(key: impl Into<String>, children: Vec<Node>) -> Node {
        Node::Column {
            key: key.into(),
            gap: 1,
            children,
        }
    }
    /// A column without spacing: lines that belong together.
    pub fn stack(key: impl Into<String>, children: Vec<Node>) -> Node {
        Node::Column {
            key: key.into(),
            gap: 0,
            children,
        }
    }
    pub fn row(key: impl Into<String>, children: Vec<Node>) -> Node {
        Node::Row {
            key: key.into(),
            gap: 2,
            children,
        }
    }
    pub fn text(key: impl Into<String>, text: impl Into<String>, tone: Tone) -> Node {
        Node::Text {
            key: key.into(),
            spans: vec![Span {
                text: text.into(),
                tone,
            }],
            clip: false,
        }
    }
    pub fn spans(key: impl Into<String>, spans: Vec<(String, Tone)>) -> Node {
        Node::Text {
            key: key.into(),
            spans: spans
                .into_iter()
                .map(|(text, tone)| Span { text, tone })
                .collect(),
            clip: false,
        }
    }
    pub fn heading(key: impl Into<String>, text: impl Into<String>) -> Node {
        self::text(key, text, Tone::Strong)
    }
    pub fn rule(key: impl Into<String>) -> Node {
        Node::Rule { key: key.into() }
    }
    pub fn scroll(key: impl Into<String>, rows: u16, child: Node) -> Node {
        Node::Scroll {
            key: key.into(),
            rows,
            child: Box::new(child),
        }
    }
    pub fn split(key: impl Into<String>, ratio: u8, left: Node, right: Node) -> Node {
        Node::Split {
            key: key.into(),
            ratio,
            left: Box::new(left),
            right: Box::new(right),
        }
    }
    /// A row that opens another route of the view.
    pub fn link(key: impl Into<String>, title: impl Into<String>, route: Value) -> Item {
        Item(Node::Item {
            key: key.into(),
            title: title.into(),
            detail: String::new(),
            meta: String::new(),
            tone: Tone::Normal,
            current: false,
            target: Target::Route { route },
        })
    }
    /// A row that submits an action.
    pub fn act(
        key: impl Into<String>,
        title: impl Into<String>,
        action: impl Into<String>,
    ) -> Item {
        Item(Node::Item {
            key: key.into(),
            title: title.into(),
            detail: String::new(),
            meta: String::new(),
            tone: Tone::Normal,
            current: false,
            target: Target::Action {
                action: action.into(),
            },
        })
    }
    /// An item being built; `.into()` finishes it.
    pub struct Item(Node);
    impl Item {
        fn with(
            mut self,
            apply: impl FnOnce(&mut String, &mut String, &mut Tone, &mut bool),
        ) -> Self {
            if let Node::Item {
                detail,
                meta,
                tone,
                current,
                ..
            } = &mut self.0
            {
                apply(detail, meta, tone, current);
            }
            self
        }
        pub fn detail(self, value: impl Into<String>) -> Self {
            let value = value.into();
            self.with(|detail, _, _, _| *detail = value)
        }
        pub fn meta(self, value: impl Into<String>) -> Self {
            let value = value.into();
            self.with(|_, meta, _, _| *meta = value)
        }
        pub fn tone(self, value: Tone) -> Self {
            self.with(|_, _, tone, _| *tone = value)
        }
        pub fn current(self, value: bool) -> Self {
            self.with(|_, _, _, current| *current = value)
        }
    }
    impl From<Item> for Node {
        fn from(item: Item) -> Self {
            item.0
        }
    }
    pub fn button(key: impl Into<String>, action: impl Into<String>, role: Role) -> Node {
        Node::Button {
            key: key.into(),
            action: action.into(),
            role,
            label: None,
        }
    }
    pub fn input(
        key: impl Into<String>,
        field: impl Into<String>,
        label: impl Into<String>,
    ) -> Node {
        Node::Input {
            key: key.into(),
            field: field.into(),
            label: label.into(),
        }
    }
    pub fn progress(
        key: impl Into<String>,
        value: u64,
        max: u64,
        label: impl Into<String>,
    ) -> Node {
        Node::Progress {
            key: key.into(),
            value: value.min(max.max(1)),
            max: max.max(1),
            label: label.into(),
        }
    }
    pub fn markdown(key: impl Into<String>, text: impl Into<String>) -> Node {
        Node::Markdown {
            key: key.into(),
            text: text.into(),
        }
    }
    pub fn tabs(
        key: impl Into<String>,
        current: impl Into<String>,
        tabs: Vec<(String, String, Value)>,
    ) -> Node {
        Node::Tabs {
            key: key.into(),
            current: current.into(),
            tabs: tabs
                .into_iter()
                .map(|(id, label, route)| Tab { id, label, route })
                .collect(),
        }
    }
    pub fn slot(key: impl Into<String>, name: impl Into<String>, context: Value) -> Node {
        Node::Slot {
            key: key.into(),
            name: name.into(),
            context,
        }
    }
    pub fn transcript(
        key: impl Into<String>,
        resource: super::super::transcript::Resource,
    ) -> Node {
        Node::Transcript {
            key: key.into(),
            resource,
        }
    }
    pub fn action(id: impl Into<String>, label: impl Into<String>) -> Action {
        Action {
            id: id.into(),
            label: label.into(),
            enabled: true,
            fields: vec![],
            recovery: None,
            confirm: None,
        }
    }
    pub fn toggle(id: impl Into<String>, value: bool) -> Field {
        Field {
            id: id.into(),
            enabled: true,
            control: Control::Toggle { value },
        }
    }
    pub fn line(id: impl Into<String>, value: impl Into<String>, max_bytes: usize) -> Field {
        Field {
            id: id.into(),
            enabled: true,
            control: Control::Text {
                value: value.into(),
                max_bytes,
                multiline: false,
                placeholder: String::new(),
                secret: false,
            },
        }
    }
    /// A multi-line text field.
    pub fn area(id: impl Into<String>, value: impl Into<String>, max_bytes: usize) -> Field {
        Field {
            id: id.into(),
            enabled: true,
            control: Control::Text {
                value: value.into(),
                max_bytes,
                multiline: true,
                placeholder: String::new(),
                secret: false,
            },
        }
    }
    /// One of a few values, shown with their labels.
    pub fn choice(
        id: impl Into<String>,
        value: impl Into<String>,
        options: Vec<(String, String)>,
    ) -> Field {
        Field {
            id: id.into(),
            enabled: true,
            control: Control::Choice {
                value: value.into(),
                options: options
                    .into_iter()
                    .map(|(value, label)| Choice { value, label })
                    .collect(),
            },
        }
    }
    pub fn code(key: impl Into<String>, text: impl Into<String>) -> Node {
        Node::Code {
            key: key.into(),
            text: text.into(),
        }
    }
    /// Neutralizes what business text may carry into a view: control and
    /// bidirectional-override characters become spaces.
    pub fn clean(value: &str, multiline: bool) -> String {
        value
            .chars()
            .map(|ch| {
                if (ch.is_control() && !(multiline && matches!(ch, '\n' | '\t')))
                    || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                {
                    ' '
                } else {
                    ch
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{build::*, *};
    use serde_json::json;

    fn view() -> View {
        View {
            version: VERSION,
            title: "Preferences".into(),
            revision: "r1".into(),
            fields: vec![toggle("enabled", true)],
            actions: vec![Action {
                fields: vec!["enabled".into()],
                ..action("save", "Save")
            }],
            root: column(
                "root",
                vec![
                    heading("title", "Preferences"),
                    input("enabled", "enabled", "Enabled"),
                    link("detail", "Details", json!({"page":"detail"}))
                        .detail("More")
                        .into(),
                    button("save", "save", Role::Primary),
                ],
            ),
        }
    }

    #[test]
    fn views_bound_their_tree_bind_each_field_once_and_reject_unsafe_content() {
        let valid = view();
        valid.validate().unwrap();
        let fields = BTreeMap::from([("enabled".into(), json!(false))]);
        valid
            .submission(json!(null), "save", fields.clone(), "en".into())
            .unwrap()
            .validate()
            .unwrap();
        let invalid = |edit: &dyn Fn(&mut View)| {
            let mut view = view();
            edit(&mut view);
            view.validate().is_err()
        };
        assert!(invalid(&|view| view.version += 1));
        assert!(invalid(&|view| view.fields.push(view.fields[0].clone())));
        assert!(invalid(&|view| view.actions[0]
            .fields
            .push("absent".into())));
        assert!(invalid(&|view| view.actions[0].recovery = Some(Value::Null)));
        assert!(invalid(&|view| {
            view.root = column(
                "root",
                vec![
                    input("a", "enabled", "Enabled"),
                    input("b", "enabled", "Again"),
                ],
            )
        }));
        assert!(invalid(&|view| {
            view.root = column("root", vec![text("same", "a", Tone::Normal), rule("same")])
        }));
        assert!(invalid(
            &|view| view.root = text("a/b", "aliasing key", Tone::Normal)
        ));
        assert!(invalid(
            &|view| view.root = text("x", "\u{001b}[2J", Tone::Normal)
        ));
        assert!(invalid(
            &|view| view.root = text("x", "\u{202e}spoof", Tone::Normal)
        ));
        assert!(invalid(
            &|view| view.root = button("b", "absent", Role::Normal)
        ));
        assert!(invalid(&|view| {
            view.root = tabs("t", "absent", vec![("a".into(), "A".into(), json!(null))])
        }));
        assert!(invalid(&|view| {
            let mut node = text("leaf", "deep", Tone::Normal);
            for depth in 0..=MAX_DEPTH {
                node = column(format!("level{depth}"), vec![node]);
            }
            view.root = node;
        }));
        assert!(invalid(&|view| {
            view.root = column(
                "root",
                (0..MAX_NODES).map(|n| rule(format!("r{n}"))).collect(),
            )
        }));
        assert!(
            valid
                .submission(json!(null), "save", fields.clone(), "en\u{1b}".into())
                .is_err()
        );
        assert!(
            valid
                .submission(
                    json!(null),
                    "save",
                    BTreeMap::from([("enabled".into(), json!("false"))]),
                    "en".into()
                )
                .is_err()
        );
        let mut wire = serde_json::to_value(valid).unwrap();
        wire["root"]["children"][0]["kind"] = json!("frame_buffer");
        assert!(serde_json::from_value::<View>(wire).is_err());
    }
}
