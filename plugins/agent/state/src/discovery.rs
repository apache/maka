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

//! Owner-scoped discovery state. Dossier writes can share the scheduler's root transaction.
pub use maka_agent_facts::discovery::*;
use maka_agent_facts::durable::{RunOwner, UnixMillis};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::sync::watch;

pub mod changes;
pub mod guards;
#[cfg(test)]
mod tests;
mod tracking;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DossierUpsert {
    pub topic_id: TopicId,
    #[schemars(required, with = "u64")]
    pub expected_revision: Option<u64>,
    pub title: String,
    pub signal: DossierSignal,
    pub priority_weight: f64,
    pub window_at: Option<UnixMillis>,
    pub summary_md: String,
    #[serde(default)]
    pub change_note: Option<String>,
    #[serde(default)]
    pub choices: Vec<DossierChoice>,
    #[serde(default)]
    pub artifacts: Vec<StagedArtifact>,
    /// Omission preserves existing bindings. An empty list explicitly unlinks them.
    pub linked_task_ids: Option<Vec<String>>,
}

/// Receipt returned by StageArtifact and accepted verbatim by the worker tool.
#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StagedArtifact {
    pub path: String,
    pub sha256: String,
    pub purpose: String,
    #[serde(default)]
    pub input_hashes: std::collections::BTreeMap<String, String>,
}

