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

//! Discovery-only progress over immutable tool settlements. Model retries/replay do not spend steps twice.
use maka_agent_facts::{
    durable::FactId,
    language::Language,
    model::{
        ModelToolCall,
        prompt::{ContentPart, ToolOutput},
    },
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    hash::{DefaultHasher, Hash, Hasher},
    path::{Component, Path},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::owner) enum StopReason {
    Stalled,
    Ceiling,
}
impl StopReason {
    pub(in crate::owner) fn message(self) -> &'static str {
        match self {
            Self::Stalled => "Discovery finished after repeated tool results",
            Self::Ceiling => "Discovery reached the 100-step safety ceiling",
        }
    }
}

#[derive(Default)]
pub(in crate::owner) struct Progress {
    reads: HashSet<(u64, Option<u64>)>,
    outputs: HashSet<u64>,
    through: u64,
    productive: bool,
    stalled: usize,
    steps: usize,
    notes: BTreeMap<FactId, String>,
}

impl Progress {
    pub(in crate::owner) fn count_steps(&mut self, steps: usize) {
        self.steps = self.steps.max(steps);
    }
    pub(in crate::owner) fn stop(&self) -> Option<StopReason> {
        if self.steps >= 100 {
            Some(StopReason::Ceiling)
        } else if self.stalled >= 8 {
            Some(StopReason::Stalled)
        } else {
            None
        }
    }
    pub(in crate::owner) fn recorded(&self, revision: u64) -> bool {
        revision <= self.through
    }
    pub(in crate::owner) fn child_returned(
        &mut self,
        revision: u64,
        read: Option<u64>,
        wrote: bool,
    ) {
        if self.recorded(revision) {
            return;
        }
        self.through = revision;
        self.productive |= read.is_some_and(|key| self.reads.insert((key, None))) || wrote;
    }
    pub(in crate::owner) fn note(&self, id: FactId) -> Option<&str> {
        self.notes.get(&id).map(String::as_str)
    }

    pub(in crate::owner) fn observe(
        &mut self,
        observation: Observation,
        step: SettledStep,
        language: Language,
    ) {
        if self.recorded(step.revision) {
            return;
        }
        self.through = step.revision;
        let new_read = observation
            .read_target
            .is_some_and(|target| self.reads.insert((target, observation.output)));
        let new_output = observation.output.is_some_and(|o| self.outputs.insert(o));
        self.productive |= observation.wrote || new_read || new_output;
        if !step.last {
            return;
        }
        self.stalled = if self.productive { 0 } else { self.stalled + 1 };
        self.productive = false;
        let mut notes = Vec::new();
        if matches!(step.number, 15 | 35) {
            notes.push(match language {
                Language::ZH_CN => format!("第 {} 步检查：若仍有新证据或在准备有用产出，请继续；否则请用 UpsertDossier 或 FinishNoChange 收尾。",step.number),
                Language::ZH_TW => format!("第 {} 步檢查：若仍有新證據或在準備有用產出，請繼續；否則請用 UpsertDossier 或 FinishNoChange 收尾。",step.number),
                _ => format!("Checkpoint (step {}). Continue for new evidence or useful outputs. Otherwise conclude with UpsertDossier or FinishNoChange.",step.number),
            });
        }
        if self.stalled == 6 {
            notes.push(match language {
                Language::ZH_CN => "连续六步无新进展。请立即调用 UpsertDossier 或 FinishNoChange 收尾。",
                Language::ZH_TW => "連續六步無新進展。請立即呼叫 UpsertDossier 或 FinishNoChange 收尾。",
                _ => "Six steps yielded no new evidence. Wrap up immediately with UpsertDossier or FinishNoChange.",
            }.to_owned());
        }
        if !notes.is_empty() {
            self.notes.insert(step.id, notes.join("\n"));
        }
    }
}

pub(in crate::owner) struct SettledStep {
    pub id: FactId,
    pub revision: u64,
    pub number: usize,
    pub last: bool,
}

