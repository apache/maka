/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
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

use super::sessions::{SESSION_QUIET_MS, SessionDelta, recent_conversations};
use super::*;
use jiff::{Timestamp, tz::TimeZone};
use maka_agent_state::discovery::changes::{
    ChangeQuery, ChangeSnapshot, Delta, IndexedDossier, OpeningSources,
};
use maka_agent_state::session_catalog::SessionCatalog;
use std::path::Path;

pub(super) fn timestamp(ms: u64) -> Option<String> {
    Timestamp::from_millisecond(i64::try_from(ms).ok()?)
        .ok()
        .map(|time| time.to_string())
}

pub(super) fn local_timestamp(ms: u64, timezone: &str) -> Option<String> {
    let time = Timestamp::from_millisecond(i64::try_from(ms).ok()?).ok()?;
    let zone = TimeZone::get(timezone).ok()?;
    Some(
        time.to_zoned_datetime(zone)
            .strftime("%FT%T%:z")
            .to_string(),
    )
}

pub(super) fn environment(language: Language, workspace: &str, timezone: &str) -> String {
    let at = now();
    let time = local_timestamp(at, timezone)
        .or_else(|| timestamp(at))
        .unwrap_or_default();
    match language {
        Language::ZH_CN => format!("\n\n当前时间：{time}。工作区：{workspace}"),
        Language::ZH_TW => format!("\n\n目前時間：{time}。工作區：{workspace}"),
        _ => format!("\n\nCurrent time: {time}. Workspace: {workspace}"),
    }
}

// Session rows can use spare bytes, but the original file and dossier budget has priority.
const FILE_HEADER_BYTES: usize = 1600;
const HEADER_BYTES: usize = 2000;
const ROW_LIMIT: usize = 15;

async fn recent_conversation_topics(
    catalog: SessionCatalog,
    bot: &bot::Bot,
) -> Result<Vec<String>, String> {
    let mut topics = Vec::new();
    for (record, title) in recent_conversations(catalog).await? {
        let title = title.trim();
        if !title.is_empty() && !bot.is_or_was(&record.metadata.id).await? {
            topics.push(clipped(title, 72, false));
            if topics.len() == 5 {
                break;
            }
        }
    }
    Ok(topics)
}

impl Owner {
    async fn mapped_context(
        &self,
        language: Language,
        tools: &[String],
    ) -> Result<Vec<String>, String> {
        let mut sections = Vec::new();
        let preferences = self.discovery_preferences_excerpt().await?;
        if !preferences.is_empty() {
            sections.push(preferences);
        }
        if !self.discovery_reads_sessions(tools) {
            return Ok(sections);
        }
        let topics = recent_conversation_topics(
            self.canonical_catalog()?
                .with_cancellation(self.stop.clone()),
            &self.bot,
        )
        .await?;
        if !topics.is_empty() {
            let heading = match language {
                Language::ZH_CN => "近期对话主题（可静默留意相关兴趣）",
                Language::ZH_TW => "近期對話主題（可靜默留意相關興趣）",
                _ => "Recent conversation topics (quiet interest signal)",
            };
            sections.push(format!("{heading}\n{}", serde_json::json!(topics)));
        }
        Ok(sections)
    }

