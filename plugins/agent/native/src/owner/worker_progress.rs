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

use crate::contract::{WorkerProgress, WorkerProgressKind as Kind};
use maka_agent_facts::{
    durable::ExecutionIdentity,
    executor::Output,
    interaction::{InteractionRecord, InteractionRequest},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::watch;

pub(crate) type Rows = BTreeMap<String, WorkerProgress>;
#[derive(Default)]
pub(crate) struct Group {
    pub rows: watch::Sender<Rows>,
    sequence: std::sync::atomic::AtomicU64,
}
#[derive(Default)]
pub(crate) struct Registry(Mutex<BTreeMap<String, Weak<Group>>>);
impl Registry {
    pub fn group(&self, id: &str) -> Arc<Group> {
        let mut groups = self.0.lock().unwrap();
        if let Some(group) = groups.get(id).and_then(Weak::upgrade) {
            return group;
        }
        groups.retain(|_, g| g.strong_count() != 0);
        let group = Arc::new(Group::default());
        groups.insert(id.to_owned(), Arc::downgrade(&group));
        group
    }
}

type Hint = (Kind, String);
pub(super) struct RunningTool {
    id: String,
    hint: Hint,
    // A provider TodoWrite takes effect only on a successful tool result.
    todo: Option<TodoWrite>,
}
#[derive(Default)]
struct State {
    sequence: u64,
    waits: BTreeMap<String, Kind>,
    tools: Vec<RunningTool>,
    todo: Option<String>,
    commentary: Option<String>,
    phase: Kind,
}
impl State {
    fn current(&self) -> (Kind, &str) {
        if let Some(kind) = self.waits.values().next() {
            return (*kind, "");
        }
        if let Some(tool) = self.tools.last() {
            return (tool.hint.0, &tool.hint.1);
        }
        if let Some(text) = self.todo.as_deref().or(self.commentary.as_deref()) {
            return (Kind::Summary, text);
        }
        (self.phase, "")
    }
}
pub(crate) fn short(text: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    let mut count = 0;
    for ch in text.chars() {
        if matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
            continue;
        }
        if ch.is_whitespace() || ch.is_control() {
            space = !out.is_empty();
            continue;
        }
        if count + usize::from(space) >= 48 {
            out.push('…');
            break;
        }
        if space {
            out.push(' ');
            count += 1;
            space = false;
        }
        out.push(ch);
        count += 1;
    }
    out
}

