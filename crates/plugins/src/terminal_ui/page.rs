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

//! A simple form page for presenters that need no more: prose, links to
//! other routes, fields and actions, laid out the standard way. It renders
//! into a [`View`]; the wire only knows views.

use super::{
    Text, VERSION,
    view::{self, Node, Role, Target, Tone, View, build},
};
use serde_json::Value;

pub use super::view::{Control, Request};

/// What a page presenter answers; [`Reply::view`] turns it into the wire
/// reply in the caller's locale.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply {
    /// No committed receipt was observed; this does not prove non-admission.
    Unrecorded,
    Page {
        page: Page,
    },
    Applied {
        route: Value,
    },
    Conflict,
    Rejected {
        message: Text,
    },
    /// Inert proposal. Only an explicit application consent action may approve it.
    Consent {
        request: crate::authorization::Request,
    },
}
impl Reply {
    pub fn view(self, locale: &str) -> view::Reply {
        match self {
            Self::Unrecorded => view::Reply::Unrecorded,
            Self::Page { page } => view::Reply::View {
                view: page.view(locale),
            },
            Self::Applied { route } => view::Reply::Applied { route },
            Self::Conflict => view::Reply::Conflict,
            Self::Rejected { message } => view::Reply::Rejected {
                message: message.resolve(locale).into(),
            },
            Self::Consent { request } => view::Reply::Consent { request },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub title: Text,
    pub revision: String,
    pub body: String,
    pub rows: Vec<Row>,
    pub fields: Vec<Field>,
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub title: Text,
    pub description: String,
    pub route: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub id: String,
    pub label: Text,
    pub enabled: bool,
    pub control: Control,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Action {
    pub id: String,
    pub label: Text,
    pub enabled: bool,
    /// Only these fields are submitted; unrelated drafts are not implicit input.
    pub fields: Vec<String>,
    /// Opaque read-only recovery route; see [`view::Action::recovery`].
    pub recovery: Option<Value>,
    /// The shell asks first; a destructive one reads as such.
    pub confirm: Option<view::Confirm>,
}

impl Page {
    /// The page as a view in `locale`: its prose, then its rows, fields and
    /// the actions in one row, the first of them primary.
    pub fn view(self, locale: &str) -> View {
        let mut children = vec![];
        if !self.body.is_empty() {
            children.push(Node::Column {
                key: "body".into(),
                gap: 0,
                children: self
                    .body
                    .split('\n')
                    .enumerate()
                    .map(|(index, line)| build::text(format!("line{index}"), line, Tone::Normal))
                    .collect(),
            });
        }
        if !self.rows.is_empty() {
            children.push(Node::Column {
                key: "rows".into(),
                gap: 0,
                children: self
                    .rows
                    .iter()
                    .map(|row| Node::Item {
                        key: row.id.clone(),
                        title: row.title.resolve(locale).into(),
                        detail: row.description.clone(),
                        meta: String::new(),
                        tone: Tone::Normal,
                        current: false,
                        target: Target::Route {
                            route: row.route.clone(),
                        },
                    })
                    .collect(),
            });
        }
        if !self.fields.is_empty() {
            children.push(Node::Column {
                key: "fields".into(),
                gap: 0,
                children: self
                    .fields
                    .iter()
                    .map(|field| {
                        build::input(
                            field.id.clone(),
                            field.id.clone(),
                            field.label.resolve(locale),
                        )
                    })
                    .collect(),
            });
        }
        if !self.actions.is_empty() {
            children.push(build::row(
                "actions",
                self.actions
                    .iter()
                    .enumerate()
                    .map(|(index, action)| {
                        let role = match &action.confirm {
                            Some(confirm) if confirm.destructive => Role::Destructive,
                            _ if index == 0 => Role::Primary,
                            _ => Role::Normal,
                        };
                        build::button(action.id.clone(), action.id.clone(), role)
                    })
                    .collect(),
            ));
        }
        View {
            version: VERSION,
            title: self.title.resolve(locale).into(),
            revision: self.revision,
            fields: self
                .fields
                .into_iter()
                .map(|field| view::Field {
                    id: field.id,
                    enabled: field.enabled,
                    control: field.control,
                })
                .collect(),
            actions: self
                .actions
                .into_iter()
                .map(|action| view::Action {
                    id: action.id,
                    label: action.label.resolve(locale).into(),
                    enabled: action.enabled,
                    fields: action.fields,
                    recovery: action.recovery,
                    confirm: action.confirm,
                })
                .collect(),
            root: build::column("page", children),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_page_renders_a_valid_localized_view_that_submits_its_fields() {
        let page = Page {
            title: Text::localized("Preferences", "偏好", "偏好"),
            revision: "r1".into(),
            body: "First line\nSecond".into(),
            rows: vec![Row {
                id: "detail".into(),
                title: Text::plain("Details"),
                description: "More".into(),
                route: json!({"page":"detail"}),
            }],
            fields: vec![Field {
                id: "enabled".into(),
                label: Text::localized("Enabled", "启用", "啟用"),
                enabled: true,
                control: view::Control::Toggle { value: true },
            }],
            actions: vec![Action {
                id: "save".into(),
                label: Text::plain("Save"),
                enabled: true,
                fields: vec!["enabled".into()],
                recovery: None,
                confirm: None,
            }],
        };
        let view = page.view("zh-CN");
        view.validate().unwrap();
        assert_eq!(view.title, "偏好");
        view.submission(
            json!(null),
            "save",
            [("enabled".to_string(), json!(false))].into(),
            "zh-CN".into(),
        )
        .unwrap();
    }
}
