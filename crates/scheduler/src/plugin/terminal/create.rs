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

use super::{
    Action, Error, Reply, Row, Service, Text, Value, empty, error, field, invalid, timing,
};
use crate::{
    authorization::Origin,
    command::{Mutation, MutationResult},
    schedule::{Recurrence, Schedule},
    task::{Create, Effect, Notification},
};
use maka_plugins::authorization::{Capability, Id, Request, Target};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Route {
    Pick,
    Form { schedule: Kind },
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Kind {
    Once,
    Interval,
    Daily,
    Weekly,
    Monthly,
    Cron,
}
impl Kind {
    fn schedule(self, at: i64) -> Schedule {
        match self {
            Self::Once => Schedule::Once { run_at: at },
            Self::Interval => Schedule::Interval {
                every_seconds: 3600,
                start_at: at,
            },
            Self::Daily | Self::Weekly | Self::Monthly => Schedule::Calendar {
                recurrence: match self {
                    Self::Daily => Recurrence::Daily,
                    Self::Weekly => Recurrence::Weekly,
                    _ => Recurrence::Monthly,
                },
                anchor_at: at,
            },
            Self::Cron => Schedule::Cron {
                expression: "0 9 * * *".into(),
                start_at: at,
            },
        }
    }
}
fn title() -> Text {
    Text::localized("New reminder", "新建提醒", "新增提醒")
}
fn route(creation: Route) -> Value {
    serde_json::to_value(super::Route {
        creation: Some(creation),
        ..super::Route::default()
    })
    .expect("creation route")
}
pub(super) fn entry() -> Row {
    Row {
        id: "create".into(),
        title: title(),
        description: String::new(),
        route: route(Route::Pick),
    }
}
pub(super) fn read(service: &Service, creation: Route) -> Result<Reply, Error> {
    let mut page = empty(title(), 0);
    match creation {
        Route::Pick => {
            for (i, kind) in [
                Kind::Once,
                Kind::Interval,
                Kind::Daily,
                Kind::Weekly,
                Kind::Monthly,
                Kind::Cron,
            ]
            .into_iter()
            .enumerate()
            {
                page.rows.push(Row {
                    id: format!("schedule-{i}"),
                    title: timing::title(&kind.schedule(0)),
                    description: String::new(),
                    route: route(Route::Form { schedule: kind }),
                });
            }
        }
        Route::Form { schedule } => {
            page.revision = uuid::Uuid::new_v4().to_string();
            page.body = service.timezone.clone();
            page.fields = vec![
                field(
                    "title",
                    Text::localized("Title", "标题", "標題"),
                    String::new(),
                    512,
                    false,
                ),
                field(
                    "intent",
                    Text::localized("Content", "内容", "內容"),
                    String::new(),
                    super::INTENT_BYTES,
                    true,
                ),
            ];
            page.fields.extend(timing::fields(
                &schedule.schedule(jiff::Timestamp::now().as_millisecond() + 3_600_000),
                &service.timezone,
            )?);
            page.actions.push(Action {
                id: "create".into(),
                label: Text::localized("Create reminder", "创建提醒", "建立提醒"),
                enabled: true,
                fields: page.fields.iter().map(|field| field.id.clone()).collect(),
                recovery: Some(serde_json::json!({"operation":page.revision})),
                confirm: None,
            });
        }
    }
    Ok(Reply::Page { page })
}
pub(super) async fn submit(
    service: &Service,
    route: Route,
    revision: String,
    action: String,
    mut fields: BTreeMap<String, Value>,
    grant: Option<Id>,
) -> Result<Reply, Error> {
    let Route::Form { schedule } = route else {
        return Err(invalid("Select a reminder schedule"));
    };
    if action != "create" {
        return Err(invalid("Unknown reminder action"));
    }
    let operation_id = uuid::Uuid::parse_str(&revision).map_err(invalid)?;
    let recorded = service
        .creation(operation_id)
        .await
        .map_err(error)?
        .is_some();
    let input = (|| {
        let title = take(&mut fields, "title")?;
        let intent_body = take(&mut fields, "intent")?;
        let schedule = timing::update(&schedule.schedule(0), &service.timezone, fields)?;
        let input = Create {
            title,
            intent_body,
            schedule,
            effect: Effect::Notify(Notification::Local),
            max_fires: None,
            expires_at: None,
        };
        if !recorded {
            input
                .validate(jiff::Timestamp::now().as_millisecond())
                .map_err(invalid)?;
        }
        Ok::<_, Error>(input)
    })();
    let input = match input {
        Ok(input) => input,
        Err(_) => {
            return Ok(Reply::Rejected {
                message: Text::localized(
                    "Check the title, content, date and recurrence",
                    "请检查标题、内容、日期和重复规则",
                    "請檢查標題、內容、日期和重複規則",
                ),
            });
        }
    };
    let grant = if recorded {
        // Reconciliation is a read of the original creation, not a new grant.
        // The owner still checks the complete immutable input fingerprint.
        None
    } else {
        Some(match grant {
            Some(id) => id,
            None => match service
                .backend
                .authorization(Origin::User { grant: None }, input.effect.clone())
                .await
            {
                Ok(authorization) => authorization.grant,
                Err(crate::Error::AuthorizationRequired) => {
                    return Ok(Reply::Consent {
                        request: Request {
                            operation_id,
                            title: "Scheduled reminders".into(),
                            target: Target::Profile,
                            capabilities: [Capability::Notifications].into(),
                        },
                    });
                }
                Err(failure) => return Err(error(failure)),
            },
        })
    };
    let MutationResult::Created { task_id, .. } = service
        .mutate(
            Mutation::CreateOnce {
                operation_id,
                input,
            },
            Origin::User { grant },
        )
        .await
        .map_err(error)?
    else {
        return Err(invalid("Expected a created task"));
    };
    Ok(Reply::Applied {
        route: serde_json::to_value(super::Route {
            task: Some(task_id),
            ..super::Route::default()
        })
        .map_err(invalid)?,
    })
}
pub(super) async fn recover(service: &Service, value: Value) -> Result<Reply, Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Recovery {
        operation: uuid::Uuid,
    }
    let recovery: Recovery = serde_json::from_value(value).map_err(invalid)?;
    match service.creation(recovery.operation).await.map_err(error)? {
        Some(task) => Ok(Reply::Applied {
            route: serde_json::to_value(super::Route {
                task: Some(task),
                ..Default::default()
            })
            .map_err(invalid)?,
        }),
        None => Ok(Reply::Unrecorded),
    }
}
fn take(fields: &mut BTreeMap<String, Value>, key: &str) -> Result<String, Error> {
    fields
        .remove(key)
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| invalid("Missing reminder field"))
}
