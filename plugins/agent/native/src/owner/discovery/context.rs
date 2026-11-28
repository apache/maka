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
use maka_agent_state::discovery::changes::{ChangeSnapshot, Delta, IndexedDossier};
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
    maka_agent_facts::i18n::discovery::context_environment(language, &time, workspace)
}

// ~400–500 tokens across mixed English/CJK paths and compact JSON rows.
const HEADER_BYTES: usize = 1600;
const ROW_LIMIT: usize = 15;

impl Owner {
    pub(super) async fn discovery_opening(
        &self,
        job: &Job,
        tools: &[String],
    ) -> Result<(String, Vec<Delta>), String> {
        let changes = if self.discovery_reads_files(tools) {
            self.discovery_changes(&job.approval, UnixMillis(now() as i64), ROW_LIMIT)
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
        Ok(header(
            job.approval.language,
            Path::new(&job.approval.target.workspace.path),
            changes,
            &dossiers,
        ))
    }
}

fn header(
    language: Language,
    workspace: &Path,
    changes: ChangeSnapshot,
    dossiers: &[IndexedDossier],
) -> (String, Vec<Delta>) {
    let guidance = match language {
        Language::ZH_CN => "避开正在编辑的目录。可核查周边约束，或静默结束。",
        Language::ZH_TW => "避開正在編輯的目錄。可核查周邊限制，或靜默結束。",
        _ => "Skip active edits. Check related constraints or finish quietly.",
    };
    let labels = [
        "Deltas [kind,path,ms]",
        "Editing [dir,until_ms]",
        "Dossiers [topic_id,title,signal,revision,window_at]",
    ];
    let mut remaining = HEADER_BYTES
        - labels.iter().map(|s| s.len()).sum::<usize>()
        - guidance.len()
        - 3
        - 3 * "\nnone".len();
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
        let relative = Path::new(s)
            .strip_prefix(workspace)
            .ok()
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
        let available = if i == 2 {
            dossiers.len()
        } else {
            rows[i].len()
        };
        if available == 0 {
            section.push_str("\nnone");
        } else if counts[i] < available {
            section.push_str("\n…");
        }
    }
    (
        format!("{}\n{guidance}", sections.join("\n")),
        changes.deltas.into_iter().take(counts[0]).collect(),
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
    use maka_agent_state::discovery::{DossierSignal, changes::DeltaKind};
    #[test]
    fn discovery_header_is_bounded_in_every_locale_and_acknowledges_only_displayed_paths() {
        for language in [Language::EN, Language::ZH_CN, Language::ZH_TW] {
            let changes = ChangeSnapshot {
                deltas: (0..30)
                    .map(|i| Delta {
                        path: format!("/work/合同-{i}.pdf"),
                        kind: DeltaKind::Created,
                        at: UnixMillis(2000 - i),
                    })
                    .collect(),
                cooling: vec![("/work/editing".into(), UnixMillis(4000))],
            };
            let topics = vec![IndexedDossier {
                topic_id: TopicId("signature".into()),
                title: "核对附件".into(),
                signal: DossierSignal::Red,
                revision: 7,
                window_at: Some(UnixMillis(3000)),
            }];
            let (text, shown) = header(language, Path::new("/work"), changes, &topics);
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
            assert_eq!(text.matches(".pdf").count(), shown.len());
            assert!(shown.len() >= 10 && shown.len() <= ROW_LIMIT);
            let (empty, _) = header(language, Path::new("/work"), ChangeSnapshot::default(), &[]);
            assert_eq!(empty.matches("\nnone").count(), 3);
        }
    }
}
