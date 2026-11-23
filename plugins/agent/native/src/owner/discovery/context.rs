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

use super::*;
use jiff::{Timestamp, tz::TimeZone};
use maka_agent_state::discovery::changes::{
    ChangeQuery, ChangeSnapshot, Delta, IndexedDossier, OpeningSources,
};
use std::path::Path;

pub(super) fn timestamp(ms: u64) -> Option<String> {
    Timestamp::from_millisecond(i64::try_from(ms).ok()?)
        .ok()
        .map(|time| time.to_string())
}

pub(super) fn local_timestamp(ms: u64, timezone: &str) -> Option<String> {
    let time = Timestamp::from_millisecond(i64::try_from(ms).ok()?).ok()?;
    let zone = TimeZone::get(timezone).ok()?;
    Some(time.to_zoned(zone).strftime("%FT%T%:z").to_string())
}

pub(super) fn environment(language: Language, workspace: &str, timezone: &str) -> String {
    let at = now();
    let time = local_timestamp(at, timezone)
        .or_else(|| timestamp(at))
        .unwrap_or_default();
    match language {
        Language::ZhCn => format!("\n\n当前时间：{time}。工作区：{workspace}"),
        Language::ZhTw => format!("\n\n目前時間：{time}。工作區：{workspace}"),
        _ => format!("\n\nCurrent time: {time}. Workspace: {workspace}"),
    }
}

// ~400–500 tokens across mixed English/CJK paths and compact JSON rows.
const HEADER_BYTES: usize = 1600;
const ROW_LIMIT: usize = 15;

impl Owner {
    pub(super) async fn discovery_opening(
        &self,
        mode: &DiscoveryMode,
        job: &Job,
        tools: &[String],
    ) -> Result<(String, OpeningSources), String> {
        if let DiscoveryMode::Wander { sources } = mode {
            let cold = if self.discovery_reads_files(tools) {
                sources.clone()
            } else {
                Vec::new()
            };
            let root = Path::new(&job.approval.target.workspace.path);
            let displayed: Vec<_> = cold
                .iter()
                .map(|p| {
                    let rel = roots::host_path(Path::new(p))
                        .expect("UTF-8 source")
                        .strip_prefix(root)
                        .expect("authorized source");
                    clipped(&rel.to_string_lossy(), 360, true)
                })
                .collect();
            let label = match job.approval.language {
                Language::ZhCn => "冷门探索起点",
                Language::ZhTw => "冷門探索起點",
                Language::En => "Cold starting points",
            };
            return Ok((
                format!("{label}\n{}", serde_json::json!(displayed)),
                OpeningSources::Wander(cold),
            ));
        }

        let changes = if self.discovery_reads_files(tools) {
            self.discovery_changes(
                &job.approval,
                UnixMillis(now() as i64),
                ChangeQuery::Opening { limit: ROW_LIMIT },
            )
            .await?
        } else {
            ChangeSnapshot::default()
        };
        let dossiers = if tools.iter().any(|t| matches!(t.as_str(), LIST | READ)) {
            self.discovery
                .active_dossier_index(ROW_LIMIT as u32)
                .await
                .map_err(reason)?
        } else {
            Vec::new()
        };
        let (mut prompt, displayed_deltas) = header(
            job.approval.language,
            Path::new(&job.approval.target.workspace.path),
            changes,
            &dossiers,
        );
        let excerpt = self.discovery_preferences_excerpt().await?;
        if !excerpt.is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(&excerpt);
        }
        Ok((prompt, OpeningSources::FollowUp(displayed_deltas)))
    }
}

