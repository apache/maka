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

use super::{ID, Skills, remote::failure};
use crate::api::*;
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method, key},
    terminal_ui::{
        Context, Descriptor, Text,
        page::{Action, Control, Field, Page, Reply, Request, Row},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

const WINDOW: usize = 8;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Route {
    cursor: Option<Cursor>,
    offset: usize,
    reference: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    revision: String,
    cursor: String,
}

pub(super) fn publish(skills: &Skills, staged: &mut Staged) -> Result<(), String> {
    let endpoint = Endpoint::standalone(Handler::Method(Arc::new(View(skills.clone()))))
        .with_terminal_view(Descriptor::new(title(), Context::Session))
        .map_err(|e| e.to_string())?;
    staged
        .insert(key(ID, "terminal").map_err(|e| e.to_string())?, endpoint)
        .map_err(|e| e.to_string())
}
fn title() -> Text {
    Text::localized("Skills", "技能", "技能")
}

struct View(Skills);
impl Method for View {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let skills = self.0.clone();
        Box::pin(async move {
            let request: Request = serde_json::from_value(input).map_err(invalid)?;
            request.validate().map_err(invalid)?;
            let locale = request.locale().to_owned();
            let view = caller.views.session().await?;
            let context = WorkspaceContext {
                workspace: view.workspace.target.clone(),
            };
            let reply = match request {
                Request::Recover { .. } => {
                    return Err(invalid("This action has no recovery receipt"));
                }
                Request::Read { route, .. } => {
                    let route: Route = if route.is_null() {
                        Route::default()
                    } else {
                        serde_json::from_value(route).map_err(invalid)?
                    };
                    if route.offset >= MAX_ITEMS || !route.offset.is_multiple_of(WINDOW) {
                        return Err(invalid("Invalid Skills page offset"));
                    }
                    let input = if let Some(reference) = &route.reference {
                        CatalogInput::Lookup {
                            context,
                            reference: reference.clone(),
                        }
                    } else {
                        match &route.cursor {
                            None => CatalogInput::Start {
                                context,
                                view: CatalogView::Governance,
                            },
                            Some(cursor) => CatalogInput::Continue {
                                context,
                                view: CatalogView::Governance,
                                revision: cursor.revision.clone(),
                                cursor: cursor.cursor.clone(),
                            },
                        }
                    };
                    match skills
                        .query(&input, view.workspace, view.files)
                        .await
                        .map_err(failure)?
                    {
                        CatalogResult::RevisionChanged { .. } => Reply::Conflict,
                        CatalogResult::Page {
                            revision,
                            items,
                            next_cursor,
                            ..
                        } => project(route, revision, items, next_cursor)?,
                    }
                }
                Request::Submit {
                    route,
                    revision,
                    action,
                    fields,
                    grant,
                    ..
                } => {
                    if grant.is_some() {
                        return Err(invalid("Unexpected authorization"));
                    }
                    let route: Route = serde_json::from_value(route).map_err(invalid)?;
                    let reference = route
                        .reference
                        .clone()
                        .ok_or_else(|| invalid("Select a Skill"))?;
                    if action != "save" || fields.len() != 2 {
                        return Err(invalid("Unknown Skill action or fields"));
                    }
                    let enabled = fields
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| invalid("Invalid enabled state"))?;
                    let pinned = fields
                        .get("pinned")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| invalid("Invalid pin state"))?;
                    let mutation = Mutation::SetPreferences {
                        reference,
                        enabled,
                        pinned,
                    };
                    // The original service serializes the mutation, checks its revision,
                    // resolves the reference again, and owns accepted-write cleanup.
                    match skills
                        .mutate(
                            MutateInput {
                                grant: None,
                                context,
                                expected_revision: revision,
                                mutation,
                            },
                            view.workspace,
                            view.files,
                        )
                        .await
                        .map_err(failure)?
                        .outcome
                    {
                        MutationOutcome::Committed { .. } | MutationOutcome::Unchanged { .. } => {
                            Reply::Applied {
                                route: serde_json::to_value(route).map_err(invalid)?,
                            }
                        }
                        MutationOutcome::RevisionConflict { .. } => Reply::Conflict,
                        MutationOutcome::Rejected { reason } => Reply::Rejected {
                            message: rejection(reason),
                        },
                    }
                }
            };
            let reply = reply.view(&locale);
            reply.validate().map_err(invalid)?;
            serde_json::to_value(reply).map_err(invalid)
        })
    }
}