impl From<StagedArtifact> for DossierArtifact {
    fn from(value: StagedArtifact) -> Self {
        Self {
            path: value.path,
            purpose: value.purpose,
            sha256: Some(value.sha256),
            input_hashes: value.input_hashes,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DossierUpsertOutcome {
    pub topic_id: TopicId,
    pub revision: u64,
    pub material_change: bool,
    pub notified: bool,
}

#[derive(Clone)]
pub struct DiscoveryStore {
    data: DataWriter,
    owner: String,
    changed: watch::Sender<Option<DiscoveryInterrupt>>,
}

struct Read<F>(String, F);
impl<F, T> Query for Read<F>
where
    F: FnOnce(&Connection, &str) -> Result<T, StoreError> + Send + 'static,
    T: Send + 'static,
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        (self.1)(c, &self.0)
    }
}

#[derive(Serialize)]
#[serde(transparent)]
pub struct DiscoveryCommit<T> {
    pub result: T,
    #[serde(skip)]
    notice: Option<(
        watch::Sender<Option<DiscoveryInterrupt>>,
        Option<DiscoveryInterrupt>,
    )>,
}
impl<T> DiscoveryCommit<T> {
    pub fn publish(self) -> T {
        if let Some((changes, event)) = self.notice {
            changes.send_modify(|latest| {
                if event.is_some() {
                    *latest = event
                }
            });
        }
        self.result
    }
}

struct Write<F> {
    owner: String,
    changes: Option<watch::Sender<Option<DiscoveryInterrupt>>>,
    write: F,
}
impl<F, T> Statement for Write<F>
where
    F: FnOnce(&Connection, &str) -> Result<(T, Option<DiscoveryInterrupt>), StoreError>
        + Send
        + 'static,
    T: Send + 'static,
{
    type Value = DiscoveryCommit<T>;
    type Output = T;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let before = c.total_changes();
        let (result, event) = (self.write)(c, &self.owner)?;
        let changed = before != c.total_changes();
        Ok(Prepared {
            value: DiscoveryCommit {
                result,
                notice: self.changes.filter(|_| changed).map(|tx| (tx, event)),
            },
            changed,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> T {
        value.publish()
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error.underlying(),
            StoreError::RevisionConflict { .. } | StoreError::InvalidTransition(_)
        ) || matches!(error.underlying(), StoreError::Sqlite(e) if e.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation))
    }
}

impl DiscoveryStore {
    pub fn new(data: DataWriter, owner: &RunOwner) -> Result<Self, StoreError> {
        Ok(Self {
            data,
            owner: serde_json::to_string(owner)?,
            changed: watch::channel(None).0,
        })
    }
    pub fn subscribe(&self) -> watch::Receiver<Option<DiscoveryInterrupt>> {
        self.changed.subscribe()
    }
    async fn read<T: Send + 'static>(
        &self,
        read: impl FnOnce(&Connection, &str) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data.query(Read(self.owner.clone(), read)).await
    }
    fn mutation<T: Send + 'static, F>(
        &self,
        visible: bool,
        write: F,
    ) -> impl Statement<Value = DiscoveryCommit<T>, Output = T> + use<T, F>
    where
        F: FnOnce(&Connection, &str) -> Result<T, StoreError> + Send + 'static,
    {
        Write {
            owner: self.owner.clone(),
            changes: visible.then(|| self.changed.clone()),
            write: move |c: &Connection, owner: &str| Ok((write(c, owner)?, None)),
        }
    }

    pub fn upsert_statement(
        &self,
        input: DossierUpsert,
        reason: Option<String>,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<DossierUpsertOutcome>, Output = DossierUpsertOutcome>
    + use<> {
        Write {
            owner: self.owner.clone(),
            changes: Some(self.changed.clone()),
            write: move |c: &Connection, owner: &str| {
                let mut outcome = upsert(c, owner, input, at)?;
                let event = match reason {
                    Some(reason) => {
                        notify(c, owner, &outcome.topic_id, outcome.revision, reason, at)?
                    }
                    None => None,
                };
                outcome.notified = event.is_some();
                Ok((outcome, event))
            },
        }
    }
    pub async fn upsert_dossier(
        &self,
        input: DossierUpsert,
        at: UnixMillis,
    ) -> Result<DossierUpsertOutcome, StoreError> {
        self.data
            .write(self.upsert_statement(input, None, at))
            .await
    }
    pub async fn list_dossiers(&self) -> Result<Vec<DossierSummary>, StoreError> {
        self.read(list).await
    }
    pub async fn latest_interrupt(&self) -> Result<Option<DiscoveryInterrupt>, StoreError> {
        self.read(|c, owner| {
            Ok(c.query_row(
                "SELECT topic_id,last_notified_revision,last_interrupt_reason,last_interrupt_at
             FROM discovery_dossiers WHERE owner=?1 AND last_interrupt_at IS NOT NULL
             ORDER BY last_interrupt_at DESC,topic_id LIMIT 1",
                [owner],
                |row| {
                    Ok(DiscoveryInterrupt {
                        topic_id: TopicId(row.get(0)?),
                        revision: unsigned(row, 1)?,
                        reason: row.get(2)?,
                        at: UnixMillis(row.get(3)?),
                    })
                },
            )
            .optional()?)
        })
        .await
    }
    pub async fn dossiers(&self) -> Result<Dossiers, StoreError> {
        self.read(|c, owner| {
            Ok(Dossiers {
                dossiers: list(c, owner)?,
                notifications_enabled: enabled(c, owner)?,
            })
        })
        .await
    }
    pub fn linked_tasks_in_transaction(
        &self,
        c: &Connection,
        topic: &TopicId,
    ) -> Result<Vec<String>, StoreError> {
        Ok(c.query_row(
            "SELECT linked_task_ids_json FROM discovery_dossiers WHERE owner=?1 AND topic_id=?2",
            params![self.owner, topic.0],
            |r| json(r, 0),
        )
        .optional()?
        .unwrap_or_default())
    }
    pub async fn get_dossier(&self, topic: TopicId) -> Result<Option<DossierRecord>, StoreError> {
        self.read(move |c, owner| get(c, owner, &topic)).await
    }
    pub async fn artifact(
        &self,
        topic: TopicId,
        path: String,
    ) -> Result<Option<DossierArtifact>, StoreError> {
        self.read(move |c, owner| {
            Ok(c.query_row(
                "SELECT a.value FROM discovery_dossiers d, json_each(d.artifacts_json) a
            WHERE d.owner=?1 AND d.topic_id=?2 AND a.value->>'$.path'=?3 LIMIT 1",
                params![owner, topic.0, path],
                |r| json(r, 0),
            )
            .optional()?)
        })
        .await
    }

    pub async fn attach_thread_artifact(
        &self,
        session: String,
        topic: TopicId,
        artifact: StagedArtifact,
        at: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data.write(self.mutation(true, move |c, owner| {
            let mut artifacts: Vec<DossierArtifact> = c.query_row(
                "SELECT artifacts_json FROM discovery_dossiers WHERE owner=?1 AND topic_id=?2 AND thread_session_id=?3",
                params![owner, topic.0, session], |r| json(r, 0),
            )?;
            let artifact = DossierArtifact::from(artifact);
            if let Some(previous) = artifacts.iter_mut().find(|a| a.path == artifact.path) {
                if *previous == artifact { return Ok(()); }
                *previous = artifact;
            } else {
                artifacts.push(artifact);
            }
            c.execute("UPDATE discovery_dossiers SET artifacts_json=?3, revision=revision+1,
                last_material_change_at=max(last_material_change_at,?4), updated_at=max(updated_at,?4)
                WHERE owner=?1 AND topic_id=?2", params![owner, topic.0, serde_json::to_string(&artifacts)?, at.0])?;
            Ok(())
        })).await
    }
    pub async fn thread_topic(&self, session: String) -> Result<Option<TopicId>, StoreError> {
        self.read(move |c, owner| {
            Ok(c.query_row(
                "SELECT topic_id FROM discovery_dossiers WHERE thread_session_id=?1 AND owner=?2",
                params![session, owner],
                |r| Ok(TopicId(r.get(0)?)),
            )
            .optional()?)
        })
        .await
    }
    pub async fn detail(&self, topic: TopicId) -> Result<Option<DossierDetail>, StoreError> {
        self.read(move |c, owner| {
            get(c, owner, &topic)?
                .map(|dossier| {
                    let mut revisions = read_revisions(c, owner, &topic)?;
                    if revisions.is_empty() {
                        revisions.push(synthesize_revision(&dossier));
                    }
                    Ok(DossierDetail {
                        watches: tracking::watches(c, owner, &topic)?,
                        pending_actions: tracking::actions(c, owner, &topic, true)?,
                        revisions,
                        dossier,
                    })
                })
                .transpose()
        })
        .await
    }
    pub fn touch_statement(
        &self,
        topics: Vec<TopicId>,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(true, move |c, owner| {
            let mut stmt = c.prepare_cached(TOUCH)?;
            for topic in topics {
                require_dossier(stmt.execute(params![owner, topic.0, at.0])?)?;
            }
            Ok(())
        })
    }
    pub async fn touch_dossier_checked(
        &self,
        topic: TopicId,
        at: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data.write(self.touch_statement(vec![topic], at)).await
    }
    pub fn mute_statement(
        &self,
        topic: TopicId,
        muted: bool,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(true,move |c,owner| require_dossier(c.execute("UPDATE discovery_dossiers SET muted=?3, updated_at=max(updated_at,?4) WHERE owner=?1 AND topic_id=?2",params![owner,topic.0,muted,at.0])?))
    }
    pub async fn set_dossier_muted(
        &self,
        topic: TopicId,
        muted: bool,
        at: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data.write(self.mute_statement(topic, muted, at)).await
    }
    pub fn resolve_statement(
        &self,
        topic: TopicId,
        resolved: bool,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        let signal = if resolved {
            DossierSignal::Done
        } else {
            DossierSignal::Yellow
        };
        self.mutation(true, move |c, owner| {
            require_dossier(c.execute(
                "UPDATE discovery_dossiers SET signal=?3, updated_at=max(updated_at,?4) WHERE owner=?1 AND topic_id=?2",
                params![owner, topic.0, signal.as_str(), at.0],
            )?)
        })
    }
    pub fn choose_statement(
        &self,
        topic: TopicId,
        revision: u64,
        key: String,
        resolve: bool,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(true, move |c, owner| {
            let trimmed = key.trim();
            if trimmed.is_empty() || trimmed.len() > 16 || trimmed.chars().any(char::is_control) {
                return Err(crate::store::invalid("invalid dossier choice key"));
            }
            let Some(dossier) = get(c, owner, &topic)? else {
                return Err(crate::store::invalid("unknown discovery topic"));
            };
            let mut revisions = read_revisions(c, owner, &topic)?;
            if revisions.is_empty() {
                revisions.push(synthesize_revision(&dossier));
            }
            if let Some(entry) = revisions.iter_mut().find(|r| r.revision == revision) {
                entry.chosen_key = Some(trimmed.to_owned());
            } else if let Some(last) = revisions.last_mut() {
                last.chosen_key = Some(trimmed.to_owned());
            }
            write_revisions(c, owner, &topic, &revisions)?;
            if resolve {
                c.execute(
                    "UPDATE discovery_dossiers SET signal=?3, updated_at=max(updated_at,?4) WHERE owner=?1 AND topic_id=?2",
                    params![owner, topic.0, DossierSignal::Done.as_str(), at.0],
                )?;
            } else {
                c.execute(
                    "UPDATE discovery_dossiers SET updated_at=max(updated_at,?3) WHERE owner=?1 AND topic_id=?2",
                    params![owner, topic.0, at.0],
                )?;
            }
            Ok(())
        })
    }
    pub fn thread_at_revision(
        &self,
        c: &Connection,
        topic: &TopicId,
        expected: u64,
    ) -> Result<Option<String>, StoreError> {
        let (session,revision):(Option<String>,u64)=c.query_row("SELECT thread_session_id,revision FROM discovery_dossiers WHERE owner=?1 AND topic_id=?2",
            params![self.owner,topic.0],|r|Ok((r.get(0)?,unsigned(r,1)?)))?;
        if session.is_none() && expected != revision {
            return Err(StoreError::RevisionConflict {
                expected: expected.to_string(),
                actual: revision.to_string(),
            });
        }
        Ok(session)
    }
    pub fn bind_thread_statement(
        &self,
        topic: TopicId,
        session: String,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<String>, Output = String> + use<> {
        self.mutation(true,move |c,owner| {
            c.execute("UPDATE discovery_dossiers SET thread_session_id=?3, updated_at=max(updated_at,?4) WHERE owner=?1 AND topic_id=?2 AND thread_session_id IS NULL", params![owner,topic.0,session,at.0])?;
            Ok(c.query_row("SELECT thread_session_id FROM discovery_dossiers WHERE owner=?1 AND topic_id=?2",params![owner,topic.0], |r|r.get(0))?)
        })
    }
    pub async fn bind_dossier_thread_session(
        &self,
        topic: TopicId,
        session: String,
        at: UnixMillis,
    ) -> Result<String, StoreError> {
        self.data
            .write(self.bind_thread_statement(topic, session, at))
            .await
    }
    pub async fn record_dossier_notified(
        &self,
        topic: TopicId,
        revision: u64,
        reason: String,
        at: UnixMillis,
    ) -> Result<bool, StoreError> {
        self.data
            .write(Write {
                owner: self.owner.clone(),
                changes: Some(self.changed.clone()),
                write: move |c: &Connection, owner: &str| {
                    let event = notify(c, owner, &topic, revision, reason, at)?;
                    Ok((event.is_some(), event))
                },
            })
            .await
    }
    pub async fn discovery_notifications_enabled(&self) -> Result<bool, StoreError> {
        self.read(enabled).await
    }
    pub fn preferences_statement(
        &self,
        enabled: bool,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(true,move |c,owner| {
            c.execute("INSERT INTO discovery_preferences(owner,notifications_enabled,updated_at) VALUES (?1,?2,?3)
                ON CONFLICT(owner) DO UPDATE SET notifications_enabled=excluded.notifications_enabled, updated_at=max(updated_at,excluded.updated_at)",
                params![owner,enabled,at.0])?;
            Ok(())
        })
    }
    pub async fn set_discovery_notifications_enabled(
        &self,
        enabled: bool,
        at: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data
            .write(self.preferences_statement(enabled, at))
            .await
    }
}

const TOUCH: &str = "UPDATE discovery_dossiers SET last_checked_at=max(last_checked_at,?3),
    updated_at=max(updated_at,?3) WHERE owner=?1 AND topic_id=?2";

fn require_dossier(rows: usize) -> Result<(), StoreError> {
    if rows == 0 {
        Err(crate::store::invalid("discovery_topic_missing"))
    } else {
        Ok(())
    }
}
fn enabled(c: &Connection, owner: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT notifications_enabled FROM discovery_preferences WHERE owner=?1",
        [owner],
        |r| r.get(0),
    )
    .optional()?
    .unwrap_or(true))
}