    pub(super) async fn discovery_opening(
        &self,
        mode: &DiscoveryMode,
        job: &Job,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        tools: &[String],
        at: UnixMillis,
    ) -> Result<(String, OpeningSources), String> {
        if fire.source == FireSource::Watch
            || fire
                .authorization
                .as_ref()
                .and_then(scheduler::Approval::followup_grant)
                .is_some()
        {
            // The frozen intent names one topic. Broad deltas keep their own opening.
            return Ok((
                self.discovery_preferences_excerpt().await?,
                OpeningSources::None,
            ));
        }
        let root = Path::new(&job.approval.target.workspace.path);
        let (_, workspace_map) = self.scheduler.workspace_map(root).await?;

        if matches!(mode, DiscoveryMode::Onboard) {
            let mut sections = Vec::new();
            let selected = &job.approval.target.workspace;
            if let Some(policy) = self.mapped_read_policy(&job.approval).await? {
                let dir = workspace::open_workspace(
                    &self.workspace_roots,
                    selected,
                    &self.managed_worktrees,
                )
                .await?;
                let root = root.to_owned();
                let inventory = tokio::task::spawn_blocking(move || {
                    workspace_map::onboard_inventory(&root, &dir, &policy)
                })
                .await
                .map_err(reason)?
                .map_err(reason)?;
                sections.push(inventory);
            }
            let checkpoint = workspace_map.compact_checkpoint(root);
            if !checkpoint.is_empty() {
                sections.push(checkpoint);
            }
            sections.extend(self.mapped_context(job.approval.language, tools).await?);
            return Ok((sections.join("\n\n"), OpeningSources::None));
        }

        if let DiscoveryMode::Wander { sources } = mode {
            let selected = if self.discovery_reads_files(tools) {
                sources.clone()
            } else {
                Vec::new()
            };
            let displayed: Vec<_> = selected
                .iter()
                .map(|p| {
                    let path = Path::new(p);
                    let rel = roots::host_path(path)
                        .expect("UTF-8 source")
                        .strip_prefix(root)
                        .expect("authorized source");
                    let rel_str = clipped(&rel.to_string_lossy(), 300, true);
                    if let Some(branch) = workspace_map.frontier.iter().find(|b| b.path == path) {
                        format!(
                            "{rel_str} [frontier: {}]",
                            clipped(&branch.reason, 80, false)
                        )
                    } else if let Some(src) = workspace_map.deepest_source_for(path) {
                        let hint = if src.recheck_hint.is_empty() {
                            &src.summary
                        } else {
                            &src.recheck_hint
                        };
                        format!("{rel_str} [{}]", clipped(hint, 80, false))
                    } else {
                        rel_str
                    }
                })
                .collect();
            let label = match job.approval.language {
                Language::ZH_CN => "冷门探索起点",
                Language::ZH_TW => "冷門探索起點",
                _ => "Cold starting points",
            };
            let mut sections = vec![format!("{label}\n{}", serde_json::json!(displayed))];
            sections.extend(self.mapped_context(job.approval.language, tools).await?);
            return Ok((sections.join("\n\n"), OpeningSources::Wander(selected)));
        }

        let changes = if self.discovery_reads_files(tools) {
            self.discovery_changes(
                &job.approval,
                at,
                ChangeQuery::Opening {
                    limit: ROW_LIMIT,
                    workspace: root.to_owned(),
                    projects: workspace_map
                        .sources
                        .iter()
                        .map(|src| src.path.clone())
                        .collect(),
                },
            )
            .await?
        } else {
            ChangeSnapshot::default()
        };
        let dossiers = if (fire.source == FireSource::Manual
            || matches!(mode, DiscoveryMode::Briefing))
            && tools.iter().any(|t| matches!(t.as_str(), LIST | READ))
        {
            self.discovery
                .active_dossier_index(ROW_LIMIT as u32)
                .await
                .map_err(reason)?
        } else {
            Vec::new()
        };
        let sessions = if self.discovery_reads_sessions(tools) {
            let quiet = if fire.source == FireSource::Manual {
                0
            } else {
                SESSION_QUIET_MS
            };
            self.discovery_session_deltas(at, quiet).await?
        } else {
            Vec::new()
        };
        let OpeningHeader {
            mut prompt,
            files: displayed_rows,
            sessions,
        } = header(job.approval.language, root, changes, &dossiers, sessions);
        // Annotate matched mapped sources for the displayed deltas so FollowUp can follow recheck_hint.
        if !displayed_rows.is_empty() && !workspace_map.sources.is_empty() {
            let mut hints = Vec::new();
            let mut seen = BTreeSet::new();
            for delta in displayed_rows.iter().filter_map(|members| members.first()) {
                if let Some(src) = workspace_map.deepest_source_for(Path::new(&delta.path))
                    && seen.insert(src.path.clone())
                {
                    let rel = src.path.strip_prefix(root).unwrap_or(&src.path);
                    let note = if src.recheck_hint.is_empty() {
                        &src.summary
                    } else {
                        &src.recheck_hint
                    };
                    hints.push(format!(
                        "- {}: {}",
                        rel.to_string_lossy(),
                        clipped(note, 100, false)
                    ));
                }
            }
            if !hints.is_empty() {
                prompt.push_str("\n\nMatched map hints:\n");
                prompt.push_str(&hints.join("\n"));
            }
        }
        let excerpt = self.discovery_preferences_excerpt().await?;
        if !excerpt.is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(&excerpt);
        }
        Ok((
            prompt,
            OpeningSources::FollowUp {
                files: displayed_rows.into_iter().flatten().collect(),
                sessions,
            },
        ))
    }
}