fn project(
    route: Route,
    revision: String,
    items: Vec<CatalogItem>,
    next_cursor: Option<String>,
) -> Result<Reply, Error> {
    let mut page = Page {
        title: title(),
        revision: revision.clone(),
        body: String::new(),
        rows: vec![],
        fields: vec![],
        actions: vec![],
    };
    if let Some(reference) = &route.reference {
        let item = items.iter().find_map(|item| match item {
            CatalogItem::Skill(item) | CatalogItem::DiscoveryDiagnostic(item)
                if &item.reference == reference =>
            {
                Some(item)
            }
            _ => None,
        });
        let Some(item) = item else {
            return Ok(Reply::Rejected {
                message: rejection(MutationRejection::NotFound),
            });
        };
        page.title = Text::plain(display(&item.name, 256, false));
        page.body = display(&item.description, 8192, true);
        let enabled = !item.needs_review && item.runtime_status != SkillRuntimeStatus::StateError;
        for (id, label, value) in [
            (
                "enabled",
                Text::localized("Enabled", "启用", "啟用"),
                item.enabled,
            ),
            (
                "pinned",
                Text::localized("Pinned", "置顶", "置頂"),
                item.pinned,
            ),
        ] {
            page.fields.push(Field {
                id: id.into(),
                label,
                enabled,
                control: Control::Toggle { value },
            });
        }
        page.actions.push(Action {
            id: "save".into(),
            label: Text::localized("Save", "保存", "儲存"),
            enabled,
            fields: vec!["enabled".into(), "pinned".into()],
            recovery: None,
        });
    } else {
        for item in items.iter().skip(route.offset).take(WINDOW) {
            let item = match item {
                CatalogItem::Skill(item) | CatalogItem::DiscoveryDiagnostic(item) => item,
                _ => return Err(invalid("Unexpected Skills catalog row")),
            };
            page.rows.push(Row {
                id: maka_runtime::artifact::content_digest(item.reference.as_bytes()),
                title: Text::plain(display(&item.name, 256, false)),
                description: display(&item.description, 160, false),
                route: serde_json::to_value(Route {
                    reference: Some(item.reference.clone()),
                    ..Route::default()
                })
                .map_err(invalid)?,
            });
        }
        let next = if route.offset + WINDOW < items.len() {
            Some(Route {
                offset: route.offset + WINDOW,
                ..route
            })
        } else {
            next_cursor.map(|cursor| Route {
                cursor: Some(Cursor { revision, cursor }),
                ..Route::default()
            })
        };
        if let Some(next) = next {
            page.rows.push(Row {
                id: "next".into(),
                title: Text::localized("Next", "下一页", "下一頁"),
                description: String::new(),
                route: serde_json::to_value(next).map_err(invalid)?,
            });
        }
    }
    Ok(Reply::Page { page })
}
fn display(value: &str, max: usize, multiline: bool) -> String {
    let mut text = String::new();
    for c in value.chars().filter(|c| {
        (!c.is_control() || multiline && matches!(c, '\n' | '\t'))
            && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    }) {
        if text.len() + c.len_utf8() > max {
            break;
        }
        text.push(c);
    }
    if !multiline && text.trim().is_empty() {
        text = "—".into();
    }
    text
}
fn invalid(error: impl ToString) -> Error {
    Error::Invalid(error.to_string())
}
fn rejection(reason: MutationRejection) -> Text {
    match reason {
        MutationRejection::NotFound => {
            Text::localized("Skill no longer exists", "技能已不存在", "技能已不存在")
        }
        MutationRejection::NeedsReview => Text::localized(
            "Review this Skill before changing it",
            "请先审核此技能",
            "請先審核此技能",
        ),
        _ => Text::localized(
            "Skill preference could not be saved; refresh and check its availability",
            "无法保存技能偏好，请刷新并检查其可用性",
            "無法儲存技能偏好，請重新整理並檢查其可用性",
        ),
    }
}
