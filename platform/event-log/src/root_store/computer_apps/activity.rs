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

//! Human app Stop uses a native selection recorded by the original source T1.
//! Its logical Turn scope is independent of remembered permission grants.
use super::*;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::interaction::{ComputerAppActivity, ComputerAppDisplay};
use sqlx::{Row, sqlite::SqliteRow};

pub(super) fn instance_key(
    target: &GrantTarget,
    display: &ComputerAppDisplay,
) -> Result<String, StoreError> {
    let GrantScope::ComputerApp { platform, .. } = target.scope else {
        return Err(invalid("app activity requires a native app target"));
    };
    display.validate(platform).map_err(invalid)?;
    Ok(serde_json::to_string(&(
        app_key(target)?,
        &display.app_path,
    ))?)
}

pub(crate) async fn require_computer_app_running(
    connection: &mut SqliteConnection,
    invocation: &Invocation,
    target: &GrantTarget,
    display: &ComputerAppDisplay,
) -> Result<(), StoreError> {
    if stopped(
        connection,
        &invocation.session_id,
        &invocation.turn_id,
        &instance_key(target, display)?,
    )
    .await?
    {
        return Err(StoreError::PermissionRevoked);
    }
    Ok(())
}

pub(crate) async fn record_computer_app_activity(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    target: &GrantTarget,
    display: &ComputerAppDisplay,
) -> Result<(), StoreError> {
    let Fact::ToolDispatched { operation_id, .. } = &event.fact else {
        return Err(invalid("app activity requires an original native dispatch"));
    };
    let activity = ComputerAppActivity {
        invocation: event.invocation.clone(),
        operation_id: operation_id.clone(),
        target: target.clone(),
        display: display.clone(),
    };
    activity.validate().map_err(invalid)?;
    sqlx::query(
        "INSERT INTO computer_app_turn_activity VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id,turn_id,app_key) DO NOTHING",
    )
    .bind(&activity.invocation.session_id)
    .bind(&activity.invocation.turn_id)
    .bind(instance_key(target, display)?)
    .bind(&event.id)
    .bind(operation_id)
    .bind(encode(&activity)?)
    .execute(connection)
    .await?;
    Ok(())
}

pub(super) async fn stopped(
    connection: &mut SqliteConnection,
    session: &str,
    turn: &str,
    key: &str,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM computer_app_turn_stops WHERE session_id=? AND turn_id=? AND app_key=?)")
        .bind(session).bind(turn).bind(key).fetch_one(connection).await?)
}

