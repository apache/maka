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
    artifacts::{discovery_dir, read_text, write_text},
    *,
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use maka_event_log::{
    StoreError,
    root::RootOwner,
    root_store::{DataChange, DataWriter},
    writeback::{Prepared, Statement},
};
use std::io;
use std::path::Path;

const RULES: &str = "preferences.md";
const OUTCOMES: &str = "outcomes.md";
const MAX_BYTES: usize = 16 * 1024;
const EXCERPT: usize = 1200;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Edit {
    Append,
    Replace,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Update {
    mode: Edit,
    /// Defaults to this thread's topic, or global in the main Bot.
    scope: Option<String>,
    rule: String,
}

fn date() -> jiff::civil::Date {
    jiff::ZonedDateTime::now().date()
}

fn optional(text: io::Result<String>) -> io::Result<String> {
    match text {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        result => result,
    }
}

fn edit_file(state: &RootOwner, name: &str, change: impl FnOnce(&str) -> String) -> io::Result<()> {
    let dir = discovery_dir(state, true)?;
    // Lock a stable sibling; atomic replacement changes the data file's identity.
    let lock = dir
        .open_with(
            ".preferences.lock",
            OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .follow(FollowSymlinks::No),
        )?
        .into_std();
    lock.lock()?;
    let old = optional(read_text(&dir, name, MAX_BYTES))?;
    let new = change(&old);
    if new.len() > MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "discovery preferences exceed 16 KiB",
        ));
    }
    if new != old {
        write_text(&dir, name, &new)?;
    }
    Ok(())
}

impl Update {
    fn apply(self, state: &RootOwner, default_scope: &str) -> io::Result<()> {
        let scope = self.scope.as_deref().unwrap_or(default_scope).trim();
        let rule = self.rule.trim();
        if scope.is_empty()
            || scope == "watch-scope"
            || scope.len() > 160
            || scope.contains(['[', ']'])
            || scope.chars().any(char::is_control)
            || rule.is_empty()
            || rule.len() > 640
            || rule.chars().any(char::is_control)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "provide one concise rule and scope",
            ));
        }
        let prefix = format!("- [{scope}] ");
        let entry = format!("{prefix}{} {rule}", date());
        edit_file(state, RULES, |old| {
            let mut lines: Vec<_> = old
                .lines()
                .filter(|line| {
                    *line != entry
                        && !(matches!(self.mode, Edit::Replace) && line.starts_with(&prefix))
                })
                .collect();
            lines.push(&entry);
            format!("{}\n", lines.join("\n"))
        })
    }
}

pub(super) fn sync_watch_scope(
    state: &RootOwner,
    root: &Path,
    home: bool,
    current: impl FnOnce() -> Arc<watch_scope::WatchScope>,
) -> io::Result<()> {
    edit_file(state, RULES, |old| {
        // Concurrent mirrors can arrive out of order. Read the committed scope under the file lock.
        let scope = current();
        let prefix = format!("- [watch-scope] {} | ", serde_json::json!(root));
        let surveyed = scope
            .surveyed_at
            .and_then(|at| context::timestamp(at.try_into().ok()?))
            .unwrap_or_else(|| "pending".into());
        let baseline = if home {
            "top-level user folders"
        } else {
            "workspace recursively"
        };
        let mut summary = format!("{prefix}{baseline} | survey: {surveyed}");
        let entries = scope
            .include_roots
            .iter()
            .map(|r| ("include", r))
            .chain(scope.exclude_roots.iter().map(|r| ("exclude", r)));
        for (i, (kind, entry)) in entries.enumerate() {
            let relative = entry.path.strip_prefix(root).unwrap_or(&entry.path);
            let item = format!(
                " | {kind} {} ({})",
                serde_json::json!(relative),
                entry.reason
            );
            if summary.len() + item.len() > prefix.len() + 2048 {
                summary.push_str(&format!(
                    " | +{} more (UpdateWatchScope inspect)",
                    scope.include_roots.len() + scope.exclude_roots.len() - i
                ));
                break;
            }
            summary.push_str(&item);
        }
        old.lines()
            .filter(|line| !line.starts_with(&prefix))
            .chain([summary.as_str()])
            .map(|line| format!("{line}\n"))
            .collect()
    })
}

fn outcome(state: &RootOwner, topic: &TopicId, action: &str) -> io::Result<()> {
    let label: String = topic
        .0
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect();
    edit_file(state, OUTCOMES, |old| {
        let mut lines: Vec<_> = old.lines().rev().take(9).collect();
        lines.reverse();
        let entry = format!("- {} [{label}] {action}", date());
        lines.push(&entry);
        format!("{}\n", lines.join("\n"))
    })
}

fn excerpt(dir: &Dir) -> io::Result<String> {
    let rules = optional(read_text(dir, RULES, MAX_BYTES))?;
    let outcomes = optional(read_text(dir, OUTCOMES, MAX_BYTES))?;
    let mut text = String::new();
    for (heading, source, end) in [
        (
            "Discovery preferences",
            rules.as_str(),
            if outcomes.is_empty() {
                EXCERPT
            } else {
                EXCERPT - 300
            },
        ),
        ("Recent user outcomes", outcomes.as_str(), EXCERPT),
    ] {
        let mut lines = source
            .lines()
            .rev()
            .filter(|line| !line.trim().is_empty() && !line.starts_with("- [watch-scope] "))
            .peekable();
        if lines.peek().is_none() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(heading);
        for line in lines {
            let remaining = end.saturating_sub(text.len() + 1);
            if remaining == 0 {
                break;
            }
            text.push('\n');
            text.push_str(&line[..line.floor_char_boundary(line.len().min(remaining))]);
            if line.len() > remaining {
                break;
            }
        }
    }
    Ok(text)
}

