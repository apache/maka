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
    durable::{FactId, StepId},
    language::Language,
    model::prompt::{ContentPart, ToolOutput},
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
            Self::Ceiling => "Discovery reached its step limit",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::owner) enum Mode {
    FollowUp,
    Briefing,
    Wander,
    Onboard,
}

const MAX_TOOL_OUTPUT_BYTES: usize = 10_000;
const HEAD_KEEP_BYTES: usize = 7_000;
const TAIL_KEEP_BYTES: usize = 2_000;

impl Mode {
    fn limit(self) -> usize {
        match self {
            Self::FollowUp | Self::Wander => 12,
            Self::Onboard | Self::Briefing => 18,
        }
    }

    fn wrap_up_steps(self) -> usize {
        match self {
            Self::FollowUp | Self::Wander => 3,
            Self::Onboard | Self::Briefing => 4,
        }
    }
}

#[derive(Clone, Copy)]
pub(in crate::owner) struct StepBudget {
    elapsed: usize,
    limit: usize,
}

pub(in crate::owner) type SharedProgress = std::sync::Arc<std::sync::Mutex<Progress>>;

pub(in crate::owner) struct Progress {
    mode: Mode,
    evidence: HashSet<(u64, Option<u64>)>,
    through: u64,
    steps: usize,
    last_productive: usize,
    budgets: BTreeMap<StepId, StepBudget>,
    notes: BTreeMap<FactId, String>,
}

impl Progress {
    pub(in crate::owner) fn new(mode: Mode) -> Self {
        Self {
            mode,
            evidence: Default::default(),
            through: 0,
            steps: 0,
            last_productive: 0,
            budgets: Default::default(),
            notes: Default::default(),
        }
    }
    // All calls in one step share its original countdown, including during replay.
    pub(in crate::owner) fn freeze_next(&mut self, id: StepId) {
        let budget = self.next_budget();
        self.budgets.entry(id).or_insert(budget);
    }
    pub(in crate::owner) fn next_budget(&self) -> StepBudget {
        StepBudget {
            elapsed: self.steps,
            limit: self.mode.limit(),
        }
    }
    pub(in crate::owner) fn begin(&mut self, revision: u64, id: StepId) {
        if self.recorded(revision) {
            return;
        }
        self.freeze_next(id);
        self.steps += 1;
        self.through = revision;
    }
    pub(in crate::owner) fn budget(&self, id: StepId) -> Option<StepBudget> {
        self.budgets.get(&id).copied()
    }
    pub(in crate::owner) fn rejection(
        &self,
        step: StepBudget,
        name: &str,
        language: Language,
    ) -> Option<String> {
        use crate::owner::discovery::{
            COMPLETE, FINISH, PENDING, REGISTER, UPSERT, WATCH_SCOPE, WORKSPACE_MAP,
        };
        let remaining = step.limit.saturating_sub(step.elapsed);
        if remaining > self.mode.wrap_up_steps() {
            return None;
        }
        match (self.mode, name) {
            (_, UPSERT | FINISH | COMPLETE | REGISTER | PENDING)
            | (Mode::Onboard | Mode::Wander, WORKSPACE_MAP)
            | (Mode::Onboard, WATCH_SCOPE) => None,
            _ => Some(countdown(language, remaining)),
        }
    }
    pub(in crate::owner) fn stop(&self) -> Option<StopReason> {
        if self.steps >= self.mode.limit() {
            Some(StopReason::Ceiling)
        } else if self.steps.saturating_sub(self.last_productive) >= 5 {
            Some(StopReason::Stalled)
        } else {
            None
        }
    }
    pub(in crate::owner) fn mark_replayed(&mut self, revision: u64) {
        self.through = self.through.max(revision);
    }
    pub(in crate::owner) fn recorded(&self, revision: u64) -> bool {
        revision <= self.through
    }
    pub(in crate::owner) fn observe(
        &mut self,
        revision: u64,
        observed: Observation,
        id: Option<FactId>,
        language: Language,
    ) {
        if self.recorded(revision) {
            return;
        }
        self.through = revision;
        let discovered = observed.target.is_some_and(|target| {
            let new_target = self.evidence.insert((target, None));
            let new_evidence = observed
                .output
                .is_some_and(|digest| self.evidence.insert((target, Some(digest))));
            new_target || new_evidence
        });
        if discovered || observed.write {
            self.last_productive = self.steps;
        }
        let Some(id) = id else { return };
        let limit = self.mode.limit();
        let wrap = self.mode.wrap_up_steps();
        let mut notes = Vec::new();
        let remaining = limit.saturating_sub(self.steps);
        if (limit.saturating_sub(wrap)..limit).contains(&self.steps) {
            notes.push(countdown(language, remaining));
        } else if self.steps == limit.saturating_sub(wrap + 2) {
            notes.push(maka_agent_facts::i18n::discovery::checkpoint(
                language,
                &remaining.to_string(),
            ));
        }
        if remaining > 0 && self.steps.saturating_sub(self.last_productive) == 3 {
            notes.push(maka_agent_facts::i18n::discovery::stalled(language).to_owned());
        }
        if !notes.is_empty() {
            self.notes.insert(id, notes.join("\n"));
        }
    }
    pub(in crate::owner) fn annotate(&self, id: FactId, output: &mut ToolOutput) {
        if let Some(note) = self.notes.get(&id) {
            append_note(output, note);
        }
    }
}
fn countdown(language: Language, remaining: usize) -> String {
    maka_agent_facts::i18n::discovery::countdown(language, &remaining.to_string())
}