pub(in crate::owner) struct Observation {
    read_target: Option<u64>,
    output: Option<u64>,
    wrote: bool,
}
fn hash<T: Hash + ?Sized>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

pub(in crate::owner) fn is_productive_write_tool(name: &str) -> bool {
    matches!(
        name,
        crate::owner::discovery::UPSERT
            | crate::owner::discovery::WORKSPACE_MAP
            | crate::owner::discovery::WATCH_SCOPE
            | crate::owner::discovery::STAGE
            | crate::owner::discovery::REGISTER
    )
}

impl Observation {
    pub(in crate::owner) fn new(
        call: &ModelToolCall,
        output: &ToolOutput,
        success: bool,
        workspace: &Path,
    ) -> Self {
        let output = success.then(|| evidence(output)).flatten();
        let read_target = if success && (output.is_some() || call.name.eq_ignore_ascii_case("Read"))
        {
            canonical_target(&call.name, call.input.as_json(), workspace)
        } else {
            None
        };
        Self {
            read_target,
            output,
            wrote: success && is_productive_write_tool(&call.name),
        }
    }
}

pub(in crate::owner) fn canonical_target(
    tool: &str,
    args: Option<&Value>,
    workspace: &Path,
) -> Option<u64> {
    let name = tool.trim().to_ascii_lowercase();
    let path = args
        .and_then(|a| a.get("path").or_else(|| a.get("file_path")))
        .and_then(Value::as_str);
    let target = args
        .and_then(|a| {
            a.get("topic_id")
                .or_else(|| a.get("url"))
                .or_else(|| a.get("uri"))
        })
        .and_then(Value::as_str);
    let key = match (path, target) {
        (Some(path), _) if !path.contains("://") => {
            let mut normalized = std::path::PathBuf::new();
            for c in workspace.join(path.trim()).components() {
                match c {
                    Component::CurDir => {}
                    Component::ParentDir => {
                        normalized.pop();
                    }
                    _ => normalized.push(c.as_os_str()),
                }
            }
            hash(&(&name, normalized))
        }
        (Some(s), _) | (_, Some(s)) => hash(&(&name, s.trim())),
        _ => return None,
    };
    Some(key)
}

fn text_evidence(text: &str) -> Option<u64> {
    let text = text.trim();
    (!matches!(
        text,
        "" | "[]" | "{}" | "null" | "No matches" | "No matches found" | "No matches found."
    ))
    .then(|| hash(text))
}

fn json_evidence(value: &Value) -> Option<u64> {
    match value {
        Value::Null => None,
        Value::String(s) => text_evidence(s),
        Value::Array(items) => {
            let mut digest = DefaultHasher::new();
            let mut observations = items.iter().filter_map(json_evidence).peekable();
            observations.peek()?;
            for observed in observations {
                observed.hash(&mut digest);
            }
            Some(digest.finish())
        }
        Value::Object(map) => {
            // Archive addresses and cell IDs change per invocation, including on identical reads.
            let payload = |key: &str| {
                matches!(
                    key,
                    "content"
                        | "text"
                        | "result"
                        | "results"
                        | "matches"
                        | "entries"
                        | "records"
                        | "items"
                        | "stdout"
                        | "stderr"
                        | "output"
                        | "page"
                        | "tailPreview"
                )
            };
            let has_payload = map.keys().any(|key| payload(key));
            let mut fields = Vec::new();
            for (key, value) in map {
                if (has_payload && !payload(key))
                    || matches!(
                        key.as_str(),
                        "cell_id" | "call_id" | "elapsed_ms" | "duration_ms"
                    )
                {
                    continue;
                }
                if let Some(observed) = json_evidence(value) {
                    fields.push((key, observed));
                }
            }
            fields.sort_unstable_by_key(|(key, _)| *key);
            (!fields.is_empty()).then(|| hash(&fields))
        }
        _ => Some(hash(value)),
    }
}
fn projected_text(text: &str) -> Option<u64> {
    if text.trim_start().starts_with(['{', '['])
        && let Ok(value) = serde_json::from_str::<Value>(text)
    {
        return json_evidence(&value);
    }
    text_evidence(text)
}
fn evidence(output: &ToolOutput) -> Option<u64> {
    match output {
        ToolOutput::Text(s) => projected_text(s),
        ToolOutput::Json(v) => json_evidence(v),
        ToolOutput::Content(parts) => {
            let mut h = DefaultHasher::new();
            let mut any = false;
            for part in parts {
                match part {
                    ContentPart::Text { text, .. } => {
                        if let Some(digest) = projected_text(text) {
                            any = true;
                            digest.hash(&mut h);
                        }
                    }
                    ContentPart::File { data, .. } => {
                        use maka_agent_facts::model::prompt::FileData;
                        let FileData::Data(s) = data;
                        any = true;
                        s.hash(&mut h);
                    }
                }
            }
            any.then(|| h.finish())
        }
        _ => None,
    }
}

