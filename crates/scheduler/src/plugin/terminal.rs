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

mod create;
mod timing;

use super::{ID, Service, remote::error};
use crate::{
    authorization::Origin,
    command::{Mutation, Query, QueryResult, Update},
    task::{Intent, Status, Task},
};
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
use std::{collections::BTreeMap, sync::Arc};

const WINDOW: usize = 8;
const INTENT_BYTES: usize = 16 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Route {
    cursor: Option<String>,
    revision: Option<u64>,
    offset: usize,
    task: Option<String>,
    timing: bool,
    creation: Option<create::Route>,
}

pub(super) fn publish(service: Service, staged: &mut Staged) -> Result<(), String> {
    let endpoint = Endpoint::standalone(Handler::Method(Arc::new(View(service))))
        .with_terminal_view(Descriptor::new(
            Text::localized("Scheduled tasks", "计划任务", "排程任務"),
            Context::Application,
        ))
        .map_err(super::display)?;
    staged
        .insert(key(ID, "terminal").map_err(super::display)?, endpoint)
        .map_err(super::display)
}

struct View(Service);
impl Method for View {
    fn call(&self, input: Value, _: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let service = self.0.clone();
        Box::pin(async move {
            let request: Request = serde_json::from_value(input).map_err(invalid)?;
            request.validate().map_err(invalid)?;
            let locale = request.locale().to_owned();
            let _lease = service.context.admit().map_err(|_| Error::Retired)?;
            let reply = match request {
                Request::Recover { route, .. } => create::recover(&service, route).await?,
                Request::Read { route, .. } => read(&service, decode(route)?)?,
                Request::Submit {
                    route,
                    revision,
                    action,
                    fields,
                    grant,
                    ..
                } => {
                    let route = decode(route)?;
                    if let Some(creation) = route.creation {
                        create::submit(&service, creation, revision, action, fields, grant).await?
                    } else {
                        if grant.is_some() {
                            return Err(invalid("Unexpected authorization"));
                        }
                        submit(&service, route, revision, action, fields).await?
                    }
                }
            };
            let reply = reply.view(&locale);
            reply.validate().map_err(invalid)?;
            serde_json::to_value(reply).map_err(invalid)
        })
    }
}

async fn submit(
    service: &Service,
    route: Route,
    revision: String,
    action: String,
    fields: BTreeMap<String, Value>,
) -> Result<Reply, Error> {
    let task_id = route.task.clone().ok_or_else(|| invalid("Select a task"))?;
    let revision = revision.parse::<u64>().map_err(invalid)?;
    let mutation = if route.timing {
        if action != "save_schedule" {
            return Err(invalid("Unknown schedule action"));
        }
        let QueryResult::Task {
            task: Some(task),
            revision: Some(current),
            timezone: Some(timezone),
        } = service
            .query(Query::Get {
                task_id: task_id.clone(),
            })
            .map_err(error)?
        else {
            return Ok(Reply::Conflict);
        };
        if current != revision {
            return Ok(Reply::Conflict);
        }
        let patch = match timing::update(&task.schedule, &timezone, fields) {
            Ok(schedule) => schedule,
            Err(_) => {
                return Ok(Reply::Rejected {
                    message: Text::localized(
                        "Check the date, UTC offset and recurrence fields",
                        "请检查日期、时区偏移和重复规则",
                        "請檢查日期、時區偏移和重複規則",
                    ),
                });
            }
        };
        Mutation::Update {
            task_id,
            patch: Update {
                schedule: (patch != task.schedule).then_some(patch),
                ..Update::default()
            },
        }
    } else {
        mutation(task_id, &action, fields)?
    };
    // The preliminary read only decodes the form; the owner still checks the
    // same revision after any concurrent edit before accepting this mutation.
    Ok(
        match service
            .handle
            .mutate_if_current(mutation, Origin::User { grant: None }, revision)
            .await
        {
            Ok(_) => Reply::Applied {
                route: serde_json::to_value(route).map_err(invalid)?,
            },
            Err(crate::Error::RevisionConflict) => Reply::Conflict,
            Err(crate::Error::Invalid(_) | crate::Error::Time(_)) => Reply::Rejected {
                message: Text::localized(
                    "Check the task fields and status",
                    "请检查任务内容和状态",
                    "請檢查任務內容和狀態",
                ),
            },
            Err(failure) => return Err(error(failure)),
        },
    )
}