#[derive(Default)]
pub(in crate::owner) struct Observation {
    target: Option<u64>,
    output: Option<u64>,
    write: bool,
}
impl Observation {
    pub(in crate::owner) fn success(tool: &str, args: Option<&Value>, workspace: &Path) -> Self {
        use crate::owner::discovery::{STAGE, UPSERT, WATCH_SCOPE, WORKSPACE_MAP};
        let action = args.and_then(|a| a.get("action")).and_then(Value::as_str);
        let write = matches!(tool, UPSERT | STAGE)
            || (matches!(tool, WORKSPACE_MAP | WATCH_SCOPE) && action != Some("inspect"));
        let target = if matches!(tool, "exec" | "wait") {
            None
        } else {
            canonical_target(tool, args, workspace)
        };
        Self {
            target,
            write,
            output: None,
        }
    }
    pub(in crate::owner) fn needs_evidence(&self, name: &str) -> bool {
        name == crate::owner::discovery::UPSERT
            || self.target.is_some()
                && !self.write
                && !matches!(
                    name,
                    "RegisterWatch" | "StagePendingAction" | "FinishNoChange"
                )
    }
    pub(in crate::owner) fn with_output(mut self, name: &str, output: &ToolOutput) -> Self {
        if name == crate::owner::discovery::UPSERT {
            // Local UpsertDossier returns a structured receipt, including on replay.
            self.write =
                matches!(output, ToolOutput::Json(receipt) if receipt["material_change"] == true);
        } else {
            self.output = evidence(output);
        }
        self
    }
    pub(in crate::owner) fn with_value(mut self, value: &Value) -> Self {
        self.output = json_evidence(value);
        self
    }
}
fn hash<T: Hash + ?Sized>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