struct OpeningHeader {
    prompt: String,
    files: Vec<Vec<Delta>>,
    sessions: Vec<(String, UnixMillis)>,
}

fn header(
    language: Language,
    workspace: &Path,
    changes: ChangeSnapshot,
    dossiers: &[IndexedDossier],
    sessions: Vec<SessionDelta>,
) -> OpeningHeader {
    let (mut prompt, files) = file_header(language, workspace, changes, dossiers);
    let label = "\nSessions [kind,session_id,title,ms]";
    let hint = match language {
        Language::ZH_CN => "\n有新对话的会话可按需用 SessionRead 查阅。",
        Language::ZH_TW => "\n有新對話的會話可按需用 SessionRead 查閱。",
        _ => "\nInspect updated sessions with SessionRead as needed.",
    };
    let mut displayed = Vec::new();
    let mut remaining = HEADER_BYTES - prompt.len() - label.len() - hint.len();
    for session in sessions {
        let row = serde_json::json!([
            session.kind,
            session.id,
            clipped(&session.title, 72, false),
            session.activity_at
        ])
        .to_string();
        if row.len() < remaining {
            if displayed.is_empty() {
                prompt.push_str(label);
            }
            prompt.push('\n');
            prompt.push_str(&row);
            remaining -= row.len() + 1;
            displayed.push((session.id, session.activity_at));
        }
    }
    if !displayed.is_empty() {
        prompt.push_str(hint);
    }
    OpeningHeader {
        prompt,
        files,
        sessions: displayed,
    }
}