impl Owner {
    pub(super) async fn discovery_preferences_excerpt(&self) -> Result<String, String> {
        let root = self.store.owned_root().map_err(reason)?;
        tokio::task::spawn_blocking(move || {
            optional(discovery_dir(&root, false).and_then(|dir| excerpt(&dir)))
        })
        .await
        .map_err(reason)?
        .map_err(reason)
    }

    pub(super) async fn update_discovery_preferences(
        &self,
        context: &ToolCallContext,
        update: Update,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        self.discovery_call_access(context, PREFERENCES).await?;
        let id = &context.execution.session_id;
        let scope = if self.bot.is(id) {
            self.check_bot_invocation(context)
                .await
                .map_err(ToolError::Failed)?;
            "global".into()
        } else {
            self.discovery
                .thread_topic(id.clone())
                .await
                .map_err(dossiers::write_error)?
                .ok_or_else(|| ToolError::Failed("discovery_thread_required".into()))?
                .0
        };
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        let root = self.store.owned_root().map_err(dossiers::write_error)?;
        tokio::task::spawn_blocking(move || update.apply(&root, &scope))
            .await
            .map_err(|e| ToolError::OutcomeUnknown(reason(e)))?
            .map_err(|e| ToolError::Failed(reason(e)))?;
        Ok(serde_json::json!({"updated":true}))
    }

    pub(in crate::owner) async fn record_discovery_outcome(
        &self,
        topic: &TopicId,
        action: &'static str,
    ) {
        let topic = topic.clone();
        let result = async {
            let root = self.store.owned_root().map_err(reason)?;
            tokio::task::spawn_blocking(move || outcome(&root, &topic, action))
                .await
                .map_err(reason)?
                .map_err(reason)
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(%error, "Could not record discovery outcome");
        }
    }
}

struct Observed<S>(S, tokio::sync::oneshot::Sender<()>);

impl<S: Statement> Statement for Observed<S> {
    type Value = (S::Value, tokio::sync::oneshot::Sender<()>);
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.0.retain()
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self(self.0.prepare()?, self.1))
    }
    fn execute(self, c: &rusqlite::Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let state = self.0.execute(c)?;
        Ok(Prepared {
            value: (state.value, self.1),
            changed: state.changed,
            notification: state.notification,
        })
    }
    fn committed((value, signal): Self::Value) -> Self::Output {
        let value = S::committed(value);
        let _ = signal.send(());
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
    }
}

impl Owner {
    pub(in crate::owner) fn observe_discovery_outcome<S: Statement>(
        self: &Arc<Self>,
        writer: &DataWriter,
        state: S,
        topic: TopicId,
        action: &'static str,
    ) -> DataChange {
        writer.prepare(Observed(
            state,
            self.discovery_outcome_signal(topic, action),
        ))
    }
    pub(in crate::owner) fn discovery_outcome_signal(
        self: &Arc<Self>,
        topic: TopicId,
        action: &'static str,
    ) -> tokio::sync::oneshot::Sender<()> {
        let (committed, observed) = tokio::sync::oneshot::channel();
        let owner = self.clone();
        self.workers.spawn(async move {
            if observed.await.is_ok() {
                owner.record_discovery_outcome(&topic, action).await;
            }
        });
        committed
    }

    pub(crate) fn prepare_dossier_mute(
        self: &Arc<Self>,
        input: DossierMute,
    ) -> Result<DataChange, String> {
        let writer = self.store.data_writer().map_err(reason)?;
        let state = self.discovery.mute_statement(
            input.topic_id.clone(),
            input.muted,
            UnixMillis(now() as i64),
        );
        let action = if input.muted {
            "muted the topic"
        } else {
            "unmuted the topic"
        };
        Ok(self.observe_discovery_outcome(&writer, state, input.topic_id, action))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::root::{RootNamespaces, RootOwner};

    #[test]
    fn discovery_preferences_keep_scoped_rules_and_the_last_ten_outcomes_bounded() {
        let base = tempfile::tempdir().unwrap();
        let state = RootOwner::create(
            &base.path().join("state"),
            &RootNamespaces {
                ownership: base.path().join("owners"),
                control: base.path().join("control"),
            },
        )
        .unwrap();
        let save = |mode, scope: &str, rule: &str| {
            Update {
                mode,
                scope: Some(scope.into()),
                rule: rule.into(),
            }
            .apply(&state, "global")
        };
        save(Edit::Append, "global", "Keep existing instructions").unwrap();
        save(Edit::Append, "work", "Tomorrow").unwrap();
        save(Edit::Replace, "work", "周五再提醒").unwrap();
        let dir = discovery_dir(&state, false).unwrap();
        let rules = read_text(&dir, RULES, MAX_BYTES).unwrap();
        assert!(
            !rules.contains("Tomorrow")
                && rules.contains("周五再提醒")
                && rules.contains("Keep existing instructions")
        );
        for n in 0..12 {
            outcome(&state, &TopicId(format!("topic-{n}")), "muted the topic").unwrap();
        }
        let log = read_text(&dir, OUTCOMES, MAX_BYTES).unwrap();
        assert_eq!(log.lines().count(), 10);
        assert!(!log.contains("[topic-1]") && log.contains("[topic-11]"));
        for n in 0..100 {
            let rule = format!("{n} {}", "推".repeat(180));
            if save(Edit::Append, "volume", &rule).is_err() {
                assert!(n < 40);
                let stored = read_text(&dir, RULES, MAX_BYTES).unwrap();
                assert!(!stored.contains(&format!("[volume] {} {rule}", date())));
                let sample = excerpt(&dir).unwrap();
                assert!(sample.len() <= EXCERPT && sample.contains("Recent user outcomes"));
                return;
            }
        }
        panic!("rules exceeded the file size budget");
    }
}
