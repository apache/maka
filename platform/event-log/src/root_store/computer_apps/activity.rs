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

pub(crate) fn require_computer_app_running(
    connection: &SqliteConnection,
    invocation: &Invocation,
    target: &GrantTarget,
    display: &ComputerAppDisplay,
) -> Result<(), StoreError> {
    if stopped(
        connection,
        &invocation.session_id,
        &invocation.turn_id,
        &instance_key(target, display)?,
    )? {
        return Err(StoreError::PermissionRevoked);
    }
    Ok(())
}

pub(crate) fn record_computer_app_activity(
    connection: &SqliteConnection,
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
    connection.execute(
        "INSERT INTO computer_app_turn_activity VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id,turn_id,app_key) DO NOTHING",
        rusqlite::params![
            &activity.invocation.session_id,
            &activity.invocation.turn_id,
            instance_key(target, display)?,
            &event.id,
            operation_id,
            encode(&activity)?
        ],
    )?;
    Ok(())
}

pub(super) fn stopped(
    connection: &SqliteConnection,
    session: &str,
    turn: &str,
    key: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM computer_app_turn_stops WHERE session_id=? AND turn_id=? AND app_key=?)", rusqlite::params![session, turn, key], |row| row.get(0))?)
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

fn activity(
    row: (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        bool,
    ),
) -> Result<(ComputerAppActivity, bool), StoreError> {
    let activity: ComputerAppActivity = decode(&row.4)?;
    activity.validate().map_err(invalid)?;
    if activity.invocation.session_id != row.0
        || activity.invocation.turn_id != row.1
        || instance_key(&activity.target, &activity.display)? != row.2
        || activity.operation_id != row.3
        || activity.invocation.invocation_id != row.5
        || row.6 != "tool_dispatched"
        || activity.operation_id != row.7
    {
        return Err(invalid("native app activity lost its original source"));
    }
    Ok((activity, row.8))
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
                {
                    stopped(
                        connection,
                        &invocation.session_id,
                        &invocation.turn_id,
                        &key,
                    )
                }
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
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let Some(current) = turns::read(&tx, &session, None)? else {
                    return Ok(Vec::new());
                };
                if current.state.terminal_outcome().is_some() {
                    return Ok(Vec::new());
                }
                let rows = tx
                    .prepare_cached(activity_rows!(
                        " WHERE app.session_id=? AND app.turn_id=? ORDER BY app.app_key"
                    ))?
                    .query_map(
                        rusqlite::params![&session, &current.invocation.turn_id],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                                row.get(6)?,
                                row.get(7)?,
                                row.get(8)?,
                            ))
                        },
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                let result = rows
                    .into_iter()
                    .map(activity)
                    .collect::<Result<Vec<_>, _>>()?;
                tx.commit()?;
                Ok(result)
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
        let log = self.scoped().await?;
        let session = self.id.to_string();
        let operation = operation_id.to_owned();
        let notice = log.commits.session(&session);
        log.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let Some(current) = turns::read(&tx, &session, None)? else {
                    return Ok(false);
                };
                if current.state.terminal_outcome().is_some() {
                    return Ok(false);
                }
                let row = tx
                    .query_row(
                        activity_rows!(" WHERE app.session_id=? AND app.operation_id=?"),
                        rusqlite::params![&session, operation],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                                row.get(6)?,
                                row.get(7)?,
                                row.get(8)?,
                            ))
                        },
                    )
                    .optional()?;
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
                let ids: Vec<String> = tx
                    .prepare_cached(
                        "SELECT request_id FROM interaction_pending WHERE session_id=?",
                    )?
                    .query_map(rusqlite::params![&current.invocation.session_id], |row| {
                        row.get(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let closure = InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled,
                    committed_at: now,
                };
                for id in ids {
                    let record = read(&tx, &id)?
                        .ok_or_else(|| invalid("pending app request disappeared"))?;
                    if record.turn_id != current.invocation.turn_id {
                        continue;
                    }
                    if let InteractionRequest::ComputerApp {
                        target, display, ..
                    } = &record.request
                        && instance_key(target, display)? == key
                    {
                        tx.execute(
                            "INSERT INTO interaction_outcomes VALUES(?,?)",
                            rusqlite::params![id, encode(&closure)?],
                        )?;
                    }
                }
                tx.execute(
                    "INSERT INTO computer_app_turn_stops VALUES(?,?,?,?)",
                    rusqlite::params![&session, &current.invocation.turn_id, key, now as i64],
                )?;
                crate::sessions::advance_revision(&tx, &session)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                notice.metadata();
                Ok(true)
            })
            .await
    }
}