pub(in crate::owner) fn append_note(output: &mut ToolOutput, note: &str) {
    match output {
        ToolOutput::Text(s) | ToolOutput::ErrorText(s) => {
            s.push_str("\n\n");
            s.push_str(note);
        }
        ToolOutput::Json(v) => *output = ToolOutput::Text(format!("{v}\n\n{note}")),
        ToolOutput::ErrorJson(v) => *output = ToolOutput::ErrorText(format!("{v}\n\n{note}")),
        ToolOutput::Content(parts) => parts.push(ContentPart::text(note)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::ToolInput;
    use serde_json::json;
    fn call(name: &str, args: Value) -> ModelToolCall {
        ModelToolCall {
            id: "test".into(),
            name: name.into(),
            input: ToolInput::Json(args),
            provider_options: None,
            provider_executed: false,
        }
    }
    fn accept(p: &mut Progress, n: usize, call: ModelToolCall, out: Value) -> Option<String> {
        let id = FactId::new();
        let obs = Observation::new(&call, &ToolOutput::Json(out), true, Path::new("/work"));
        p.count_steps(n);
        p.observe(
            obs,
            SettledStep {
                id,
                revision: n as u64,
                number: n,
                last: true,
            },
            Language::EN,
        );
        p.note(id).map(str::to_owned)
    }
    #[test]
    fn discovery_productive_steps_reach_both_checkpoints_and_the_high_ceiling() {
        let mut p = Progress::default();
        for n in 1..=100 {
            let note = accept(
                &mut p,
                n,
                call("Read", json!({"path":format!("file-{n}")})),
                json!("shared contents"),
            );
            assert_eq!(note.is_some(), matches!(n, 15 | 35));
            assert_eq!(p.stop(), (n == 100).then_some(StopReason::Ceiling));
        }
    }
    #[test]
    fn discovery_empty_queries_stall_but_new_evidence_and_dossier_writes_reset_the_streak() {
        let mut p = Progress::default();
        for n in 1..=6 {
            let note = accept(
                &mut p,
                n,
                call("Search", json!({"query":n})),
                json!({"results":[],"count":0}),
            );
            assert_eq!(note.is_some(), n == 6);
        }
        accept(
            &mut p,
            7,
            call("Search", json!({"query":1})),
            json!({"results":["new evidence"]}),
        );
        for n in 8..=13 {
            let note = accept(
                &mut p,
                n,
                call("Search", json!({"query":1})),
                json!({"results":["new evidence"]}),
            );
            assert_eq!(note.is_some(), n == 13);
        }
        accept(
            &mut p,
            14,
            call("UpsertDossier", json!({"topic_id":"one"})),
            json!({"revision":1}),
        );
        for n in 15..=22 {
            accept(&mut p, n, call("Search", json!({"query":1})), Value::Null);
            assert_eq!(p.stop(), (n == 22).then_some(StopReason::Stalled));
        }
    }
}