fn decode(value: Value) -> Result<Route, Error> {
    let route: Route = if value.is_null() {
        Route::default()
    } else {
        serde_json::from_value(value).map_err(invalid)?
    };
    if route.offset >= 64
        || route.creation.is_some()
            && (route.task.is_some()
                || route.cursor.is_some()
                || route.revision.is_some()
                || route.offset != 0
                || route.timing)
        || route.timing && route.task.is_none()
        || !route.offset.is_multiple_of(WINDOW)
        || route.task.is_some()
            && (route.cursor.is_some() || route.revision.is_some() || route.offset != 0)
    {
        return Err(invalid("Invalid scheduled-task route"));
    }
    Ok(route)
}
fn read(service: &Service, route: Route) -> Result<Reply, Error> {
    if let Some(creation) = route.creation {
        return create::read(service, creation);
    }
    if let Some(task_id) = route.task {
        return match service.query(Query::Get { task_id }).map_err(error)? {
            QueryResult::Task {
                task: Some(task),
                revision: Some(revision),
                timezone: Some(timezone),
            } => Ok(Reply::Page {
                page: if route.timing {
                    timing::page(&task, revision, &timezone)?
                } else {
                    detail(*task, revision)
                },
            }),
            QueryResult::Task { task: None, .. } => Ok(Reply::Rejected {
                message: Text::localized("Task no longer exists", "任务已不存在", "任務已不存在"),
            }),
            _ => Err(invalid("Missing task revision")),
        };
    }
    match service
        .query(Query::List {
            cursor: route.cursor.clone(),
            expected_revision: route.revision,
        })
        .map_err(error)?
    {
        QueryResult::RevisionChanged { .. } => Ok(Reply::Conflict),
        QueryResult::Page {
            revision,
            tasks,
            next_cursor,
        } => {
            let mut page = empty(
                Text::localized("Scheduled tasks", "计划任务", "排程任務"),
                revision,
            );
            page.rows.push(create::entry());
            if route.offset > tasks.len() {
                return Err(invalid("Unknown scheduled-task offset"));
            }
            for task in tasks.iter().skip(route.offset).take(WINDOW) {
                page.rows.push(Row {
                    id: task.id.clone(),
                    title: Text::plain(display(&task.title, 256, false)),
                    description: format!("{}  {}", status(task.status), instant(task.next_fire_at)),
                    route: serde_json::to_value(Route {
                        task: Some(task.id.clone()),
                        ..Route::default()
                    })
                    .map_err(invalid)?,
                });
            }
            let next = if route.offset + WINDOW < tasks.len() {
                Some(Route {
                    cursor: Some(route.cursor.unwrap_or_else(|| "0".into())),
                    revision: Some(revision),
                    offset: route.offset + WINDOW,
                    task: None,
                    timing: false,
                    creation: None,
                })
            } else {
                next_cursor.map(|cursor| Route {
                    cursor: Some(cursor),
                    revision: Some(revision),
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
            Ok(Reply::Page { page })
        }
        _ => Err(invalid("Expected scheduled-task page")),
    }
}
fn detail(task: Task, revision: u64) -> Page {
    let mut page = empty(Text::plain(display(&task.title, 256, false)), revision);
    page.rows.push(Row {
        id: "schedule".into(),
        title: timing::title(&task.schedule),
        description: String::new(),
        route: serde_json::to_value(Route {
            task: Some(task.id.clone()),
            timing: true,
            ..Route::default()
        })
        .expect("task route"),
    });
    page.body = format!("{}  {}", status(task.status), instant(task.next_fire_at));
    let Intent::Text { body } = task.intent;
    // Never save a sanitized or truncated field over the original task content.
    let editable = matches!(task.status, Status::Active | Status::Paused)
        && body.len() <= INTENT_BYTES
        && display(&body, INTENT_BYTES, true) == body
        && display(&task.title, 512, false) == task.title;
    if editable {
        page.fields = vec![
            field(
                "title",
                Text::localized("Title", "标题", "標題"),
                task.title,
                512,
                false,
            ),
            field(
                "intent",
                Text::localized("Content", "内容", "內容"),
                body,
                INTENT_BYTES,
                true,
            ),
        ];
        page.actions.push(Action {
            id: "save".into(),
            label: Text::localized("Save", "保存", "儲存"),
            enabled: true,
            fields: vec!["title".into(), "intent".into()],
            recovery: None,
        });
    } else {
        page.body.push_str("\n\n");
        page.body
            .push_str(&display(&body, 32 * 1024 - page.body.len(), true));
    }
    let action = match task.status {
        Status::Active => Some(("pause", Text::localized("Pause", "暂停", "暫停"))),
        Status::Paused => Some(("resume", Text::localized("Resume", "恢复", "恢復"))),
        _ => None,
    };
    if let Some((id, label)) = action {
        page.actions.push(Action {
            id: id.into(),
            label,
            enabled: true,
            fields: vec![],
            recovery: None,
        });
    }
    page
}
fn empty(title: Text, revision: u64) -> Page {
    Page {
        title,
        revision: revision.to_string(),
        body: String::new(),
        rows: vec![],
        fields: vec![],
        actions: vec![],
    }
}
fn field(id: &str, label: Text, value: String, max_bytes: usize, multiline: bool) -> Field {
    Field {
        id: id.into(),
        label,
        enabled: true,
        control: Control::Text {
            value,
            max_bytes,
            multiline,
            placeholder: String::new(),
        },
    }
}
fn mutation(
    task_id: String,
    action: &str,
    mut fields: BTreeMap<String, Value>,
) -> Result<Mutation, Error> {
    match action {
        "save" if fields.len() == 2 => {
            let title = fields
                .remove("title")
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(|| invalid("Invalid task title"))?;
            let intent_body = fields
                .remove("intent")
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(|| invalid("Invalid task content"))?;
            Ok(Mutation::Update {
                task_id,
                patch: Update {
                    title: Some(title),
                    intent_body: Some(intent_body),
                    ..Update::default()
                },
            })
        }
        "pause" if fields.is_empty() => Ok(Mutation::Pause { task_id }),
        "resume" if fields.is_empty() => Ok(Mutation::Resume { task_id }),
        _ => Err(invalid("Unknown scheduled-task action or fields")),
    }
}
fn status(value: Status) -> &'static str {
    match value {
        Status::Active => "▶",
        Status::Paused => "Ⅱ",
        Status::Completed => "✓",
        Status::Expired => "—",
    }
}
fn instant(value: Option<i64>) -> String {
    value
        .and_then(|value| jiff::Timestamp::from_millisecond(value).ok())
        .map_or_else(String::new, |value| {
            value
                .to_zoned(jiff::tz::TimeZone::system())
                .strftime("%Y-%m-%d %H:%M %:z")
                .to_string()
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        plan::Plan,
        schedule::Schedule,
        task::{Create, Creator, Effect, Notification},
    };

    #[test]
    fn unrepresentable_content_is_read_only_never_a_truncated_edit() {
        for body in [
            "界".repeat(8000),
            "unsafe\u{202e}text".into(),
            "ordinary\ntext".into(),
        ] {
            let task = Plan::create(
                "one".into(),
                Create {
                    title: "Reminder".into(),
                    intent_body: body.clone(),
                    schedule: Schedule::Once { run_at: 10_000 },
                    effect: Effect::Notify(Notification::Local),
                    max_fires: None,
                    expires_at: None,
                },
                Creator::User,
                "UTC".into(),
                1000,
            )
            .unwrap()
            .task;
            let page = detail(task, 42);
            page.clone().view("en").validate().unwrap();
            let editable = body == "ordinary\ntext";
            assert_eq!(
                page.actions.iter().any(|action| action.id == "save"),
                editable
            );
            assert_eq!(!page.fields.is_empty(), editable);
            if editable {
                assert!(
                    matches!(&page.fields[1].control, Control::Text { value, .. } if value == &body)
                );
            }
        }
        assert!(
            mutation(
                "one".into(),
                "pause",
                BTreeMap::from([("intent".into(), Value::String("hidden edit".into()))])
            )
            .is_err()
        );
    }
}