fn header(
    language: Language,
    workspace: &Path,
    mut changes: ChangeSnapshot,
    dossiers: &[IndexedDossier],
) -> (String, Vec<Delta>) {
    let delta_count = changes.deltas.len() + changes.omitted_deltas;
    let guidance = match language {
        Language::ZhCn => "避开正在编辑的目录。可核查周边约束，或静默结束。",
        Language::ZhTw => "避開正在編輯的目錄。可核查周邊限制，或靜默結束。",
        _ => "Skip active edits. Check related constraints or finish quietly.",
    };
    let labels = [
        "Deltas [kind,path,ms]",
        "Editing [dir,until_ms]",
        "Dossiers [topic_id,title,signal,revision,window_at]",
    ];
    let overflow = |n| match language {
        Language::ZhCn => format!("…（另有 {n} 项）"),
        Language::ZhTw => format!("…（另有 {n} 項）"),
        Language::En => format!("… (+{n} more)"),
    };
    let mut remaining = HEADER_BYTES
        - labels.iter().map(|s| s.len()).sum::<usize>()
        - guidance.len()
        - 3
        - 2 * "\nnone".len()
        - (1 + overflow(delta_count).len()).max("\nnone".len());
    let populated = [
        !changes.deltas.is_empty(),
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
    let rows = [
        changes
            .deltas
            .iter()
            .take(ROW_LIMIT)
            .map(|d| {
                serde_json::json!([d.kind.as_str(), path(&d.path, share - 40), d.at]).to_string()
            })
            .collect::<Vec<_>>(),
        changes
            .cooling
            .iter()
            .map(|(p, until)| serde_json::json!([path(p, share - 29), until]).to_string())
            .collect(),
        dossiers
            .iter()
            .filter(|d| d.topic_id.0.len() < HEADER_BYTES)
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
                topics.find(|r| r.len() + 1 <= remaining)
            } else {
                rows[i].get(counts[i]).filter(|r| r.len() + 1 <= remaining)
            };
            if let Some(row) = row {
                section.push('\n');
                section.push_str(row);
                counts[i] += 1;
                remaining -= row.len() + 1;
            }
        }
    }
    for (i, section) in sections.iter_mut().enumerate() {
        let available = match i {
            0 => delta_count,
            1 => changes.cooling.len(),
            _ => dossiers.len(),
        };
        if available == 0 {
            section.push_str("\nnone");
        } else if counts[i] < available {
            section.push('\n');
            if i == 0 {
                section.push_str(&overflow(available - counts[i]));
            } else {
                section.push('…');
            }
        }
    }
    changes.deltas.truncate(counts[0]);
    (
        format!("{}\n{guidance}", sections.join("\n")),
        changes.deltas,
    )
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
                .change_snapshot(at, ChangeQuery::Opening { limit: ROW_LIMIT }, |_, _| true)
                .await
                .unwrap();
            assert_eq!(
                snapshot.deltas.len() + snapshot.omitted_deltas,
                remaining.len()
            );
            if remaining.is_empty() {
                break;
            }
            let (text, shown) = header(Language::En, work, snapshot, &[]);
            assert!(!shown.is_empty() && shown.len() <= ROW_LIMIT && text.len() <= HEADER_BYTES);
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
                assert_eq!(work.join(row), Path::new(&delta.path));
                assert!(remaining.remove(&delta.path));
            }
            root.data_writer()
                .unwrap()
                .write(store.record_opening(OpeningSources::FollowUp(shown), false, at))
                .await
                .unwrap();
        }
    }

    #[test]
    fn discovery_header_is_bounded_in_every_locale_and_counts_omitted_deltas() {
        for language in [Language::En, Language::ZhCn, Language::ZhTw] {
            let changes = || ChangeSnapshot {
                deltas: (0..30)
                    .map(|i| Delta {
                        path: format!("/work/合同-{i}.pdf"),
                        kind: DeltaKind::Created,
                        at: UnixMillis(2000 - i),
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
            let (text, shown) = header(language, Path::new("/work"), changes(), &topics);
            assert!(text.len() <= HEADER_BYTES, "{text}");
            assert!(
                text.contains(r#"["created","合同-0.pdf",2000]"#)
                    && text.contains(r#"["editing",4000]"#),
                "{text}"
            );
            assert!(
                text.contains(r#"["signature","核对附件","red",7,3000]"#),
                "{text}"
            );
            assert_eq!(text.matches(".pdf").count(), ROW_LIMIT);
            let expected = |n| match language {
                Language::ZhCn => format!("…（另有 {n} 项）"),
                Language::ZhTw => format!("…（另有 {n} 項）"),
                Language::En => format!("… (+{n} more)"),
            };
            assert!(text.contains(&expected(15)), "{text}");
            assert_eq!(shown.len(), ROW_LIMIT);
            let mut changes = changes();
            for delta in &mut changes.deltas {
                delta.path = format!("/work/{}.pdf", "合同".repeat(200));
            }
            let (text, shown) = header(language, Path::new("/work"), changes, &topics);
            let displayed = text.matches(".pdf").count();
            assert!(
                text.len() <= HEADER_BYTES && (1..ROW_LIMIT).contains(&displayed),
                "{text}"
            );
            assert_eq!(shown.len(), displayed);
            assert!(text.contains(&expected(30 - displayed)), "{text}");
            let (empty, _) = header(language, Path::new("/work"), ChangeSnapshot::default(), &[]);
            assert_eq!(empty.matches("\nnone").count(), 3);
        }
    }
}