fn file_header(
    language: Language,
    workspace: &Path,
    changes: ChangeSnapshot,
    dossiers: &[IndexedDossier],
) -> (String, Vec<Vec<Delta>>) {
    let delta_count = changes
        .groups
        .iter()
        .map(|g| g.members.len())
        .sum::<usize>()
        + changes.omitted_deltas;
    let guidance = match language {
        Language::ZH_CN => "避开正在编辑的目录。可核查周边约束，或静默结束。",
        Language::ZH_TW => "避開正在編輯的目錄。可核查周邊限制，或靜默結束。",
        _ => "Skip active edits. Check related constraints or finish quietly.",
    };
    let labels = [
        "Deltas [kind,path,ms] / [project,path,count,latest_ms,samples]",
        "Editing [dir,until_ms]",
        "Dossiers [topic_id,title,signal,revision,window_at]",
    ];
    let overflow = |n| match language {
        Language::ZH_CN => format!("…（另有 {n} 项）"),
        Language::ZH_TW => format!("…（另有 {n} 項）"),
        _ => format!("… (+{n} more)"),
    };
    let mut remaining = FILE_HEADER_BYTES
        - labels.iter().map(|s| s.len()).sum::<usize>()
        - guidance.len()
        - 3
        - 2 * "\nnone".len()
        - (1 + overflow(delta_count).len()).max("\nnone".len());
    let populated = [
        !changes.groups.is_empty(),
        !changes.cooling.is_empty(),
        !dossiers.is_empty(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    let share = remaining / populated.max(1);
    let path = |s: &str, width: usize| {
        let relative = roots::host_path(Path::new(s))
            .ok()
            .and_then(|p| p.strip_prefix(workspace).ok())
            .and_then(Path::to_str)
            .unwrap_or(s);
        clipped(
            if relative.is_empty() { "." } else { relative },
            width,
            true,
        )
    };
    let (rows, mut members) = delta_rows(changes.groups, share, path);
    let rows = [
        rows,
        changes
            .cooling
            .iter()
            .map(|(p, until)| serde_json::json!([path(p, share - 29), until]).to_string())
            .collect(),
        dossiers
            .iter()
            .filter(|d| d.topic_id.0.len() < FILE_HEADER_BYTES)
            .map(|d| {
                serde_json::json!([
                    d.topic_id,
                    clipped(&d.title, 48, false),
                    d.signal,
                    d.revision,
                    d.window_at
                ])
                .to_string()
            })
            .collect(),
    ];
    let mut sections = labels.map(str::to_owned);
    let mut counts = [0; 3];
    let mut topics = rows[2].iter();
    for _ in 0..ROW_LIMIT {
        for (i, section) in sections.iter_mut().enumerate() {
            let row = if i == 2 {
                topics.find(|r| r.len() < remaining)
            } else {
                rows[i].get(counts[i]).filter(|r| r.len() < remaining)
            };
            if let Some(row) = row {
                section.push('\n');
                section.push_str(row);
                counts[i] += 1;
                remaining -= row.len() + 1;
            }
        }
    }
    members.truncate(counts[0]);
    let covered = members.iter().map(Vec::len).sum();
    for (i, section) in sections.iter_mut().enumerate() {
        let shown = if i == 0 { covered } else { counts[i] };
        let available = match i {
            0 => delta_count,
            1 => changes.cooling.len(),
            _ => dossiers.len(),
        };
        if available == 0 {
            section.push_str("\nnone");
        } else if shown < available {
            section.push('\n');
            if i == 0 {
                section.push_str(&overflow(available - shown));
            } else {
                section.push('…');
            }
        }
    }

    (format!("{}\n{guidance}", sections.join("\n")), members)
}

fn delta_rows(
    groups: Vec<maka_agent_state::discovery::changes::DeltaGroup>,
    share: usize,
    path: impl Fn(&str, usize) -> String,
) -> (Vec<String>, Vec<Vec<Delta>>) {
    const FOLD_THRESHOLD: usize = 3;
    // Visit each project once before spending another slot on a project's individual files.
    let row_bytes = (share / groups.len().clamp(1, 6)).max(75);
    let mut projects: Vec<_> = groups
        .into_iter()
        .map(|group| {
            let mut rows = Vec::new();
            if group.members.len() > FOLD_THRESHOLD {
                let width = (row_bytes - 45) / 3;
                let samples: Vec<_> = group
                    .members
                    .iter()
                    .take(2)
                    .map(|d| {
                        let member = Path::new(&d.path)
                            .strip_prefix(&group.project)
                            .ok()
                            .and_then(Path::to_str)
                            .filter(|p| !p.is_empty())
                            .unwrap_or(&d.path);
                        clipped(member, width, true)
                    })
                    .collect();
                let row = serde_json::json!([
                    "project",
                    path(&group.project.to_string_lossy(), width),
                    group.members.len(),
                    group.members[0].at,
                    samples
                ])
                .to_string();
                rows.push((row, group.members));
            } else {
                rows.extend(group.members.into_iter().map(|d| {
                    let row =
                        serde_json::json!([d.kind.as_str(), path(&d.path, row_bytes - 38), d.at])
                            .to_string();
                    (row, vec![d])
                }));
            }
            rows.into_iter()
        })
        .collect();
    let mut delta_rows = Vec::new();
    for _ in 0..FOLD_THRESHOLD {
        delta_rows.extend(projects.iter_mut().filter_map(Iterator::next));
    }
    delta_rows.into_iter().unzip()
}

fn clipped(value: &str, bytes: usize, tail: bool) -> String {
    fn escaped(c: char) -> usize {
        match c {
            '"' | '\\' | '\n' | '\r' | '\t' | '\x08' | '\x0c' => 2,
            '\0'..='\x1f' => 6,
            _ => c.len_utf8(),
        }
    }
    if value.len() <= bytes && value.chars().map(escaped).sum::<usize>() <= bytes {
        return value.to_owned();
    }
    let mut remaining = bytes - '…'.len_utf8();
    let mut fits = |c: &char| {
        if let Some(rest) = remaining.checked_sub(escaped(*c)) {
            remaining = rest;
            true
        } else {
            false
        }
    };
    if tail {
        let len: usize = value
            .chars()
            .rev()
            .take_while(&mut fits)
            .map(char::len_utf8)
            .sum();
        format!("…{}", &value[value.len() - len..])
    } else {
        let len: usize = value
            .chars()
            .take_while(&mut fits)
            .map(char::len_utf8)
            .sum();
        format!("{}…", &value[..len])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_state::discovery::{
        DossierSignal,
        changes::{Delta, DeltaKind},
    };
    #[tokio::test]
    async fn discovery_recent_topics_keep_only_ordinary_chats_after_elevation() {
        use serde_json::json;
        let (_dir, root, owner) = test_store().await;
        let prefix = "topic-";
        let bot = bot::Bot::new(root.clone(), prefix.into());
        bot.observe(
            bot::Registration::from_record(maka_plugin_core::storage::Record {
                revision: 1,
                data: Data::Present(json!({"sessionId":"topic-bot"})),
            })
            .unwrap(),
        );
        let catalog =
            SessionCatalog::new(root.data_writer().unwrap(), owner, prefix.into()).unwrap();
        for (id, metadata) in [
            ("topic-chat", json!({"title":"Shipment timing"})),
            ("topic-bot", json!({"title":"Bot notebook"})),
            (
                "topic-private",
                json!({"title":"Private conversation","incognito":true}),
            ),
            (
                "topic-thread",
                json!({"title":"Dossier","dossierSeed":"Initial summary"}),
            ),
            (
                "topic-elevated",
                json!({"title":"Existing dossier marker","dossierSeed":"Initial summary","dossierElevated":true}),
            ),
            (
                "topic-worker",
                json!({"title":"Scheduled probe","discoveryWorker":true}),
            ),
        ] {
            root.create_session(id, id, &metadata, 1).await.unwrap();
        }
        assert_eq!(
            recent_conversation_topics(catalog, &bot).await.unwrap(),
            ["Shipment timing"]
        );
    }

    #[tokio::test]
    async fn discovery_session_header_preserves_file_rows_and_acknowledges_only_visible_sessions() {
        use super::sessions::ConversationKind;
        use maka_agent_state::discovery::{DiscoveryStore, changes::DeltaGroup};
        let work = Path::new("/work");
        let files = || ChangeSnapshot {
            groups: (0..ROW_LIMIT)
                .map(|i| DeltaGroup {
                    project: work.join(i.to_string()),
                    members: vec![Delta {
                        path: format!("/work/{i}/{}.md", "report".repeat(30)),
                        kind: DeltaKind::Modified,
                        at: UnixMillis(8),
                    }],
                })
                .collect(),
            ..Default::default()
        };
        let ids: Vec<_> = (0..5)
            .map(|i| format!("chat-{i}-{}", "x".repeat(128)))
            .collect();
        let sessions = || {
            ids.iter()
                .map(|id| SessionDelta {
                    id: id.clone(),
                    kind: ConversationKind::Session,
                    title: "报价\n\"review\"".repeat(10),
                    activity_at: UnixMillis(12),
                })
                .collect()
        };
        for (locale, hint) in [
            (Language::ZH_CN, "有新对话的会话可按需用 SessionRead 查阅。"),
            (Language::ZH_TW, "有新對話的會話可按需用 SessionRead 查閱。"),
            (
                Language::EN,
                "Inspect updated sessions with SessionRead as needed.",
            ),
        ] {
            let empty = header(locale, work, files(), &[], vec![]);
            assert!(!empty.prompt.contains("Sessions") && !empty.prompt.contains("SessionRead"));
            let opening = header(locale, work, files(), &[], sessions());
            assert!(opening.prompt.starts_with(&empty.prompt));
            assert!(opening.prompt.len() <= HEADER_BYTES && opening.prompt.ends_with(hint));
            assert!(!opening.sessions.is_empty() && opening.sessions.len() < ids.len());
            let rendered: Vec<_> = opening
                .prompt
                .split_once("\nSessions [kind,session_id,title,ms]\n")
                .unwrap()
                .1
                .lines()
                .take_while(|line| line.starts_with('['))
                .map(|row| {
                    let (kind, id, _, at): (String, String, String, UnixMillis) =
                        serde_json::from_str(row).unwrap();
                    assert_eq!(kind, "session");
                    (id, at)
                })
                .collect();
            assert_eq!(rendered, opening.sessions);
            let (_dir, root, owner) = test_store().await;
            let writer = root.data_writer().unwrap();
            let store = DiscoveryStore::new(writer.clone(), &owner).unwrap();
            writer
                .write(store.record_opening(
                    OpeningSources::FollowUp {
                        files: opening.files.into_iter().flatten().collect(),
                        sessions: opening.sessions,
                    },
                    UnixMillis(20),
                ))
                .await
                .unwrap();
            let watermarks = store.session_explored_at(&ids).await.unwrap();
            assert_eq!(
                watermarks,
                rendered.into_iter().map(|(id, at)| (id, at.0)).collect()
            );
        }
    }

    #[tokio::test]
    async fn discovery_opening_acknowledges_only_rendered_versions_and_drains_overflow() {
        use maka_agent_state::discovery::{
            DiscoveryStore,
            changes::{FileWrite, Fingerprint, ProbeResult, WriteKind},
        };
        let (_temp, root, owner) = test_store().await;
        let store = DiscoveryStore::new(root.data_writer().unwrap(), &owner).unwrap();
        let work = Path::new("work");
        let at = UnixMillis(10);
        // Distinct parent directories keep these separate from editing bursts.
        let mut remaining: BTreeSet<_> = (0..25)
            .map(|i| format!("work/project-{i}/{}.md", "proposal".repeat(18)))
            .collect();
        store
            .observe_writes(
                remaining
                    .iter()
                    .map(|path| FileWrite {
                        path: path.clone(),
                        kind: WriteKind::Created,
                        at,
                    })
                    .collect(),
                0,
                100,
                100,
            )
            .await
            .unwrap();
        let probes = store.due_probes(at, 25).await.unwrap();
        store
            .finish_probes(
                probes
                    .into_iter()
                    .map(|p| {
                        (
                            p,
                            ProbeResult::Stable(Fingerprint {
                                mtime: at,
                                hash: "v1".into(),
                            }),
                        )
                    })
                    .collect(),
            )
            .await
            .unwrap();
        loop {
            let snapshot = store
                .change_snapshot(at, ChangeQuery::opening(ROW_LIMIT, work), |_, _| true)
                .await
                .unwrap();
            assert_eq!(
                snapshot
                    .groups
                    .iter()
                    .map(|g| g.members.len())
                    .sum::<usize>()
                    + snapshot.omitted_deltas,
                remaining.len()
            );
            if remaining.is_empty() {
                break;
            }
            let (text, rows) = file_header(Language::EN, work, snapshot, &[]);
            let shown: Vec<_> = rows.into_iter().flatten().collect();
            assert!(
                !shown.is_empty() && shown.len() <= ROW_LIMIT && text.len() <= FILE_HEADER_BYTES
            );
            let rendered: Vec<_> = text
                .lines()
                .skip(1)
                .take_while(|line| line.starts_with('['))
                .map(|line| {
                    serde_json::from_str::<(String, String, i64)>(line)
                        .unwrap()
                        .1
                })
                .collect();
            assert_eq!(rendered.len(), shown.len());
            for (row, delta) in rendered.iter().zip(&shown) {
                assert!(delta.path.ends_with(row.trim_start_matches('…')));
                assert!(remaining.remove(&delta.path));
            }
            root.data_writer()
                .unwrap()
                .write(store.record_opening(
                    OpeningSources::FollowUp {
                        files: shown,
                        sessions: vec![],
                    },
                    at,
                ))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn discovery_grouped_opening_freezes_the_busy_project_and_leaves_racing_probes_ready() {
        use maka_agent_state::discovery::{
            DiscoveryStore,
            changes::{FileWrite, Fingerprint, ProbeResult, WriteKind},
        };
        let (_temp, root, owner) = test_store().await;
        let store = DiscoveryStore::new(root.data_writer().unwrap(), &owner).unwrap();
        let write = |path: String, at| FileWrite {
            path,
            kind: WriteKind::Modified,
            at: UnixMillis(at),
        };
        let settle = |probes: Vec<maka_agent_state::discovery::changes::Probe>| {
            store.finish_probes(
                probes
                    .into_iter()
                    .map(|p| {
                        let fp = Fingerprint {
                            mtime: p.observed,
                            hash: format!("v{}", p.observed.0),
                        };
                        (p, ProbeResult::Stable(fp))
                    })
                    .collect(),
            )
        };
        let mut files: Vec<_> = (0..40)
            .map(|i| write(format!("/work/clients/busy/s{i}/quote"), 100 + i))
            .collect();
        files.push(write("/work/quiet/deadline".into(), 20));
        store.observe_writes(files, 0, 100, 100).await.unwrap();
        settle(store.due_probes(UnixMillis(200), 100).await.unwrap())
            .await
            .unwrap();
        let snapshot = || {
            store.change_snapshot(
                UnixMillis(300),
                ChangeQuery::Opening {
                    limit: 2,
                    workspace: "/work".into(),
                    projects: ["/work/clients/busy".into()].into(),
                },
                |_, _| true,
            )
        };
        let (opening, covered) = file_header(
            Language::EN,
            Path::new("/work"),
            snapshot().await.unwrap(),
            &[],
        );
        assert!(
            opening.contains(r#"["project","clients/busy",40,139,["s39/quote","s38/quote"]]"#),
            "{opening}"
        );
        assert!(opening.contains("quiet/deadline") && opening.len() <= FILE_HEADER_BYTES);
        let covered: Vec<_> = covered.into_iter().flatten().collect();
        assert_eq!(covered.len(), 41);
        store
            .observe_writes(
                vec![
                    write("/work/clients/busy/s39/quote".into(), 201),
                    write("/work/clients/busy/late".into(), 17),
                ],
                0,
                100,
                100,
            )
            .await
            .unwrap();
        settle(store.due_probes(UnixMillis(300), 10).await.unwrap())
            .await
            .unwrap();
        root.data_writer()
            .unwrap()
            .write(store.record_opening(
                OpeningSources::FollowUp {
                    files: covered,
                    sessions: vec![],
                },
                UnixMillis(300),
            ))
            .await
            .unwrap();
        let pending = snapshot().await.unwrap().into_deltas();
        assert_eq!(
            pending
                .iter()
                .map(|d| (d.path.as_str(), d.at.0))
                .collect::<Vec<_>>(),
            [
                ("/work/clients/busy/s39/quote", 201),
                ("/work/clients/busy/late", 17)
            ]
        );
    }

    #[test]
    fn discovery_header_is_bounded_in_every_locale_and_counts_omitted_deltas() {
        for language in [Language::EN, Language::ZH_CN, Language::ZH_TW] {
            let changes = || ChangeSnapshot {
                groups: (0..30)
                    .map(|i| {
                        let project = Path::new("/work").join(format!("p{i}"));
                        maka_agent_state::discovery::changes::DeltaGroup {
                            members: vec![Delta {
                                path: format!("/work/p{i}/合同-{i}.pdf"),
                                kind: DeltaKind::Created,
                                at: UnixMillis(2000 - i),
                            }],
                            project,
                        }
                    })
                    .collect(),
                omitted_deltas: 0,
                cooling: vec![("/work/editing".into(), UnixMillis(4000))],
            };
            let topics = vec![IndexedDossier {
                topic_id: TopicId("signature".into()),
                title: "核对附件".into(),
                signal: DossierSignal::Red,
                revision: 7,
                window_at: Some(UnixMillis(3000)),
            }];
            let (text, shown) = file_header(language, Path::new("/work"), changes(), &topics);
            assert!(text.len() <= FILE_HEADER_BYTES, "{text}");
            assert!(
                text.contains(r#"["created","p0/合同-0.pdf",2000]"#)
                    && text.contains(r#"["editing",4000]"#),
                "{text}"
            );
            assert!(
                text.contains(r#"["signature","核对附件","red",7,3000]"#),
                "{text}"
            );
            assert_eq!(text.matches(".pdf").count(), ROW_LIMIT);
            let expected = |n| match language {
                Language::ZH_CN => format!("…（另有 {n} 项）"),
                Language::ZH_TW => format!("…（另有 {n} 項）"),
                _ => format!("… (+{n} more)"),
            };
            assert!(text.contains(&expected(15)), "{text}");
            assert_eq!(shown.len(), ROW_LIMIT);
            let mut changes = changes();
            for delta in changes.groups.iter_mut().flat_map(|g| &mut g.members) {
                delta.path = format!("/work/{}.pdf", "合同".repeat(200));
            }
            let (text, shown) = file_header(language, Path::new("/work"), changes, &topics);
            let displayed = text.matches(".pdf").count();
            assert!(
                text.len() <= FILE_HEADER_BYTES && (1..=ROW_LIMIT).contains(&displayed),
                "{text}"
            );
            assert_eq!(shown.len(), displayed);
            assert!(text.contains(&expected(30 - displayed)), "{text}");
            let (empty, _) =
                file_header(language, Path::new("/work"), ChangeSnapshot::default(), &[]);
            assert_eq!(empty.matches("\nnone").count(), 3);
        }
    }
}
