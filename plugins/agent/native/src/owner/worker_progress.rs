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
#[derive(Default)]
struct State {
    sequence: u64,
    waits: BTreeMap<String, Kind>,
    tools: Vec<(String, Hint)>,
    todo: Option<String>,
    commentary: Option<String>,
    phase: Kind,
}
impl State {
    fn current(&self) -> (Kind, &str) {
        if let Some(kind) = self.waits.values().next() {
            return (*kind, "");
        }
        if let Some((_, (kind, detail))) = self.tools.last() {
            return (*kind, detail);
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
        let sequence = group
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        group.rows.send_modify(|rows| {
            rows.insert(
                execution.session_id.clone(),
                WorkerProgress {
                    session_id: execution.session_id.clone(),
                    run_id: execution.run_id,
                    seq: sequence,
                    kind: Kind::Working,
                    detail: String::new(),
                },
            );
        });
        Arc::new(Self {
            group,
            execution,
            state: Mutex::new(State {
                sequence,
                ..State::default()
            }),
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
    pub fn commentary(&self, text: String) {
        if !text.is_empty() {
            self.update(|s| s.commentary = Some(text));
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
        self.start_hint(id, tool(name, input));
    }
    fn start_hint(&self, id: &str, hint: Hint) {
        self.update(|s| {
            s.tools.retain(|(key, _)| key != id);
            s.tools.push((id.to_owned(), hint));
        });
    }
    pub fn finish(&self, id: &str) {
        self.update(|s| s.tools.retain(|(key, _)| key != id));
    }
    pub(super) fn observe(&self, event: ExecutorProgress) {
        match event {
            ExecutorProgress::Phase(phase) => self.phase(phase),
            ExecutorProgress::Start(id, hint) => self.start_hint(&id, hint),
            ExecutorProgress::Finish(id) => self.finish(&id),
        }
    }
    #[cfg(test)]
    fn output(&self, out: &Output) {
        if let Some(event) = ExecutorProgress::from_output(out) {
            self.observe(event);
        }
    }
}
pub(super) enum ExecutorProgress {
    Phase(Kind),
    Start(String, Hint),
    Finish(String),
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
            } => Self::Start(tool_call_id.clone(), tool(name, input)),
            Output::ToolResult { tool_call_id, .. } => Self::Finish(tool_call_id.clone()),
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
    pub(super) fn prepare_tool(
        self: &Arc<Self>,
        id: String,
        name: &str,
        input: &Value,
    ) -> impl FnOnce() -> ActiveTool + use<> {
        let hint = tool(name, input);
        let run = Arc::downgrade(self);
        move || {
            if let Some(current) = run.upgrade() {
                current.start_hint(&id, hint);
            }
            ActiveTool { run, id }
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
fn tool(name: &str, input: &Value) -> Hint {
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
        _ => (Kind::Tool, short(name)),
    }
}

#[cfg(test)]
mod tests {
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
    #[test]
    fn native_and_executor_tools_fall_back_without_output_noise() {
        let registry = Registry::default();
        let group = registry.group("bot");
        let run = Run::new(group.clone(), execution());
        let mut rx = group.rows.subscribe();
        run.phase(Kind::Thinking);
        run.commentary("Checking the build.".into());
        run.todo(Some("Full test suite".into()));
        run.start("native", "Shell", &json!({"command":"cargo test"}));
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
        run.finish("native");
        assert_eq!(rx.borrow()["child"].detail, "Full test suite");
        run.todo(None);
        assert_eq!(rx.borrow()["child"].detail, "Checking the build.");
        let replacement = Run::new(group, execution());
        run.start("late", "Bash", &json!({"command":"late"}));
        drop(run);
        assert_eq!(rx.borrow()["child"].run_id, replacement.execution.run_id);
        assert_eq!(rx.borrow()["child"].kind, Kind::Working);
        assert!(registry.group("other").rows.borrow().is_empty());
        drop(replacement);
        assert!(rx.borrow().is_empty());
    }
}