fn normalize_path(path: &str, workspace: &Path) -> std::path::PathBuf {
    let mut normalized = std::path::PathBuf::new();
    for component in workspace.join(path.trim()).components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn canonical_target(tool: &str, args: Option<&Value>, workspace: &Path) -> Option<u64> {
    let tool_key = tool.trim().to_ascii_lowercase();
    if let Some(args) = args {
        if let Some(path) = args
            .get("path")
            .or_else(|| args.get("file_path"))
            .and_then(Value::as_str)
            && !path.contains("://")
        {
            return Some(hash(&("path", normalize_path(path, workspace))));
        }
        if let Some(raw) = ["url", "uri", "path", "file_path"]
            .iter()
            .find_map(|key| args.get(key)?.as_str())
        {
            let mut url = reqwest::Url::parse(raw.trim()).ok()?;
            url.set_fragment(None);
            return Some(hash(&("url", url.as_str())));
        }
        if let Some(topic) = args.get("topic_id").and_then(Value::as_str) {
            return Some(hash(&("topic", topic.trim())));
        }
        if let Some(id) = args
            .get("sessionId")
            .or_else(|| args.get("session_id"))
            .and_then(Value::as_str)
        {
            return Some(hash(&("session", id.trim())));
        }
        if let Some(command) = args.get("command").and_then(Value::as_str) {
            let cwd = args
                .get("cwd")
                .or_else(|| args.get("workdir"))
                .and_then(Value::as_str)
                .map_or_else(
                    || workspace.to_path_buf(),
                    |dir| normalize_path(dir, workspace),
                );
            return Some(hash(&("shell", cwd, command.trim())));
        }
        if let Some(query) = args.get("query").and_then(Value::as_str) {
            return Some(hash(&(
                "query",
                tool_key,
                query.trim().to_ascii_lowercase(),
            )));
        }
    }
    matches!(tool, "ListDossiers" | "SessionList" | "DiscoveryMemory")
        .then(|| hash(&("catalog", tool_key)))
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
                        "cell_id"
                            | "cellId"
                            | "call_id"
                            | "callId"
                            | "elapsed_ms"
                            | "elapsedMs"
                            | "duration_ms"
                            | "durationMs"
                            | "toolUseId"
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

fn truncation<'a>(
    texts: impl Iterator<Item = &'a str> + Clone,
    language: Language,
) -> Option<(std::ops::Range<usize>, String)> {
    let total_bytes: usize = texts.clone().map(str::len).sum();
    if total_bytes <= MAX_TOOL_OUTPUT_BYTES {
        return None;
    }

    // Treat text parts as separate blocks. Cut at a nearby line break when one fits,
    // or at a UTF-8 boundary for long lines and compact JSON.
    let mut omitted = HEAD_KEEP_BYTES..total_bytes - TAIL_KEEP_BYTES;
    let mut offset = 0;
    let mut total_lines = 0;
    const NEWLINE_WINDOW: usize = 512;
    for text in texts {
        let end = offset + text.len();
        total_lines += text.lines().count();
        if offset < omitted.start && omitted.start < end {
            let cut = text.floor_char_boundary(omitted.start - offset);
            let window = text.ceil_char_boundary(cut.saturating_sub(NEWLINE_WINDOW));
            omitted.start = offset
                + text[window..cut].rfind('\n').map_or_else(
                    || {
                        cut - usize::from(
                            text[..cut].ends_with('\r') && text[cut..].starts_with('\n'),
                        )
                    },
                    |i| window + i + 1,
                );
        }
        if offset < omitted.end && omitted.end < end {
            let cut = text.ceil_char_boundary(omitted.end - offset);
            let window = text.floor_char_boundary(cut.saturating_add(NEWLINE_WINDOW));
            omitted.end = offset
                + if text[..cut].ends_with('\n') {
                    cut
                } else {
                    text[cut..window].find('\n').map_or(cut, |i| cut + i + 1)
                };
        }
        offset = end;
    }
    let bytes = omitted.len();
    let marker = match language {
        Language::ZH_CN => format!(
            "\n\n[输出已截断。共 {total_bytes} 字节、{total_lines} 行，中间省略 {bytes} 字节。请在 exec 脚本中过滤或切片，或用 grep/sed 读取所需片段。]\n\n"
        ),
        Language::ZH_TW => format!(
            "\n\n[輸出已截斷。共 {total_bytes} 位元組、{total_lines} 行，中間省略 {bytes} 位元組。請在 exec 腳本中篩選或切片，或用 grep/sed 讀取所需片段。]\n\n"
        ),
        _ => {
            let unit = if total_lines == 1 { "line" } else { "lines" };
            format!(
                "\n\n[Output truncated. {total_bytes} bytes, {total_lines} {unit}, {bytes} middle bytes omitted. Filter or slice inside exec, or re-read specific ranges with grep/sed.]\n\n"
            )
        }
    };
    Some((omitted, marker))
}

fn truncate_content(parts: &mut Vec<ContentPart>, language: Language) {
    let texts = parts.iter().filter_map(|part| match part {
        ContentPart::Text { text, .. } => Some(text.as_str()),
        ContentPart::File { .. } => None,
    });
    let Some((omitted, marker)) = truncation(texts, language) else {
        return;
    };
    let mut marker = marker.as_str();
    let mut offset = 0;
    parts.retain_mut(|part| {
        let ContentPart::Text { text, .. } = part else {
            return true;
        };
        let start = offset;
        offset += text.len();
        if offset <= omitted.start || start >= omitted.end {
            return true;
        }
        let head = omitted.start.saturating_sub(start);
        let tail = (omitted.end - start).min(text.len());
        let insert = std::mem::take(&mut marker);
        if head == 0 && tail == text.len() && insert.is_empty() {
            return false;
        }
        *text = format!("{}{insert}{}", &text[..head], &text[tail..]);
        true
    });
}

pub(in crate::owner) fn truncate_tool_output(
    tool_name: &str,
    output: &mut ToolOutput,
    language: Language,
) {
    use crate::owner::discovery::{LIST, READ, WORKER_TOOLS};
    use std::borrow::Cow;
    if matches!(tool_name, READ | LIST) || WORKER_TOOLS.contains(&tool_name) {
        return;
    }
    let text: Cow<'_, str> = match output {
        ToolOutput::Text(s) | ToolOutput::ErrorText(s) => Cow::Borrowed(s),
        ToolOutput::Json(v) | ToolOutput::ErrorJson(v) => Cow::Owned(v.to_string()),
        ToolOutput::Content(parts) => return truncate_content(parts, language),
    };
    if let Some((omitted, marker)) = truncation(std::iter::once(text.as_ref()), language) {
        let preview = format!("{}{marker}{}", &text[..omitted.start], &text[omitted.end..]);
        *output = match output {
            ToolOutput::ErrorText(_) | ToolOutput::ErrorJson(_) => ToolOutput::ErrorText(preview),
            _ => ToolOutput::Text(preview),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovery_truncates_large_worker_tool_outputs_but_exempts_state_tools() {
        use maka_agent_facts::model::prompt::FileData;

        let raw = "012345678\n".repeat(20_000);
        let project = |name, mut output: ToolOutput, language| {
            truncate_tool_output(name, &mut output, language);
            output
        };
        let original = ToolOutput::Text(raw.clone());
        for (language, counts) in [
            (
                Language::EN,
                "200000 bytes, 20000 lines, 191000 middle bytes omitted",
            ),
            (
                Language::ZH_CN,
                "共 200000 字节、20000 行，中间省略 191000 字节",
            ),
            (
                Language::ZH_TW,
                "共 200000 位元組、20000 行，中間省略 191000 位元組",
            ),
        ] {
            let projected = project("Shell", original.clone(), language);
            let ToolOutput::Text(text) = &projected else {
                panic!("expected text")
            };
            assert!(text.starts_with(&raw[..7000]) && text.ends_with(&raw[198000..]));
            assert!(text.contains(counts) && text.contains("exec") && text.contains("grep/sed"));
            assert!(text.len() < 10_000);
            assert_eq!(project("Shell", original.clone(), language), projected);
            assert_eq!(project("Shell", projected.clone(), language), projected);
        }
        for name in [
            "ReadDossier",
            "ListDossiers",
            "UpdateWorkspaceMap",
            "UpdateWatchScope",
            "UpsertDossier",
            "FinishNoChange",
            "DiscoveryComplete",
            "StageArtifact",
            "RegisterWatch",
            "StagePendingAction",
        ] {
            assert_eq!(
                project(name, original.clone(), Language::EN),
                original,
                "{name}"
            );
        }

        let lines = format!(
            "{}\r\n{}\r\n{}",
            "a".repeat(6_900),
            "x".repeat(5_000),
            "z".repeat(1_900)
        );
        let ToolOutput::Text(text) = project("Read", ToolOutput::Text(lines), Language::EN) else {
            panic!("expected text")
        };
        assert!(text.starts_with(&format!("{}\r\n\n\n[", "a".repeat(6_900))));
        assert!(text.contains("13804 bytes, 3 lines, 5002 middle bytes omitted"));
        assert!(text.ends_with(&format!("]\n\n{}", "z".repeat(1_900))));

        let at_limit = ToolOutput::Text("x".repeat(10_000));
        assert_eq!(project("Read", at_limit.clone(), Language::EN), at_limit);
        let long_line = format!("{}!", "界".repeat(3334));
        for language in [Language::EN, Language::ZH_CN, Language::ZH_TW] {
            let ToolOutput::ErrorText(text) =
                project("exec", ToolOutput::ErrorText(long_line.clone()), language)
            else {
                panic!("expected error text")
            };
            assert!(
                text.starts_with(&"界".repeat(2333))
                    && text.ends_with(&format!("{}!", "界".repeat(666)))
            );
            assert!(text.contains("10003") && text.contains("1005") && text.len() < 10_000);
        }
        let value = json!({"key":long_line});
        let encoded = value.to_string();
        for (original, error) in [
            (ToolOutput::Json(value.clone()), false),
            (ToolOutput::ErrorJson(value), true),
        ] {
            let projected = project("Read", original, Language::EN);
            assert_eq!(matches!(projected, ToolOutput::ErrorText(_)), error);
            let (ToolOutput::Text(text) | ToolOutput::ErrorText(text)) = projected else {
                panic!("expected text preview")
            };
            let head = encoded.floor_char_boundary(7_000);
            let tail = encoded.ceil_char_boundary(encoded.len() - 2_000);
            assert!(text.starts_with(&encoded[..head]) && text.ends_with(&encoded[tail..]));
            assert!(text.contains(&format!(
                "{} bytes, 1 line, {} middle bytes omitted",
                encoded.len(),
                tail - head
            )));
        }
        for small in [
            ToolOutput::Json(json!({"ok":true})),
            ToolOutput::ErrorJson(json!({"error":"missing"})),
        ] {
            assert_eq!(project("exec", small.clone(), Language::EN), small);
        }

        let file = ContentPart::File {
            data: FileData::Data("AAA=".into()),
            media_type: "image/png".into(),
            provider_options: Some(json!({"id":"figure"})),
        };
        let text_part = |text: String, id| ContentPart::Text {
            text,
            provider_options: Some(json!({"id":id})),
        };
        let parts = vec![
            file.clone(),
            text_part("a".repeat(8_000), 1),
            file.clone(),
            text_part("m".repeat(200_000), 2),
            file.clone(),
            text_part("z".repeat(8_000), 3),
            file.clone(),
        ];
        let ToolOutput::Content(result) = project("exec", ToolOutput::Content(parts), Language::EN)
        else {
            panic!("expected content")
        };
        let [
            first,
            ContentPart::Text {
                text: head,
                provider_options,
            },
            second,
            third,
            tail,
            last,
        ] = &result[..]
        else {
            panic!("unexpected content part order")
        };
        assert_eq!([first, second, third, last], [&file; 4]);
        assert_eq!(provider_options, &Some(json!({"id":1})));
        assert!(
            head.starts_with(&"a".repeat(7_000))
                && head.contains("216000 bytes, 3 lines, 207000 middle bytes omitted")
        );
        assert_eq!(tail, &text_part("z".repeat(2_000), 3));
        assert!(head.len() + 2_000 < 10_000);
    }

    #[test]
    fn discovery_countdown_and_admission_match_after_replay_at_the_ceiling() {
        for (mode, explore, limit) in [(Mode::FollowUp, 9, 12), (Mode::Onboard, 14, 18)] {
            let mut live = Progress::new(mode);
            let mut cold = Progress::new(mode);
            for n in 1..=limit {
                let step = StepId::new();
                let result = FactId::new();
                live.freeze_next(step);
                for progress in [&mut live, &mut cold] {
                    progress.begin(2 * n, step);
                    let budget = progress.budget(step).unwrap();
                    let rejection = progress.rejection(budget, "Shell", Language::EN);
                    assert_eq!(
                        rejection,
                        (n > explore).then(|| countdown(Language::EN, (limit + 1 - n) as usize))
                    );
                    let args = json!({"command":format!("ls topic/{n}")});
                    let observation = if n <= explore {
                        Observation::success("Shell", Some(&args), Path::new("/work"))
                    } else {
                        Observation::default()
                    };
                    progress.observe(2 * n + 1, observation, Some(result), Language::EN);
                    progress.begin(2 * n, step);
                    assert_eq!(
                        progress.notes.contains_key(&result),
                        n == explore - 2 || (explore..limit).contains(&n)
                    );
                    if (explore..limit).contains(&n) {
                        assert!(
                            progress.notes[&result]
                                .contains(&countdown(Language::EN, (limit - n) as usize))
                        );
                    }
                    assert_eq!(progress.stop(), (n == limit).then_some(StopReason::Ceiling));
                }
                assert_eq!(live.notes.get(&result), cold.notes.get(&result));
            }
        }
    }

    #[test]
    fn discovery_dossier_and_map_writes_cannot_extend_mode_limits() {
        for (mode, limit, wrap) in [
            (Mode::FollowUp, 12, 3),
            (Mode::Wander, 12, 3),
            (Mode::Onboard, 18, 4),
            (Mode::Briefing, 18, 4),
        ] {
            let mut progress = Progress::new(mode);
            for n in 1..=limit {
                let id = StepId::new();
                progress.begin(2 * n, id);
                let step = progress.budget(id).unwrap();
                for (name, allowed_in_wrap_up) in [
                    ("exec", false),
                    ("Shell", false),
                    ("UpsertDossier", true),
                    ("FinishNoChange", true),
                    ("DiscoveryComplete", true),
                    ("RegisterWatch", true),
                    ("StagePendingAction", true),
                    (
                        "UpdateWorkspaceMap",
                        matches!(mode, Mode::Onboard | Mode::Wander),
                    ),
                    ("UpdateWatchScope", mode == Mode::Onboard),
                ] {
                    assert_eq!(
                        progress.rejection(step, name, Language::EN).is_none(),
                        n <= limit - wrap || allowed_in_wrap_up,
                        "{name} at step {n}/{limit}"
                    );
                }
                let write = if mode == Mode::Onboard {
                    "UpdateWorkspaceMap"
                } else {
                    "UpsertDossier"
                };
                progress.observe(
                    2 * n + 1,
                    Observation::success(write, None, Path::new("/")),
                    None,
                    Language::EN,
                );
                assert_eq!(progress.stop(), (n == limit).then_some(StopReason::Ceiling));
            }
        }
    }

    #[test]
    fn discovery_map_and_scope_updates_reset_the_stall_countdown() {
        for (tool, update) in [
            ("UpdateWorkspaceMap", "mark_ready"),
            ("UpdateWorkspaceMap", "mark_verified"),
            ("UpdateWatchScope", "mark_surveyed"),
        ] {
            let mut progress = Progress::new(Mode::Onboard);
            for n in 1..=10 {
                progress.begin(2 * n, StepId::new());
                let args = json!({"action": if n == 5 { update } else { "inspect" }});
                let observation = Observation::success(tool, Some(&args), Path::new("/"));
                progress.observe(2 * n + 1, observation, None, Language::EN);
                assert_eq!(
                    progress.stop(),
                    (n == 10).then_some(StopReason::Stalled),
                    "{tool} {update} at step {n}"
                );
            }
        }
    }

    #[test]
    fn discovery_repeated_no_change_upserts_stall_after_five_unproductive_steps() {
        let mut progress = Progress::new(Mode::FollowUp);
        let args = json!({"topic_id":"release"});
        for n in 1..=6 {
            progress.begin(2 * n, StepId::new());
            let observation = Observation::success("UpsertDossier", Some(&args), Path::new("/"))
                .with_output(
                    "UpsertDossier",
                    &ToolOutput::Json(json!({"material_change":n==1})),
                );
            progress.observe(2 * n + 1, observation, None, Language::EN);
            assert_eq!(progress.stop(), (n == 6).then_some(StopReason::Stalled));
        }
    }

    #[test]
    fn discovery_cell_envelopes_do_not_hide_a_stall_after_repeated_child_evidence() {
        let mut p = Progress::new(Mode::Briefing);
        for n in 1..=8 {
            p.begin(3 * n, StepId::new());
            let url = if n % 2 == 0 {
                "https://example.com:443/a#frag"
            } else {
                "https://EXAMPLE.com/a"
            };
            let child = Observation::success("WebFetch", Some(&json!({"url":url})), Path::new("/"))
                .with_value(&json!({"content":if n<3 {"one"} else {"two"}}));
            p.observe(3 * n + 1, child, None, Language::EN);
            let id = FactId::new();
            let outer = Observation::success(
                if n % 2 == 0 { "exec" } else { "wait" },
                None,
                Path::new("/"),
            )
            .with_value(&json!({"stdout":n}));
            p.observe(3 * n + 2, outer, Some(id), Language::EN);
            assert_eq!(p.notes.contains_key(&id), n == 6);
            assert_eq!(p.stop(), (n == 8).then_some(StopReason::Stalled));
        }
    }

    #[test]
    fn discovery_shell_search_and_catalog_reads_count_as_distinct_targets_only_once() {
        let mut distinct = Progress::new(Mode::Briefing);
        let calls = [
            ("ListDossiers", json!({})),
            ("SessionList", json!({})),
            ("DiscoveryMemory", json!({})),
            ("Shell", json!({"command": "git status --short"})),
            (
                "Shell",
                json!({"command": "git rev-list --count HEAD", "cwd": "repo"}),
            ),
            ("WebSearch", json!({"query": "apache maka pr 7265"})),
            ("Recall", json!({"query": "migration 0056"})),
            ("SessionRead", json!({"sessionId": "session-1"})),
        ];
        for (idx, (tool, args)) in calls.iter().enumerate() {
            let n = (idx + 1) as u64;
            distinct.begin(2 * n, StepId::new());
            let obs = Observation::success(tool, Some(args), Path::new("/work"))
                .with_value(&json!({"stdout": "same"}));
            distinct.observe(2 * n + 1, obs, None, Language::EN);
            assert_eq!(distinct.stop(), None);
        }

        let mut repeated = Progress::new(Mode::FollowUp);
        for n in 1..=6u64 {
            repeated.begin(2 * n, StepId::new());
            let obs = Observation::success(
                "Shell",
                Some(&json!({"command": "git status", "cwd": "./sub/../sub"})),
                Path::new("/work"),
            )
            .with_value(&json!({"stdout": "clean"}));
            repeated.observe(2 * n + 1, obs, None, Language::EN);
            assert_eq!(repeated.stop(), (n == 6).then_some(StopReason::Stalled));
        }
    }
}