// Every selector keeps its original dispatched event, even after that action
// settles. Index seeks are bounded by apps in this Turn, not prior tool history.
macro_rules! activity_rows {
    ($tail:literal) => { concat!(
"SELECT app.session_id,app.turn_id,app.app_key,app.operation_id,app.record_json,
    source.invocation_id,source.kind,source.operation_id,
    EXISTS(SELECT 1 FROM computer_app_turn_stops stop
        WHERE stop.session_id=app.session_id AND stop.turn_id=app.turn_id AND stop.app_key=app.app_key)
    FROM computer_app_turn_activity app JOIN event_log source ON source.event_id=app.source_event", $tail) };
}

fn activity(row: SqliteRow) -> Result<(ComputerAppActivity, bool), StoreError> {
    let activity: ComputerAppActivity = decode(row.try_get(4)?)?;
    activity.validate().map_err(invalid)?;
    if activity.invocation.session_id != row.try_get::<String, _>(0)?
        || activity.invocation.turn_id != row.try_get::<String, _>(1)?
        || instance_key(&activity.target, &activity.display)? != row.try_get::<String, _>(2)?
        || activity.operation_id != row.try_get::<String, _>(3)?
        || activity.invocation.invocation_id != row.try_get::<String, _>(5)?
        || row.try_get::<String, _>(6)? != "tool_dispatched"
        || activity.operation_id != row.try_get::<String, _>(7)?
    {
        return Err(invalid("native app activity lost its original source"));
    }
    Ok((activity, row.try_get(8)?))
}

impl SessionStore {
    pub async fn computer_app_stopped(
        &self,
        invocation: &Invocation,
        target: &GrantTarget,
        display: &ComputerAppDisplay,
    ) -> Result<bool, StoreError> {
        self.check_session(&invocation.session_id)?;
        let invocation = invocation.clone();
        let key = instance_key(target, display)?;
        self.scoped()
            .await?
            .connection
            .read(move |connection| {
                Box::pin(async move {
                    stopped(
                        connection,
                        &invocation.session_id,
                        &invocation.turn_id,
                        &key,
                    )
                    .await
                })
            })
            .await
    }

    pub async fn computer_apps(
        &self,
        session: &str,
    ) -> Result<Vec<(ComputerAppActivity, bool)>, StoreError> {
        self.check_session(session)?;
        let session = session.to_owned();
        self.scoped()
            .await?
            .connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let Some(current) = turns::read(&mut tx, &session, None).await? else {
                        return Ok(Vec::new());
                    };
                    if current.state.terminal_outcome().is_some() {
                        return Ok(Vec::new());
                    }
                    let rows = sqlx::query(activity_rows!(
                        " WHERE app.session_id=? AND app.turn_id=? ORDER BY app.app_key"
                    ))
                    .bind(&session)
                    .bind(&current.invocation.turn_id)
                    .fetch_all(&mut *tx)
                    .await?;
                    let result = rows
                        .into_iter()
                        .map(activity)
                        .collect::<Result<Vec<_>, _>>()?;
                    tx.commit().await?;
                    Ok(result)
                })
            })
            .await
    }

    /// The host supplies an observed source operation, never an app selector.
    /// A completed call remains selectable while its exact logical Turn is live.
    pub async fn stop_computer_app_operation(
        &self,
        operation_id: &str,
        now: u64,
    ) -> Result<bool, StoreError> {
        entity_id(operation_id).map_err(invalid)?;
        crate::sessions::validate_time(now)?;
        let partition = self.control_source().await?;
        let control = self.control.upgrade().ok_or(StoreError::ConnectionClosed)?;
        let session = self.id.to_string();
        let operation = operation_id.to_owned();
        let notice = partition.commits.session(&session);
        partition
            .connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let Some(current) = turns::read(&mut tx, &session, None).await? else {
                        return Ok(false);
                    };
                    if current.state.terminal_outcome().is_some() {
                        return Ok(false);
                    }
                    let row = sqlx::query(activity_rows!(
                        " WHERE app.session_id=? AND app.operation_id=?"
                    ))
                    .bind(&session)
                    .bind(operation)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let Some(row) = row else {
                        return Ok(false);
                    };
                    let (selected, already_stopped) = activity(row)?;
                    if selected.invocation.turn_id != current.invocation.turn_id {
                        return Ok(false);
                    }
                    if already_stopped {
                        return Ok(true);
                    }
                    let key = instance_key(&selected.target, &selected.display)?;
                    let root_key = key.clone();
                    let root_scope = current.invocation.clone();
                    control
                        .connection
                        .run(move |connection| {
                            Box::pin(async move {
                                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                                let ids: Vec<String> = sqlx::query_scalar(
                                    "SELECT request_id FROM interaction_pending WHERE session_id=?",
                                )
                                .bind(&root_scope.session_id)
                                .fetch_all(&mut *tx)
                                .await?;
                                let closure = InteractionOutcome::Closure {
                                    reason: ClosureReason::ProducerCancelled,
                                    committed_at: now,
                                };
                                let mut count = 0;
                                for id in ids {
                                    let record = read(&mut tx, &id).await?.ok_or_else(|| {
                                        invalid("pending app request disappeared")
                                    })?;
                                    if record.turn_id != root_scope.turn_id {
                                        continue;
                                    }
                                    if let InteractionRequest::ComputerApp {
                                        target, display, ..
                                    } = &record.request
                                        && instance_key(target, display)? == root_key
                                    {
                                        sqlx::query("INSERT INTO interaction_outcomes VALUES(?,?)")
                                            .bind(id)
                                            .bind(encode(&closure)?)
                                            .execute(&mut *tx)
                                            .await?;
                                        count += 1;
                                    }
                                }
                                if count > 0 {
                                    crate::sessions::advance_catalog(&mut tx).await?;
                                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                                } else {
                                    tx.rollback().await?;
                                }
                                Ok(())
                            })
                        })
                        .await?;
                    sqlx::query("INSERT INTO computer_app_turn_stops VALUES(?,?,?,?)")
                        .bind(&session)
                        .bind(&current.invocation.turn_id)
                        .bind(key)
                        .bind(now as i64)
                        .execute(&mut *tx)
                        .await?;
                    crate::sessions::advance_revision(&mut tx, &session).await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    notice.metadata();
                    Ok(true)
                })
            })
            .await
    }
}