pub(crate) struct Run {
    group: Arc<Group>,
    execution: ExecutionIdentity,
    state: Mutex<State>,
}
impl Run {
    pub fn new(group: Arc<Group>, execution: ExecutionIdentity) -> Arc<Self> {
        let mut state = State::default();
        group.rows.send_modify(|rows| {
            state.sequence = group
                .sequence
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            rows.insert(
                execution.session_id.clone(),
                WorkerProgress {
                    session_id: execution.session_id.clone(),
                    run_id: execution.run_id,
                    seq: state.sequence,
                    kind: Kind::Working,
                    detail: String::new(),
                },
            );
        });
        Arc::new(Self {
            group,
            execution,
            state: Mutex::new(state),
        })
    }
    fn update(&self, edit: impl FnOnce(&mut State)) {
        let mut state = self.state.lock().unwrap();
        edit(&mut state);
        self.publish(&mut state);
    }
    fn publish(&self, state: &mut State) {
        self.group.rows.send_if_modified(|rows| {
            let Some(row) = rows.get_mut(&self.execution.session_id) else {
                return false;
            };
            let (kind, detail) = state.current();
            if row.run_id != self.execution.run_id
                || row.seq != state.sequence
                || (row.kind == kind && row.detail == detail)
            {
                return false;
            }
            row.kind = kind;
            row.detail = detail.to_owned();
            row.seq = self
                .group
                .sequence
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            state.sequence = row.seq;
            true
        });
    }
    pub fn phase(&self, phase: Kind) {
        let mut state = self.state.lock().unwrap();
        if state.phase != phase {
            state.phase = phase;
            self.publish(&mut state);
        }
    }
    pub fn todo(&self, text: Option<String>) {
        self.update(|s| s.todo = text);
    }
    pub fn commentary(&self, chars: impl Iterator<Item = char>) {
        let prefix: String = chars.take(96).collect();
        let mut chars = prefix.char_indices().peekable();
        let mut end = prefix.len();
        while let Some((i, ch)) = chars.next() {
            if matches!(ch, '。' | '！' | '？')
                || (matches!(ch, '.' | '!' | '?')
                    && chars.peek().is_none_or(|(_, next)| next.is_whitespace()))
            {
                end = i + ch.len_utf8();
                break;
            }
        }
        let sentence = short(&prefix[..end]);
        if sentence.chars().any(char::is_alphanumeric) {
            self.update(|s| s.commentary = Some(sentence));
        }
    }
    pub fn interaction(&self, record: &InteractionRecord) {
        self.update(|s| {
            if record.outcome.is_some() {
                s.waits.remove(&record.request_id);
                return;
            }
            let kind = match record.request {
                InteractionRequest::SessionApproval { .. }
                | InteractionRequest::ServiceApproval { .. } => Kind::Approval,
                InteractionRequest::Question { .. } => Kind::Question,
                InteractionRequest::Form { .. } => Kind::Form,
                _ => Kind::Permission,
            };
            s.waits.insert(record.request_id.clone(), kind);
        });
    }
    pub fn start(&self, id: &str, name: &str, input: &Value) {
        self.start_tool(RunningTool {
            id: id.into(),
            hint: tool(name, input),
            todo: None,
        });
    }
    fn start_tool(&self, tool: RunningTool) {
        self.update(|s| {
            if let Some(existing) = s.tools.iter_mut().find(|active| active.id == tool.id) {
                *existing = tool;
            } else {
                s.tools.push(tool);
            }
        });
    }
    pub fn finish(&self, id: &str) {
        self.finish_tool(id, false);
    }
    fn finish_tool(&self, id: &str, success: bool) {
        self.update(|s| {
            if let Some(index) = s.tools.iter().position(|tool| tool.id == id) {
                let tool = s.tools.remove(index);
                if success && let Some(todo) = tool.todo {
                    s.todo = todo.current;
                }
            }
        });
    }
    pub(super) fn observe(&self, event: ExecutorProgress) {
        match event {
            ExecutorProgress::Phase(phase) => self.phase(phase),
            ExecutorProgress::Start(tool) => self.start_tool(tool),
            ExecutorProgress::Finish(id, success) => self.finish_tool(&id, success),
        }
    }
    #[cfg(test)]
    fn output(&self, out: &Output) {
        if let Some(event) = ExecutorProgress::from_output(out) {
            self.observe(event);
        }
    }
}
struct TodoWrite {
    current: Option<String>,
}
pub(super) enum ExecutorProgress {
    Phase(Kind),
    Start(RunningTool),
    Finish(String, bool),
}
impl ExecutorProgress {
    pub fn from_output(output: &Output) -> Option<Self> {
        Some(match output {
            Output::OutputDelta { .. } => Self::Phase(Kind::Generating),
            Output::ThinkingDelta { .. } => Self::Phase(Kind::Thinking),
            Output::ToolStart {
                tool_call_id,
                name,
                input,
            } => {
                let todo = if name == "TodoWrite" {
                    input["todos"].as_array().map(|items| TodoWrite {
                        current: items
                            .iter()
                            .find(|item| item["status"] == "in_progress")
                            .and_then(|item| {
                                item["activeForm"]
                                    .as_str()
                                    .or_else(|| item["content"].as_str())
                            })
                            .map(short)
                            .filter(|text| !text.is_empty()),
                    })
                } else {
                    None
                };
                Self::Start(RunningTool {
                    id: tool_call_id.clone(),
                    hint: tool(name, input),
                    todo,
                })
            }
            Output::ToolResult {
                tool_call_id,
                is_error,
                ..
            } => Self::Finish(tool_call_id.clone(), !is_error),
            _ => return None,
        })
    }
}
pub(super) struct ActiveTool {
    run: Weak<Run>,
    id: String,
}
impl Drop for ActiveTool {
    fn drop(&mut self) {
        if let Some(run) = self.run.upgrade() {
            run.finish(&self.id);
        }
    }
}
impl Run {
    pub(super) fn track(self: &Arc<Self>, id: String, hint: Hint) -> ActiveTool {
        self.start_tool(RunningTool {
            id: id.clone(),
            hint,
            todo: None,
        });
        ActiveTool {
            run: Arc::downgrade(self),
            id,
        }
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        let seq = self.state.get_mut().unwrap().sequence;
        self.group.rows.send_if_modified(|rows| {
            if rows
                .get(&self.execution.session_id)
                .is_some_and(|r| r.run_id == self.execution.run_id && r.seq == seq)
            {
                rows.remove(&self.execution.session_id);
                true
            } else {
                false
            }
        });
    }
}
pub(super) fn tool(name: &str, input: &Value) -> Hint {
    for key in ["toolSummary", "description", "Description", "title"] {
        if let Some(text) = input[key].as_str().map(short).filter(|s| !s.is_empty()) {
            return (Kind::Summary, text);
        }
    }
    use maka_agent_ports::session::history::ExternalToolTarget;
    let (_, target) = crate::service::delivery::executor_tool_display(
        if name == "Shell" { "shell" } else { name },
        input,
    );
    match target {
        Some(ExternalToolTarget::Command { command, .. }) => (Kind::Command, short(&command)),
        Some(ExternalToolTarget::File { path }) => (
            if matches!(
                name,
                "Read" | "view_file" | "read_file" | "list_dir" | "Glob" | "find_by_name"
            ) {
                Kind::Read
            } else {
                Kind::Edit
            },
            short(path.rsplit(['/', '\\']).next().unwrap_or(&path)),
        ),
        Some(ExternalToolTarget::Search { query }) => {
            (Kind::Tool, short(&format!("{name} {query}")))
        }
        None if name == "fileChange" => {
            let path = input["changes"]
                .as_array()
                .and_then(|changes| changes.first())
                .and_then(|change| change["path"].as_str());
            match path {
                Some(path) => (
                    Kind::Edit,
                    short(&format!(
                        "{}…",
                        path.rsplit(['/', '\\']).next().unwrap_or(path)
                    )),
                ),
                None => (Kind::Working, String::new()),
            }
        }
        _ => (Kind::Tool, short(name)),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use maka_agent_facts::{durable::RunId, interaction::InteractionOutcome};
    use serde_json::json;
    fn execution() -> ExecutionIdentity {
        ExecutionIdentity {
            session_id: "child".into(),
            turn_id: "turn".into(),
            run_id: RunId::new(),
        }
    }
    pub(crate) fn worker() -> (Arc<Run>, watch::Receiver<Rows>) {
        let group = Arc::new(Group::default());
        let rows = group.rows.subscribe();
        (Run::new(group, execution()), rows)
    }

    impl maka_agent_ports::executor::OutputSink for Run {
        fn emit(
            &self,
            output: Output,
        ) -> futures_util::future::BoxFuture<'_, Result<(), maka_agent_ports::executor::Error>>
        {
            self.output(&output);
            Box::pin(async { Ok(()) })
        }
        fn commentary(&self, text: &str) {
            self.commentary(text.chars());
        }
        fn current_plan_item(&self, item: Option<&str>) {
            self.todo(item.map(short));
        }
    }
    #[test]
    fn native_and_executor_tools_fall_back_without_output_noise() {
        let registry = Registry::default();
        let group = registry.group("bot");
        let run = Run::new(group.clone(), execution());
        let mut rx = group.rows.subscribe();
        run.phase(Kind::Thinking);
        run.commentary("Checking the build. Another sentence.".chars());
        for (input, expected) in [
            (
                "Testing v1.2 in src/main.rs. More",
                "Testing v1.2 in src/main.rs.",
            ),
            ("运行测试", "运行测试"),
            ("...", "运行测试"),
        ] {
            run.commentary(input.chars());
            assert_eq!(rx.borrow()["child"].detail, expected);
        }
        run.todo(Some("Full test suite".into()));
        let native = run.track(
            "native".into(),
            tool("Shell", &json!({"command":"cargo test"})),
        );
        for (name, input, kind, text) in [
            (
                "fileChange",
                json!({"changes":[{"path":"src/ui.ts"}]}),
                Kind::Edit,
                "ui.ts",
            ),
            (
                "run_command",
                json!({"CommandLine":"cargo fmt","toolSummary":"Checking format"}),
                Kind::Summary,
                "Checking format",
            ),
            (
                "WebSearch",
                json!({"query":"rust"}),
                Kind::Tool,
                "WebSearch rust",
            ),
            (
                "fileChange",
                json!({"changes":[{"path":"src/a.rs"},{"path":"b"}]}),
                Kind::Edit,
                "a.rs…",
            ),
            ("Bash", json!({"command":"pwd"}), Kind::Command, "pwd"),
        ] {
            run.output(&Output::ToolStart {
                tool_call_id: "external".into(),
                name: name.into(),
                input,
            });
            {
                let rows = rx.borrow_and_update();
                assert_eq!(
                    (rows["child"].kind, rows["child"].detail.as_str()),
                    (kind, text)
                );
            }
            for _ in 0..200 {
                run.output(&Output::ToolProgress {
                    tool_call_id: "external".into(),
                    text: "stdout".into(),
                });
                run.output(&Output::OutputDelta {
                    message_id: "msg".into(),
                    text: "token".into(),
                });
            }
            assert!(!rx.has_changed().unwrap());
            run.output(&Output::ToolResult {
                tool_call_id: "external".into(),
                is_error: false,
                text: "result".into(),
                details: None,
            });
            assert_eq!(rx.borrow()["child"].detail, "cargo test");
        }
        let mut record = InteractionRecord {
            execution: run.execution.clone(),
            request_id: "q".into(),
            created_at: 0,
            request: InteractionRequest::Question {
                tool_use_id: "ask".into(),
                questions: vec![],
            },
            outcome: None,
        };
        run.interaction(&record);
        assert_eq!(rx.borrow()["child"].kind, Kind::Question);
        record.outcome = Some(InteractionOutcome::QuestionAnswer {
            answers: vec![],
            committed_at: 1,
        });
        run.interaction(&record);
        assert_eq!(rx.borrow()["child"].kind, Kind::Command);
        drop(native);
        assert_eq!(rx.borrow()["child"].detail, "Full test suite");
        run.todo(None);
        assert_eq!(rx.borrow()["child"].detail, "运行测试");
        for success in [false, true] {
            run.output(&Output::ToolStart {
                tool_call_id: "plan".into(), name: "TodoWrite".into(), input: json!({
                    "todos": [{"status": "in_progress", "content": "test", "activeForm": "Running tests"}]
                }),
            });
            run.output(&Output::ToolResult {
                tool_call_id: "plan".into(),
                is_error: !success,
                text: String::new(),
                details: None,
            });
            assert_eq!(
                rx.borrow()["child"].detail,
                if success {
                    "Running tests"
                } else {
                    "运行测试"
                }
            );
        }
        let replacement = Run::new(group, execution());
        let _late = run.track("late".into(), tool("Bash", &json!({"command":"late"})));
        drop(run);
        assert_eq!(rx.borrow()["child"].run_id, replacement.execution.run_id);
        assert_eq!(rx.borrow()["child"].kind, Kind::Working);
        assert!(registry.group("other").rows.borrow().is_empty());
        drop(replacement);
        assert!(rx.borrow().is_empty());
    }
}