fn notify(
    c: &Connection,
    owner: &str,
    topic: &TopicId,
    revision: u64,
    reason: String,
    at: UnixMillis,
) -> Result<Option<DiscoveryInterrupt>, StoreError> {
    if reason.trim().is_empty() {
        return Err(crate::store::invalid("interrupt reason is required"));
    }
    let changed=c.execute("UPDATE discovery_dossiers SET last_notified_revision=?3,last_interrupt_reason=?4,last_interrupt_at=?5,updated_at=max(updated_at,?5)
        WHERE owner=?1 AND topic_id=?2 AND revision=?3 AND last_notified_revision<?3 AND muted=0
        AND NOT EXISTS (SELECT 1 FROM discovery_preferences WHERE owner=?1 AND notifications_enabled=0)",
        params![owner,topic.0,sql_revision(revision)?,reason,at.0])?;
    Ok((changed != 0).then(|| DiscoveryInterrupt {
        topic_id: topic.clone(),
        revision,
        reason,
        at,
    }))
}

fn json<T: DeserializeOwned>(r: &Row<'_>, col: usize) -> rusqlite::Result<T> {
    serde_json::from_slice(r.get_ref(col)?.as_bytes()?).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(col, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn vocabulary<T: DeserializeOwned>(r: &Row<'_>, col: usize) -> rusqlite::Result<T> {
    T::deserialize(
        serde::de::value::StrDeserializer::<serde::de::value::Error>::new(
            r.get_ref(col)?.as_str()?,
        ),
    )
    .map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(col, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn unsigned(r: &Row<'_>, col: usize) -> rusqlite::Result<u64> {
    let value: i64 = r.get(col)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(col, value))
}
fn sql_revision(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| crate::store::invalid("discovery revision out of range"))
}
fn optional_time(r: &Row<'_>, col: usize) -> rusqlite::Result<Option<UnixMillis>> {
    Ok(r.get::<_, Option<i64>>(col)?.map(UnixMillis))
}
fn get(c: &Connection, owner: &str, topic: &TopicId) -> Result<Option<DossierRecord>, StoreError> {
    Ok(c.query_row(
        "SELECT topic_id, title, signal, priority_weight, window_at, revision, summary_md,
                artifacts_json, linked_task_ids_json, thread_session_id, muted, last_checked_at,
                last_material_change_at, last_notified_revision, last_interrupt_reason,
                last_interrupt_at, created_at, updated_at
         FROM discovery_dossiers WHERE owner=?1 AND topic_id=?2",
        params![owner, topic.0],
        |row| {
            Ok(DossierRecord {
                topic_id: TopicId(row.get(0)?),
                title: row.get(1)?,
                signal: vocabulary(row, 2)?,
                priority_weight: row.get(3)?,
                window_at: optional_time(row, 4)?,
                revision: unsigned(row, 5)?,
                summary_md: row.get(6)?,
                artifacts: json(row, 7)?,
                linked_task_ids: json(row, 8)?,
                thread_session_id: row.get(9)?,
                muted: row.get(10)?,
                last_checked_at: UnixMillis(row.get(11)?),
                last_material_change_at: UnixMillis(row.get(12)?),
                last_notified_revision: unsigned(row, 13)?,
                last_interrupt_reason: row.get(14)?,
                last_interrupt_at: optional_time(row, 15)?,
                created_at: UnixMillis(row.get(16)?),
                updated_at: UnixMillis(row.get(17)?),
            })
        },
    )
    .optional()?)
}
fn list(c: &Connection, owner: &str) -> Result<Vec<DossierSummary>, StoreError> {
    // Each signal is an ordered range of the priority index, including its topic-id tie breaker.
    let mut stmt=c.prepare_cached("SELECT topic_id,title,window_at,revision,last_material_change_at,muted,json_array_length(artifacts_json),
               last_notified_revision,last_interrupt_reason,last_interrupt_at
        FROM discovery_dossiers WHERE owner=?1 AND signal=?2 ORDER BY priority_weight DESC,last_material_change_at DESC,topic_id")?;
    let mut result = Vec::new();
    for signal in [
        DossierSignal::Red,
        DossierSignal::Yellow,
        DossierSignal::Green,
        DossierSignal::Done,
    ] {
        let rows = stmt.query_map(params![owner, signal.as_str()], |r| {
            Ok(DossierSummary {
                topic_id: TopicId(r.get(0)?),
                title: r.get(1)?,
                signal,
                window_at: optional_time(r, 2)?,
                revision: unsigned(r, 3)?,
                last_material_change_at: UnixMillis(r.get(4)?),
                muted: r.get(5)?,
                artifact_count: unsigned(r, 6)?,
                last_notified_revision: unsigned(r, 7)?,
                last_interrupt_reason: r.get(8)?,
                last_interrupt_at: optional_time(r, 9)?,
            })
        })?;
        for row in rows {
            result.push(row?);
        }
    }
    Ok(result)
}

const REVISION_PACKAGE: &str = "maka.agent.discovery";
const MAX_REVISIONS: usize = 20;

fn revision_key(topic: &TopicId) -> String {
    format!("revisions:{}", topic.0)
}

fn synthesize_revision(dossier: &DossierRecord) -> DossierRevision {
    DossierRevision {
        revision: dossier.revision,
        at: dossier.last_material_change_at,
        title: dossier.title.clone(),
        signal: dossier.signal,
        summary_md: dossier.summary_md.clone(),
        change_note: None,
        artifacts: dossier.artifacts.clone(),
        choices: vec![],
        chosen_key: None,
    }
}

fn read_revisions(
    c: &Connection,
    owner: &str,
    topic: &TopicId,
) -> Result<Vec<DossierRevision>, StoreError> {
    let raw: Option<Option<String>> = c
        .query_row(
            "SELECT value_json FROM plugin_data WHERE package_id=?1 AND scope_id=?2 AND key=?3",
            params![REVISION_PACKAGE, owner, revision_key(topic)],
            |row| row.get(0),
        )
        .optional()?;
    match raw.flatten() {
        Some(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        None => Ok(Vec::new()),
    }
}

fn write_revisions(
    c: &Connection,
    owner: &str,
    topic: &TopicId,
    revisions: &[DossierRevision],
) -> Result<(), StoreError> {
    let start = revisions.len().saturating_sub(MAX_REVISIONS);
    let encoded = serde_json::to_string(&revisions[start..])?;
    c.execute(
        "INSERT INTO plugin_data(package_id, scope_id, key, revision, value_json)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(package_id, scope_id, key) DO UPDATE SET
             revision = revision + 1,
             value_json = excluded.value_json",
        params![REVISION_PACKAGE, owner, revision_key(topic), encoded],
    )?;
    Ok(())
}

fn sanitize_choices(choices: Vec<DossierChoice>) -> Vec<DossierChoice> {
    choices
        .into_iter()
        .filter(|c| {
            !c.key.trim().is_empty()
                && !c.label.trim().is_empty()
                && !c.instruction.trim().is_empty()
        })
        .take(4)
        .map(|mut c| {
            c.key = c.key.trim().chars().take(16).collect();
            c.label = c.label.trim().to_owned();
            c.detail = c.detail.trim().to_owned();
            c.instruction = c.instruction.trim().to_owned();
            c
        })
        .collect()
}

fn upsert(
    c: &Connection,
    owner: &str,
    input: DossierUpsert,
    at: UnixMillis,
) -> Result<DossierUpsertOutcome, StoreError> {
    if input.topic_id.0.trim().is_empty()
        || input.title.trim().is_empty()
        || input.title.chars().any(char::is_control)
        || input.summary_md.trim().is_empty()
        || !input.priority_weight.is_finite()
    {
        return Err(crate::store::invalid("invalid discovery dossier"));
    }
    let artifact_list: Vec<_> = input
        .artifacts
        .into_iter()
        .map(DossierArtifact::from)
        .collect();
    let artifacts = serde_json::to_string(&artifact_list)?;
    let choices = sanitize_choices(input.choices);
    let change_note = input
        .change_note
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let links = input
        .linked_task_ids
        .map(|mut ids| {
            ids.sort_unstable();
            ids.dedup();
            serde_json::to_string(&ids)
        })
        .transpose()?;
    let window = input.window_at.map(|t| t.0);
    let args = params![
        owner,
        input.topic_id.0,
        input.title,
        input.signal.as_str(),
        input.priority_weight,
        window,
        input.summary_md,
        artifacts,
        links,
    ];
    let old = c
        .query_row(
            "SELECT revision,
                title != ?3 OR signal != ?4 OR window_at IS NOT ?6 OR summary_md != ?7
                  OR artifacts_json != ?8 OR (?9 IS NOT NULL AND linked_task_ids_json != ?9),
                priority_weight != ?5
         FROM discovery_dossiers WHERE owner=?1 AND topic_id=?2",
            args,
            |row| {
                Ok((
                    unsigned(row, 0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?;
    let (previous, mut changed, reweighted) = old.unwrap_or((0, true, false));
    if let Some(expected) = input.expected_revision
        && expected != previous
    {
        return Err(StoreError::RevisionConflict {
            expected: expected.to_string(),
            actual: previous.to_string(),
        });
    }
    let mut existing_revisions = read_revisions(c, owner, &input.topic_id)?;
    let choices_changed =
        !choices.is_empty() && existing_revisions.last().map(|r| &r.choices) != Some(&choices);
    if choices_changed {
        changed = true;
    }
    let previous_record = if changed && previous > 0 && existing_revisions.is_empty() {
        get(c, owner, &input.topic_id)?
    } else {
        None
    };
    let revision = previous + u64::from(changed);
    if changed {
        c.execute(
            "INSERT INTO discovery_dossiers(
                 owner, topic_id, title, signal, priority_weight, window_at, summary_md, artifacts_json,
                 linked_task_ids_json, revision, last_checked_at, last_material_change_at, created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,coalesce(?9,'[]'),?10,?11,?11,?11,?11)
             ON CONFLICT(owner,topic_id) DO UPDATE SET
                 title=excluded.title, signal=excluded.signal, priority_weight=excluded.priority_weight,
                 window_at=excluded.window_at, summary_md=excluded.summary_md, artifacts_json=excluded.artifacts_json,
                 linked_task_ids_json=coalesce(?9,linked_task_ids_json), revision=excluded.revision,
                 last_checked_at=max(last_checked_at,?11), last_material_change_at=max(last_material_change_at,?11),
                 updated_at=max(updated_at,?11)",
            params![owner, input.topic_id.0, input.title, input.signal.as_str(), input.priority_weight,
                    window, input.summary_md, artifacts, links, sql_revision(revision)?, at.0],
        )?;
        if let Some(prev) = previous_record {
            existing_revisions.push(synthesize_revision(&prev));
        }
        existing_revisions.push(DossierRevision {
            revision,
            at,
            title: input.title,
            signal: input.signal,
            summary_md: input.summary_md,
            change_note,
            artifacts: artifact_list,
            choices,
            chosen_key: None,
        });
        write_revisions(c, owner, &input.topic_id, &existing_revisions)?;
    } else if reweighted {
        c.execute(
            "UPDATE discovery_dossiers SET priority_weight=?3, last_checked_at=max(last_checked_at,?4),
                    updated_at=max(updated_at,?4) WHERE owner=?1 AND topic_id=?2",
            params![owner, input.topic_id.0, input.priority_weight, at.0],
        )?;
    } else {
        c.execute(TOUCH, params![owner, input.topic_id.0, at.0])?;
    }
    Ok(DossierUpsertOutcome {
        topic_id: input.topic_id,
        revision,
        material_change: changed,
        notified: false,
    })
}
