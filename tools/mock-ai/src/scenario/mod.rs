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

//! Deterministic canonical semantic scenario engine for fair multi-harness benchmarking.

pub mod tools;

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::handler::{HandlerFuture, TurnContext, TurnDecision, TurnHandler};
use crate::plan::{
    CompactionOutput, FinishReason, HttpErrorSpec, ToolCallPayload, ToolCallSpec, TurnEvent,
    TurnPlan,
};
use crate::protocol::{NormalizedMessageKind, NormalizedRequest, NormalizedRole, Protocol};
use crate::schema_synth::{
    context_overflow_error, overloaded_error, payload_too_large_error,
    previous_response_not_found_error, rate_limit_error,
};

use self::tools::{
    BadBinding, Binding, CallPayload, EditHunk, ToolAction, ToolBindError, ToolCatalog,
    ValidatorCache, shell_quote,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BenchmarkTrack {
    Native,
    SharedMcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSpec {
    pub version: u32,
    pub scenario: String,
    pub seed: u64,
    pub fixture: String,
    pub track: BenchmarkTrack,
    pub steps: Vec<ScenarioStep>,
    #[serde(default)]
    pub faults: Vec<ScheduledFault>,
    #[serde(default)]
    pub fixtures: BTreeMap<String, FixtureDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioStep {
    pub id: String,
    #[serde(flatten)]
    pub action: CanonicalAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CanonicalAction {
    ReadFile {
        path: String,
        expect_marker: String,
    },
    WriteFile {
        path: String,
        content: String,
    },
    EditFile {
        path: String,
        old: String,
        new: String,
    },
    Shell {
        command_id: String,
        #[serde(default)]
        command: String,
    },
    ParallelBatch(Vec<CanonicalAction>),
    LargeOutput {
        fixture: String,
        bytes: usize,
    },
    BadToolCall {
        mode: BadToolMode,
        expect_handling: FailureHandling,
    },
    UnknownTool {
        name: String,
        expect_handling: FailureHandling,
    },
    TriggerCompaction {
        mode: CompactionMode,
        proof_marker: String,
    },
    FinalAnswer {
        text: String,
        #[serde(default)]
        expect_markers: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FixtureDef {
    File { path: String, content: String },
    Command { command: String },
    LargeOutput { pattern: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BadToolMode {
    MissingRequired,
    WrongType,
    MalformedJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureHandling {
    ToolError,
    ProtocolRejection,
    HarnessTermination,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerObservationKind {
    ProtocolRejection,
    HarnessTermination,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerObservation {
    pub session_id: String,
    pub attempt: u32,
    pub call_id: String,
    pub kind: RunnerObservationKind,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CompactionMode {
    Native,
    ContextOverflow {
        actual_bytes: usize,
        limit_bytes: usize,
    },
    Prompt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledFault {
    pub step: String,
    pub attempt: u32,
    #[serde(default)]
    pub at: FaultBoundary,
    pub emit: FaultKind,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FaultBoundary {
    #[default]
    BeforeHeaders,
    AfterFirstCompleteCall,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FaultKind {
    Http429,
    Http503,
    PayloadTooLarge,
    PreviousResponseNotFound,
    Eof,
    Disconnect,
}

#[derive(Debug, thiserror::Error)]
pub enum ScenarioSpecError {
    #[error("invalid scenario: {0}")]
    Invalid(String),
    #[error("invalid JSON scenario: {0}")]
    Json(#[from] serde_json::Error),
    #[cfg(feature = "rules")]
    #[error("invalid YAML scenario: {0}")]
    Yaml(String),
}

impl ScenarioSpec {
    pub fn new(
        scenario: impl Into<String>,
        seed: u64,
        fixture: impl Into<String>,
        track: BenchmarkTrack,
    ) -> Self {
        Self {
            version: 1,
            scenario: scenario.into(),
            seed,
            fixture: fixture.into(),
            track,
            steps: Vec::new(),
            faults: Vec::new(),
            fixtures: BTreeMap::new(),
        }
    }

    pub fn with_step(mut self, id: impl Into<String>, action: CanonicalAction) -> Self {
        self.steps.push(ScenarioStep {
            id: id.into(),
            action,
        });
        self
    }

    pub fn with_fault(mut self, fault: ScheduledFault) -> Self {
        self.faults.push(fault);
        self
    }

    pub fn with_fixture(mut self, id: impl Into<String>, fixture: FixtureDef) -> Self {
        self.fixtures.insert(id.into(), fixture);
        self
    }

    pub fn from_json_str(source: &str) -> Result<Self, ScenarioSpecError> {
        let spec: Self = serde_json::from_str(source)?;
        spec.validate()?;
        Ok(spec)
    }

    #[cfg(feature = "rules")]
    pub fn from_yaml_str(source: &str) -> Result<Self, ScenarioSpecError> {
        let mut docs = yaml_rust2::YamlLoader::load_from_str(source)
            .map_err(|error| ScenarioSpecError::Yaml(error.to_string()))?;
        if docs.len() != 1 {
            return Err(ScenarioSpecError::Yaml("expected one YAML document".into()));
        }
        let spec: Self = serde_json::from_value(yaml_value(docs.remove(0))?)?;
        spec.validate()?;
        Ok(spec)
    }

    pub fn validate(&self) -> Result<(), ScenarioSpecError> {
        self.compile().map(drop)
    }

    fn compile(&self) -> Result<CompiledSpec, ScenarioSpecError> {
        use CanonicalAction as Action;
        let invalid = |message: &str| ScenarioSpecError::Invalid(message.into());
        if self.version != 1 || self.scenario.trim().is_empty() || self.fixture.trim().is_empty() {
            return Err(invalid(
                "expected version 1 and nonempty scenario and fixture names",
            ));
        }
        if !matches!(
            self.steps.last().map(|step| &step.action),
            Some(Action::FinalAnswer { .. })
        ) {
            return Err(invalid("the last step must be a final answer"));
        }

        let mut files = BTreeMap::new();
        for (id, fixture) in &self.fixtures {
            if id.trim().is_empty() {
                return Err(invalid("empty fixture ID"));
            }
            match fixture {
                FixtureDef::File { path, content } => {
                    if !valid_path(path) || files.insert(path.as_str(), content.clone()).is_some() {
                        return Err(invalid(&format!(
                            "invalid or duplicate fixture file path {path:?}"
                        )));
                    }
                }
                FixtureDef::Command { command }
                    if command.trim().is_empty() || command.contains('\0') =>
                {
                    return Err(invalid(&format!("empty or invalid command fixture {id:?}")));
                }
                FixtureDef::LargeOutput { pattern }
                    if pattern.is_empty() || pattern.contains('\0') =>
                {
                    return Err(invalid(&format!(
                        "empty or invalid large-output pattern {id:?}"
                    )));
                }
                _ => {}
            }
        }

        let mut step_ids = HashMap::new();
        let mut edit_hunks = Vec::with_capacity(self.steps.len());
        for (index, step) in self.steps.iter().enumerate() {
            if step.id.trim().is_empty() || step_ids.insert(step.id.as_str(), index).is_some() {
                return Err(invalid(&format!(
                    "empty or duplicate step ID {:?}",
                    step.id
                )));
            }
            let fail = |message: &str| invalid(&format!("step {:?}: {message}", step.id));
            let actions = match &step.action {
                Action::ParallelBatch(actions) if !actions.is_empty() => actions.as_slice(),
                Action::ParallelBatch(_) => return Err(fail("empty parallel batch")),
                _ => std::slice::from_ref(&step.action),
            };
            if matches!(step.action, Action::ParallelBatch(_)) {
                let mut paths = HashMap::new();
                for action in actions {
                    let access = match action {
                        Action::ReadFile { path, .. } => Some((path, false)),
                        Action::WriteFile { path, .. } | Action::EditFile { path, .. } => {
                            Some((path, true))
                        }
                        Action::Shell { .. } | Action::LargeOutput { .. } => None,
                        _ => {
                            return Err(fail(
                                "parallel batch allows only independent file, shell and output actions",
                            ));
                        }
                    };
                    if let Some((path, writes)) = access
                        && let Some(previous_writes) = paths.insert(path, writes)
                        && (writes || previous_writes)
                    {
                        return Err(fail(&format!("parallel file access conflicts at {path:?}")));
                    }
                }
            }
            let mut hunks = BTreeMap::new();
            for (slot, action) in actions.iter().enumerate() {
                match action {
                    Action::ReadFile {
                        path,
                        expect_marker,
                    } => {
                        if !valid_path(path)
                            || expect_marker.is_empty()
                            || !files
                                .get(path.as_str())
                                .is_some_and(|content| content.contains(expect_marker))
                        {
                            return Err(fail(&format!(
                                "read fixture {path:?} is missing its expected marker"
                            )));
                        }
                    }
                    Action::WriteFile { path, content } => {
                        if !valid_path(path) {
                            return Err(fail(&format!("invalid write path {path:?}")));
                        }
                        files.insert(path, content.clone());
                    }
                    Action::EditFile { path, old, new } => {
                        let content = files.get_mut(path.as_str()).ok_or_else(|| {
                            fail(&format!("edit references missing fixture file {path:?}"))
                        })?;
                        let hunk = EditHunk::new(content, old, new)
                            .map_err(|err| fail(&err.to_string()))?;
                        *content = content.replacen(old, new, 1);
                        hunks.insert(slot, hunk);
                    }
                    Action::Shell {
                        command_id,
                        command,
                    } => match self.fixtures.get(command_id) {
                        Some(FixtureDef::Command { command: fixture })
                            if command.is_empty() || command == fixture => {}
                        _ => {
                            return Err(fail(&format!(
                                "missing or mismatched command fixture {command_id:?}"
                            )));
                        }
                    },
                    Action::LargeOutput { fixture, bytes } => {
                        if *bytes == 0
                            || !matches!(
                                self.fixtures.get(fixture),
                                Some(FixtureDef::LargeOutput { .. })
                            )
                        {
                            return Err(fail(&format!(
                                "missing large-output fixture or invalid size: {fixture:?}"
                            )));
                        }
                    }
                    Action::UnknownTool { name, .. }
                        if name.is_empty()
                            || !name
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
                    {
                        return Err(fail("unknown tool name must be a nonempty tool identifier"));
                    }
                    Action::TriggerCompaction { proof_marker, mode } => {
                        if proof_marker.trim().is_empty()
                            || matches!(mode, CompactionMode::ContextOverflow { actual_bytes, limit_bytes } if actual_bytes <= limit_bytes)
                        {
                            return Err(fail("invalid compaction marker or context limit"));
                        }
                    }
                    Action::FinalAnswer {
                        text,
                        expect_markers,
                    } => {
                        if index + 1 != self.steps.len()
                            || text.trim().is_empty()
                            || expect_markers
                                .iter()
                                .any(|marker| marker.is_empty() || !text.contains(marker))
                        {
                            return Err(fail(
                                "final answer must be last and contain every expected marker",
                            ));
                        }
                    }
                    Action::BadToolCall { .. } | Action::UnknownTool { .. } => {}
                    Action::ParallelBatch(_) => unreachable!("nested batches rejected above"),
                }
            }
            edit_hunks.push(hunks);
        }

        let mut faults = HashMap::new();
        for fault in &self.faults {
            let step = *step_ids.get(fault.step.as_str()).ok_or_else(|| {
                invalid(&format!("fault references unknown step {:?}", fault.step))
            })?;
            if fault.attempt == 0
                || faults
                    .insert((step, fault.attempt), (fault.at, fault.emit))
                    .is_some()
            {
                return Err(invalid(&format!(
                    "invalid or duplicate fault attempt for {:?}",
                    fault.step
                )));
            }
            let action = &self.steps[step].action;
            let streams = matches!(fault.emit, FaultKind::Eof | FaultKind::Disconnect);
            if fault.at == FaultBoundary::AfterFirstCompleteCall
                && (!streams
                    || matches!(
                        action,
                        Action::FinalAnswer { .. } | Action::TriggerCompaction { .. }
                    ))
            {
                return Err(invalid(&format!(
                    "fault cannot fire after a tool call in {:?}",
                    fault.step
                )));
            }
        }
        Ok(CompiledSpec { edit_hunks, faults })
    }
}

#[cfg(feature = "rules")]
fn yaml_value(value: yaml_rust2::Yaml) -> Result<Value, ScenarioSpecError> {
    use yaml_rust2::Yaml;
    match value {
        Yaml::Null => Ok(Value::Null),
        Yaml::Boolean(value) => Ok(Value::Bool(value)),
        Yaml::Integer(value) => Ok(value.into()),
        Yaml::String(value) => Ok(value.into()),
        Yaml::Real(value) => Ok(serde_json::from_str(&value)?),
        Yaml::Array(items) => items.into_iter().map(yaml_value).collect(),
        Yaml::Hash(entries) => entries
            .into_iter()
            .map(|(key, value)| {
                let Yaml::String(key) = key else {
                    return Err(ScenarioSpecError::Yaml("expected a string key".into()));
                };
                Ok((key, yaml_value(value)?))
            })
            .collect::<Result<serde_json::Map<_, _>, _>>()
            .map(Value::Object),
        _ => Err(ScenarioSpecError::Yaml("unsupported YAML value".into())),
    }
}

struct CompiledSpec {
    edit_hunks: Vec<BTreeMap<usize, EditHunk>>,
    faults: HashMap<(usize, u32), (FaultBoundary, FaultKind)>,
}

pub(crate) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\0', '\r', '\n', '\\', ':'])
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

pub(crate) fn digest<T: Hash + ?Sized>(value: &T) -> u64 {
    let mut hash = std::hash::DefaultHasher::new();
    value.hash(&mut hash);
    hash.finish()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Revision(pub usize);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RequestKey {
    pub parent_revision: Revision,
    pub turn_boundary_key: u64,
    pub pending_call_ids_digest: u64,
    pub constraint_digest: u64,
}

#[derive(Debug)]
pub struct IssuedDecision {
    pub revision: Revision,
    pub request_key: RequestKey,
    pub response_id: String,
    pub calls: Vec<IssuedCall>,
    pub recipe: PlanRecipe,
}

#[derive(Debug)]
pub struct IssuedCall {
    pub call_id: String,
    pub item_id: String,
    pub tool_name: String,
    pub namespace: Option<String>,
    pub slots: Vec<usize>,
}

#[derive(Debug)]
pub struct PlanRecipe {
    step: usize,
    kind: PlanKind,
}

impl PlanRecipe {
    pub fn step_index(&self) -> usize {
        self.step
    }
}

#[derive(Debug)]
enum PlanKind {
    Tools(Vec<Binding>),
    BadTool(BadBinding),
    UnknownTool,
    Checkpoint,
    Final,
}

#[derive(Debug, Clone)]
pub enum ScenarioSessionState {
    AwaitingInput,
    AwaitingReceipts(PendingBatch),
    AwaitingRunnerObservation {
        revision: Revision,
        kind: RunnerObservationKind,
    },
    AwaitingCheckpoint(PendingCheckpoint),
    FinalIssued(FinalReceipt),
    Verified(CompletionProof),
    RunnerTerminated {
        revision: Revision,
    },
}

#[derive(Debug, Clone)]
pub struct PendingBatch {
    pub revision: Revision,
    pub outstanding: usize,
}

#[derive(Debug, Clone)]
pub struct PendingCheckpoint {
    pub revision: Revision,
    pub checkpoint_id: String,
    pub proof_marker: String,
    pub evidence_kind: CheckpointEvidenceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointEvidenceKind {
    NativeCompaction,
    ClientSummary,
}

impl From<CompactionMode> for CheckpointEvidenceKind {
    fn from(mode: CompactionMode) -> Self {
        match mode {
            CompactionMode::Native => Self::NativeCompaction,
            CompactionMode::ContextOverflow { .. } | CompactionMode::Prompt => Self::ClientSummary,
        }
    }
}

impl FailureHandling {
    fn runner_observation(self) -> Option<RunnerObservationKind> {
        match self {
            Self::ToolError => None,
            Self::ProtocolRejection => Some(RunnerObservationKind::ProtocolRejection),
            Self::HarnessTermination => Some(RunnerObservationKind::HarnessTermination),
        }
    }
}

#[derive(Debug, Clone)]
pub struct FinalReceipt {
    pub revision: Revision,
    pub response_id: String,
}

#[derive(Debug, Clone)]
pub struct CompletionProof {
    pub response_id: String,
    pub observed_markers: BTreeSet<String>,
}

#[derive(Debug)]
pub struct ScenarioEvaluation {
    pub decision: Arc<IssuedDecision>,
    pub attempt: u32,
    pub replayed: bool,
    pub confirmed_call_ids: Vec<String>,
    pub adopted_checkpoint_id: Option<String>,
    pub fault: Option<FaultKind>,
    pub plan: TurnPlan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReceiptOutcome {
    Success,
    ToolError,
}

#[derive(Debug, Clone, Copy)]
pub struct ToolReceipt<'a> {
    pub call_id: &'a str,
    pub result: &'a Value,
    pub outcome: ReceiptOutcome,
}

#[derive(Debug, Clone, Copy)]
pub struct CheckpointReceipt<'a> {
    pub checkpoint_id: &'a str,
    pub proof_marker: &'a str,
    pub kind: CheckpointEvidenceKind,
}

pub struct ScenarioRequest<'a> {
    pub catalog: &'a ToolCatalog,
    pub protocol: Protocol,
    pub parent_response_id: Option<&'a str>,
    pub turn_boundary: Option<&'a str>,
    pub receipts: &'a [ToolReceipt<'a>],
    pub checkpoint: Option<CheckpointReceipt<'a>>,
    pub tool_choice: &'a Value,
    pub allow_parallel_tools: bool,
    pub native_compaction: bool,
}

impl<'a> ScenarioRequest<'a> {
    pub fn new(catalog: &'a ToolCatalog, protocol: Protocol) -> Self {
        Self {
            catalog,
            protocol,
            parent_response_id: None,
            turn_boundary: None,
            receipts: &[],
            checkpoint: None,
            tool_choice: &Value::Null,
            allow_parallel_tools: true,
            native_compaction: protocol.is_responses(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ScenarioError {
    #[error("unknown scenario session {0:?}")]
    UnknownSession(String),
    #[error("invalid or duplicate session registration {0:?}")]
    InvalidSession(String),
    #[error("previous response {0:?} does not belong to the session")]
    UnknownParent(String),
    #[error("receipt for call {0:?} belongs to a different session")]
    ForeignCall(String),
    #[error("receipt references unknown call {0:?}")]
    UnknownCall(String),
    #[error("receipt content changed for call {0:?}")]
    ChangedReceipt(String),
    #[error("unexpected receipt for call {call_id:?}: {reason}")]
    UnexpectedReceipt { call_id: String, reason: String },
    #[error("checkpoint evidence does not match an issued checkpoint")]
    InvalidCheckpoint,
    #[error("runner observation does not match the pending failure for call {0:?}")]
    InvalidRunnerObservation(String),
    #[error("the runner reported harness termination")]
    RunnerTerminated,
    #[error("completion proof does not match the issued final answer")]
    InvalidCompletionProof,
    #[error(transparent)]
    Bind(#[from] ToolBindError),
}

struct Session {
    id_scope: String,
    logical_lane: String,
    workspace: PathBuf,
    inner: Mutex<SessionData>,
}

struct SessionData {
    epoch: u64,
    step: usize,
    state: ScenarioSessionState,
    decisions: Vec<Publication>,
    by_request: HashMap<RequestKey, Revision>,
    by_response: HashMap<String, Revision>,
    by_call: HashMap<String, (Revision, usize)>,
    accepted: HashMap<String, u64>,
    checkpoints: HashMap<String, (Revision, String, CheckpointEvidenceKind)>,
}

struct Publication {
    decision: Arc<IssuedDecision>,
    attempt: u32,
    runner_observation: Option<RunnerObservation>,
}

impl Default for SessionData {
    fn default() -> Self {
        Self {
            epoch: 0,
            step: 0,
            state: ScenarioSessionState::AwaitingInput,
            decisions: Vec::new(),
            by_request: HashMap::new(),
            by_response: HashMap::new(),
            by_call: HashMap::new(),
            accepted: HashMap::new(),
            checkpoints: HashMap::new(),
        }
    }
}

pub struct ScenarioEngine {
    spec: ScenarioSpec,
    compiled: CompiledSpec,
    run_scope: String,
    run_id: String,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    registrations: AtomicU64,
    validators: ValidatorCache,
}

impl ScenarioEngine {
    pub fn new(spec: ScenarioSpec, run_id: impl AsRef<str>) -> Result<Self, ScenarioSpecError> {
        if run_id.as_ref().trim().is_empty() {
            return Err(ScenarioSpecError::Invalid("empty run ID".into()));
        }
        let compiled = spec.compile()?;
        Ok(Self {
            spec,
            compiled,
            run_scope: compact_hex(run_id.as_ref()),
            run_id: run_id.as_ref().into(),
            sessions: Mutex::new(HashMap::new()),
            registrations: AtomicU64::new(0),
            validators: ValidatorCache::default(),
        })
    }

    pub fn register_session(
        &self,
        session_id: &str,
        logical_lane: impl Into<String>,
        workspace: impl Into<PathBuf>,
    ) -> Result<(), ScenarioError> {
        let workspace = workspace.into();
        let logical_lane = logical_lane.into();
        let mut sessions = self.sessions.lock().unwrap();
        if session_id.trim().is_empty()
            || logical_lane.trim().is_empty()
            || !workspace.is_absolute()
            || workspace.to_str().is_none()
            || sessions.contains_key(session_id)
        {
            return Err(ScenarioError::InvalidSession(session_id.into()));
        }
        sessions.insert(
            session_id.into(),
            Arc::new(Session {
                id_scope: format!(
                    "{}_{}_{:x}",
                    self.run_scope,
                    compact_hex(session_id),
                    self.registrations.fetch_add(1, Ordering::Relaxed)
                ),
                logical_lane,
                workspace,
                inner: Mutex::new(SessionData::default()),
            }),
        );
        Ok(())
    }

    pub fn state(&self, session_id: &str) -> Result<ScenarioSessionState, ScenarioError> {
        Ok(self
            .session(session_id)?
            .inner
            .lock()
            .unwrap()
            .state
            .clone())
    }

    pub fn record_runner_observation(
        &self,
        session_id: &str,
        observation: RunnerObservation,
    ) -> Result<(), ScenarioError> {
        let session = self.session(session_id)?;
        let mut data = session.inner.lock().unwrap();
        let invalid = || ScenarioError::InvalidRunnerObservation(observation.call_id.clone());
        if observation.session_id != session_id {
            return Err(invalid());
        }
        let &(revision, _) = data.by_call.get(&observation.call_id).ok_or_else(invalid)?;
        let publication = &data.decisions[revision.0 - 1];
        if publication.runner_observation.as_ref() == Some(&observation) {
            return Ok(());
        }
        if !matches!(data.state, ScenarioSessionState::AwaitingRunnerObservation {
            revision: pending_revision, kind
        } if pending_revision == revision && kind == observation.kind)
            || publication.attempt != observation.attempt
            || matches!(
                self.compiled.faults.get(&(data.step, observation.attempt)),
                Some((FaultBoundary::BeforeHeaders, _))
            )
        {
            return Err(invalid());
        }

        data.state = match observation.kind {
            RunnerObservationKind::ProtocolRejection => {
                data.step += 1;
                ScenarioSessionState::AwaitingInput
            }
            RunnerObservationKind::HarnessTermination => {
                ScenarioSessionState::RunnerTerminated { revision }
            }
        };
        data.decisions[revision.0 - 1].runner_observation = Some(observation);
        data.epoch += 1;
        Ok(())
    }

    pub fn verify_completion(
        &self,
        session_id: &str,
        proof: CompletionProof,
    ) -> Result<(), ScenarioError> {
        let session = self.session(session_id)?;
        let CanonicalAction::FinalAnswer { expect_markers, .. } =
            &self.spec.steps.last().expect("validated final").action
        else {
            unreachable!("validated final");
        };
        if !expect_markers
            .iter()
            .all(|marker| proof.observed_markers.contains(marker))
        {
            return Err(ScenarioError::InvalidCompletionProof);
        }
        let mut data = session.inner.lock().unwrap();
        match &data.state {
            ScenarioSessionState::FinalIssued(final_receipt)
                if final_receipt.response_id == proof.response_id =>
            {
                data.epoch += 1;
                data.state = ScenarioSessionState::Verified(proof);
                Ok(())
            }
            ScenarioSessionState::Verified(known)
                if known.response_id == proof.response_id
                    && known.observed_markers == proof.observed_markers =>
            {
                Ok(())
            }
            _ => Err(ScenarioError::InvalidCompletionProof),
        }
    }

    pub fn remove_session(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().remove(session_id).is_some()
    }

    fn session(&self, id: &str) -> Result<Arc<Session>, ScenarioError> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| ScenarioError::UnknownSession(id.into()))
    }

    pub fn evaluate_request(
        &self,
        session_id: &str,
        request: ScenarioRequest<'_>,
    ) -> Result<ScenarioEvaluation, ScenarioError> {
        let session = self.session(session_id)?;
        self.evaluate(&session, request)
    }

    fn evaluate(
        &self,
        session: &Session,
        request: ScenarioRequest<'_>,
    ) -> Result<ScenarioEvaluation, ScenarioError> {
        let receipts = prepare_receipts(request.receipts)?;
        let constraint_digest = digest(&(
            request.catalog.constraint_digest(request.tool_choice),
            request.allow_parallel_tools,
            request.native_compaction,
        ));
        let boundary = digest(&request.turn_boundary);
        loop {
            let proposal = session.inner.lock().unwrap().propose(
                session,
                &request,
                &receipts,
                boundary,
                constraint_digest,
            )?;

            for receipt in &proposal.receipts {
                self.check_receipt(&receipt.decision, receipt.slot, receipt.receipt)?;
            }

            let prepared = match proposal.next {
                Next::Issue { step, revision } => self
                    .prepare_decision(session, &request, step, revision, &proposal.key)
                    .map(Some),
                Next::Replay(_) => Ok(None),
            };

            let (committed, prepared) = {
                let mut data = session.inner.lock().unwrap();
                if data.epoch != proposal.epoch {
                    continue;
                }
                match prepared {
                    Ok(prepared) => (
                        data.commit(
                            proposal,
                            prepared.as_ref().map(|(decision, _)| Arc::clone(decision)),
                            &self.spec,
                        ),
                        prepared,
                    ),
                    Err(error) => {
                        data.accept_progress(proposal);
                        return Err(error);
                    }
                }
            };

            let fault = if committed.allow_fault {
                self.compiled
                    .faults
                    .get(&(committed.decision.recipe.step, committed.attempt))
                    .copied()
            } else {
                None
            };
            let plan = if let Some((FaultBoundary::BeforeHeaders, fault)) = fault {
                fault_plan(fault, request.protocol, request.parent_response_id)
            } else if let Some((_, plan)) = prepared {
                plan
            } else {
                self.materialize(
                    session,
                    &committed.decision,
                    &committed.outstanding,
                    request.protocol,
                )?
            };
            if constraint_digest != committed.decision.request_key.constraint_digest
                && matches!(committed.decision.recipe.kind, PlanKind::Tools(_))
                && !committed.outstanding.is_empty()
            {
                let catalog = request.catalog.with_tool_choice(request.tool_choice)?;
                if !request.allow_parallel_tools && committed.outstanding.len() > 1 {
                    return Err(ToolBindError::UnsupportedAction {
                        action: "parallel batch replay".into(),
                        differences: vec!["request disallows multiple tool calls".into()],
                    }
                    .into());
                }
                for event in &plan.events {
                    if let TurnEvent::ToolCall(call) = event {
                        catalog.validate_replay(
                            &self.validators,
                            &call.name,
                            call.namespace.as_deref(),
                            call.payload.as_ref().expect("typed scenario payload"),
                        )?;
                    }
                }
            }
            let mut plan = if let Some((FaultBoundary::AfterFirstCompleteCall, fault)) = fault {
                after_first_call(plan, fault)
            } else {
                plan
            };
            plan.response_id = Some(committed.decision.response_id.clone());
            return Ok(ScenarioEvaluation {
                decision: committed.decision,
                attempt: committed.attempt,
                replayed: committed.replayed,
                confirmed_call_ids: committed.confirmed_call_ids,
                adopted_checkpoint_id: committed.checkpoint_accepted.then(|| {
                    request
                        .checkpoint
                        .expect("accepted checkpoint evidence")
                        .checkpoint_id
                        .to_owned()
                }),
                fault: fault.map(|(_, fault)| fault),
                plan,
            });
        }
    }

    fn actions(&self, step: usize) -> &[CanonicalAction] {
        let action = &self.spec.steps[step].action;
        match action {
            CanonicalAction::ParallelBatch(actions) => actions,
            _ => std::slice::from_ref(action),
        }
    }

    fn with_tool_actions<T>(
        &self,
        session: &Session,
        step: usize,
        f: impl FnOnce(&[ToolAction<'_>]) -> T,
    ) -> T {
        use CanonicalAction as Action;
        let actions = self.actions(step);
        let generated: Vec<_> = actions
            .iter()
            .enumerate()
            .map(|(slot, action)| {
                let Action::LargeOutput { fixture, bytes } = action else {
                    return None;
                };
                let FixtureDef::LargeOutput { pattern } = &self.spec.fixtures[fixture] else {
                    unreachable!("validated generator reference");
                };
                Some(large_output_command(
                    pattern,
                    *bytes,
                    self.workload_seed(session, step, slot),
                ))
            })
            .collect();
        let actions: Vec<_> = actions
            .iter()
            .zip(&generated)
            .enumerate()
            .map(|(slot, (action, output))| match action {
                Action::ReadFile { path, .. } => ToolAction::Read { path },
                Action::WriteFile { path, content } => ToolAction::Write { path, content },
                Action::EditFile { path, old, new } => ToolAction::Edit {
                    path,
                    old,
                    new,
                    hunk: &self.compiled.edit_hunks[step][&slot],
                },
                Action::Shell { command_id, .. } => {
                    let FixtureDef::Command { command } = &self.spec.fixtures[command_id] else {
                        unreachable!("validated command reference");
                    };
                    ToolAction::Shell {
                        command,
                        title: command_id,
                    }
                }
                Action::LargeOutput { fixture, .. } => ToolAction::Shell {
                    command: output.as_deref().expect("generated large-output command"),
                    title: fixture,
                },
                _ => unreachable!("tool action"),
            })
            .collect();
        f(&actions)
    }

    fn workload_seed(&self, session: &Session, step: usize, slot: usize) -> u64 {
        // Length prefixes make the tuple unambiguous across hosts and Rust versions.
        let mut seed = 0xcbf29ce484222325u64;
        for part in [
            self.spec.seed.to_le_bytes().as_slice(),
            session.logical_lane.as_bytes(),
            self.spec.steps[step].id.as_bytes(),
            (slot as u64).to_le_bytes().as_slice(),
        ] {
            for byte in (part.len() as u64)
                .to_le_bytes()
                .into_iter()
                .chain(part.iter().copied())
            {
                seed = (seed ^ u64::from(byte)).wrapping_mul(0x100000001b3);
            }
        }
        seed
    }

    pub fn spec(&self) -> &ScenarioSpec {
        &self.spec
    }

    fn prepare_decision(
        &self,
        session: &Session,
        request: &ScenarioRequest<'_>,
        step: usize,
        revision: Revision,
        key: &RequestKey,
    ) -> Result<(Arc<IssuedDecision>, TurnPlan), ScenarioError> {
        use CanonicalAction as Action;
        let mut plan = None;
        let kind = match &self.spec.steps[step].action {
            Action::FinalAnswer { .. } => PlanKind::Final,
            Action::TriggerCompaction { mode, .. } => {
                if matches!(mode, CompactionMode::Native) && !request.native_compaction {
                    return Err(ToolBindError::UnsupportedAction {
                        action: "native compaction".into(),
                        differences: vec!["request has no native compaction support".into()],
                    }
                    .into());
                }
                PlanKind::Checkpoint
            }
            Action::BadToolCall { mode, .. } => {
                let catalog = request.catalog.with_tool_choice(request.tool_choice)?;
                let binding = catalog.bind_bad(
                    &self.validators,
                    *mode,
                    self.workload_seed(session, step, 0),
                )?;
                PlanKind::BadTool(binding)
            }
            Action::UnknownTool { name, .. } => {
                if request
                    .catalog
                    .declarations()
                    .iter()
                    .any(|tool| tool.name == *name)
                {
                    return Err(
                        ToolBindError::InvalidAction(format!("tool {name:?} is declared")).into(),
                    );
                }
                PlanKind::UnknownTool
            }
            _ => {
                let catalog = request.catalog.with_tool_choice(request.tool_choice)?;
                let bound = self.with_tool_actions(session, step, |actions| {
                    catalog.bind(
                        &self.validators,
                        self.spec.track,
                        &session.workspace,
                        actions,
                    )
                })?;
                if !request.allow_parallel_tools && bound.len() > 1 {
                    return Err(ToolBindError::UnsupportedAction {
                        action: "parallel batch".into(),
                        differences: vec!["request disallows multiple tool calls".into()],
                    }
                    .into());
                }
                let (bindings, payloads): (Vec<_>, Vec<_>) = bound
                    .into_iter()
                    .map(|call| (call.recipe, call.payload))
                    .unzip();
                plan = Some(payloads);
                PlanKind::Tools(bindings)
            }
        };
        let call = |index, name: &str, namespace: Option<&str>, slots: Vec<usize>| IssuedCall {
            call_id: format!("call_{}_{}_{}", session.id_scope, revision.0, index),
            item_id: format!("fc_{}_{}_{}", session.id_scope, revision.0, index),
            tool_name: name.into(),
            namespace: namespace.map(str::to_owned),
            slots,
        };
        let calls = match &kind {
            PlanKind::Tools(bindings) => bindings
                .iter()
                .enumerate()
                .map(|(index, binding)| {
                    call(
                        index,
                        &binding.name,
                        binding.namespace.as_deref(),
                        binding.slots.clone(),
                    )
                })
                .collect(),
            PlanKind::BadTool(binding) => {
                vec![call(
                    0,
                    &binding.name,
                    binding.namespace.as_deref(),
                    vec![0],
                )]
            }
            PlanKind::UnknownTool => {
                let Action::UnknownTool { name, .. } = &self.spec.steps[step].action else {
                    unreachable!("unknown tool recipe");
                };
                vec![call(0, name, None, vec![0])]
            }
            PlanKind::Checkpoint | PlanKind::Final => Vec::new(),
        };
        let decision = Arc::new(IssuedDecision {
            revision,
            request_key: key.clone(),
            response_id: format!("resp_{}_{}", session.id_scope, revision.0),
            calls,
            recipe: PlanRecipe { step, kind },
        });
        let plan = if let Some(payloads) = plan {
            decision
                .calls
                .iter()
                .zip(payloads)
                .fold(TurnPlan::new(), |plan, (call, payload)| {
                    plan.push(tool_call(call, payload))
                })
        } else {
            let outstanding = (0..decision.calls.len()).collect::<Vec<_>>();
            self.materialize(session, &decision, &outstanding, request.protocol)?
        };
        Ok((decision, plan))
    }

    fn materialize(
        &self,
        session: &Session,
        decision: &IssuedDecision,
        outstanding: &[usize],
        protocol: Protocol,
    ) -> Result<TurnPlan, ScenarioError> {
        use CanonicalAction as Action;
        let step = decision.recipe.step;
        let action = &self.spec.steps[step].action;
        match &decision.recipe.kind {
            PlanKind::Tools(bindings) if !outstanding.is_empty() => {
                self.with_tool_actions(session, step, |actions| {
                    let mut plan = TurnPlan::new();
                    for &index in outstanding {
                        let payload = bindings[index].encode(&session.workspace, actions)?;
                        plan = plan.push(tool_call(&decision.calls[index], payload));
                    }
                    Ok(plan)
                })
            }
            PlanKind::BadTool(binding) if !outstanding.is_empty() => {
                Ok(TurnPlan::new().push(tool_call(
                    &decision.calls[0],
                    binding.encode(self.workload_seed(session, step, 0)),
                )))
            }
            PlanKind::UnknownTool if !outstanding.is_empty() => {
                Ok(TurnPlan::new().push(tool_call(
                    &decision.calls[0],
                    CallPayload::Function(Value::Object(Default::default())),
                )))
            }
            PlanKind::Checkpoint => {
                let Action::TriggerCompaction { mode, proof_marker } = action else {
                    unreachable!("checkpoint recipe");
                };
                let id = checkpoint_id(decision);
                Ok(match mode {
                    CompactionMode::Native => TurnPlan::new().push_compaction(CompactionOutput {
                        encrypted_content: format!("mock:{proof_marker}"),
                        summary: format!("{id} {proof_marker}"),
                        id,
                        signature: None,
                        pause_after_compaction: protocol == Protocol::AnthropicMessages,
                    }),
                    CompactionMode::ContextOverflow {
                        actual_bytes,
                        limit_bytes,
                    } => TurnPlan::http_error(context_overflow_error(
                        protocol,
                        *actual_bytes,
                        *limit_bytes,
                    )),
                    CompactionMode::Prompt => TurnPlan::text(checkpoint_prompt(&id, proof_marker)),
                })
            }
            PlanKind::Final => {
                let Action::FinalAnswer { text, .. } = action else {
                    unreachable!("final recipe");
                };
                Ok(TurnPlan::text(text))
            }
            _ => Ok(TurnPlan::new().finish(FinishReason::Stop)),
        }
    }

    fn check_receipt(
        &self,
        decision: &IssuedDecision,
        index: usize,
        receipt: ToolReceipt<'_>,
    ) -> Result<(), ScenarioError> {
        use CanonicalAction as Action;
        let step = decision.recipe.step;
        let actions = self.actions(step);
        let call = &decision.calls[index];
        let fail = |reason: String| ScenarioError::UnexpectedReceipt {
            call_id: call.call_id.clone(),
            reason,
        };
        let mut code_results = None;
        let code_mode = matches!(&decision.recipe.kind, PlanKind::Tools(bindings) if bindings[index].is_code_mode());
        for (index, &slot) in call.slots.iter().enumerate() {
            let action = &actions[slot];
            let expected = match action {
                Action::BadToolCall {
                    expect_handling, ..
                }
                | Action::UnknownTool {
                    expect_handling, ..
                } => {
                    if expect_handling.runner_observation().is_some() {
                        return Err(fail(format!("slot {slot}: expected a runner observation")));
                    }
                    ReceiptOutcome::ToolError
                }
                _ => ReceiptOutcome::Success,
            };
            if receipt.outcome != expected {
                return Err(fail(format!(
                    "slot {slot}: expected {expected:?}, got {:?}",
                    receipt.outcome
                )));
            }
            let result = if code_mode {
                let results = code_results.get_or_insert_with(|| code_results_from(receipt.result));
                let result = results
                    .as_ref()
                    .and_then(|results| results.get(index))
                    .ok_or_else(|| fail(format!("slot {slot}: missing Code Mode result")))?;
                if result["slot"].as_u64() != Some(slot as u64) || result.get("result").is_none() {
                    return Err(fail(format!("slot {slot}: invalid Code Mode result")));
                }
                &result["result"]
            } else {
                receipt.result
            };
            if expected == ReceiptOutcome::Success && result_failed(result) {
                return Err(fail(format!("slot {slot}: tool reported failure")));
            }
            if let Action::ReadFile { expect_marker, .. } = action
                && !value_contains(result, expect_marker)
            {
                return Err(fail(format!(
                    "slot {slot}: missing read marker {expect_marker:?}"
                )));
            }
        }
        Ok(())
    }
}

fn result_failed(result: &Value) -> bool {
    result["kind"] == "failed"
        || result["is_error"] == true
        || [
            &result["exit_code"],
            &result["exitCode"],
            &result["value"]["exitCode"],
        ]
        .iter()
        .any(|code| code.as_i64().is_some_and(|exit| exit != 0))
}

fn code_results_from(result: &Value) -> Option<Cow<'_, [Value]>> {
    match result {
        Value::String(text) => serde_json::from_str::<Vec<Value>>(text)
            .ok()
            .filter(|items| items.iter().all(|item| item.get("slot").is_some()))
            .or_else(|| {
                text.lines().rev().find_map(|line| {
                    serde_json::from_str::<Vec<Value>>(line.trim())
                        .ok()
                        .filter(|items| {
                            !items.is_empty() && items.iter().all(|item| item.get("slot").is_some())
                        })
                })
            })
            .map(Cow::Owned),
        Value::Array(items) if items.iter().all(|item| item.get("slot").is_some()) => {
            Some(Cow::Borrowed(items))
        }
        Value::Array(items) => items.iter().find_map(code_results_from),
        Value::Object(_) => result.get("text").and_then(code_results_from),
        _ => None,
    }
}

fn checkpoint_id(decision: &IssuedDecision) -> String {
    format!(
        "cmp_{}",
        decision
            .response_id
            .strip_prefix("resp_")
            .expect("scenario response ID")
    )
}

fn checkpoint_prompt(id: &str, marker: &str) -> String {
    format!("Compact the conversation and preserve {id} {marker}.")
}

fn tool_call(call: &IssuedCall, payload: CallPayload) -> ToolCallSpec {
    let payload = match payload {
        CallPayload::Function(value) => ToolCallPayload::FunctionArgs(value),
        CallPayload::Freeform(text) => ToolCallPayload::FreeformInput(text),
        CallPayload::MalformedJson(text) => ToolCallPayload::MalformedRaw(text),
    };
    let mut spec = ToolCallSpec::with_payload(&call.call_id, &call.tool_name, payload);
    spec.item_id = Some(call.item_id.clone());
    spec.namespace.clone_from(&call.namespace);
    spec
}

fn compact_hex(id: &str) -> String {
    format!("{:08x}", (digest(id) & 0xffff_ffff) as u32)
}

fn large_output_command(pattern: &str, bytes: usize, seed: u64) -> String {
    let pattern = format!("{seed:016x}:{pattern}\n");
    let repetitions_per_block = (4096 / pattern.len()).max(1);
    let block_size = repetitions_per_block * pattern.len();
    let blocks = bytes / block_size;
    let remainder = bytes % block_size;
    let repetitions = remainder / pattern.len();
    let mut tail_bytes = remainder % pattern.len();
    while !pattern.is_char_boundary(tail_bytes) {
        tail_bytes -= 1;
    }
    let tail = format!(
        "{}{}",
        &pattern[..tail_bytes],
        " ".repeat(remainder % pattern.len() - tail_bytes)
    );
    format!(
        "BENCH_PATTERN={} BENCH_TAIL={} LC_ALL=C awk 'BEGIN {{ p = ENVIRON[\"BENCH_PATTERN\"]; for (i = 0; i < {repetitions_per_block}; i++) block = block p; for (i = 0; i < {blocks}; i++) printf \"%s\", block; for (i = 0; i < {repetitions}; i++) printf \"%s\", p; printf \"%s\", ENVIRON[\"BENCH_TAIL\"] }}'",
        shell_quote(&pattern),
        shell_quote(&tail),
    )
}

fn value_contains(value: &Value, marker: &str) -> bool {
    match value {
        Value::String(text) => {
            text.contains(marker)
                || serde_json::from_str::<Value>(text)
                    .ok()
                    .is_some_and(|parsed| value_contains(&parsed, marker))
        }
        Value::Array(values) => values.iter().any(|value| value_contains(value, marker)),
        Value::Object(values) => values.values().any(|value| value_contains(value, marker)),
        _ => false,
    }
}

fn fault_plan(fault: FaultKind, protocol: Protocol, parent: Option<&str>) -> TurnPlan {
    match fault {
        FaultKind::Http429 => TurnPlan::http_error(rate_limit_error(protocol, Some(0))),
        FaultKind::Http503 => TurnPlan::http_error(overloaded_error(protocol)),
        FaultKind::PayloadTooLarge => TurnPlan::http_error(payload_too_large_error(protocol)),
        FaultKind::PreviousResponseNotFound => TurnPlan::http_error(
            previous_response_not_found_error(protocol, parent.unwrap_or_default()),
        ),
        FaultKind::Eof => TurnPlan::new()
            .push(TurnEvent::StreamStart)
            .push(TurnEvent::TruncateEof),
        FaultKind::Disconnect => TurnPlan::new().push(TurnEvent::DropConnection),
    }
}

fn after_first_call(mut plan: TurnPlan, fault: FaultKind) -> TurnPlan {
    if let Some(index) = plan
        .events
        .iter()
        .position(|event| matches!(event, TurnEvent::ToolCall(_)))
    {
        plan.events.truncate(index + 1);
        plan.events.push(TurnEvent::Flush);
        plan.events.push(match fault {
            FaultKind::Eof => TurnEvent::TruncateEof,
            FaultKind::Disconnect => TurnEvent::DropConnection,
            _ => unreachable!("validated streaming fault"),
        });
    }
    plan
}

#[derive(Clone, Copy)]
struct PreparedReceipt<'a> {
    receipt: ToolReceipt<'a>,
    digest: u64,
}

fn prepare_receipts<'a>(
    receipts: &[ToolReceipt<'a>],
) -> Result<Vec<PreparedReceipt<'a>>, ScenarioError> {
    let mut entries = HashMap::new();
    let mut unique = Vec::new();
    for &receipt in receipts {
        let digest = digest(&(receipt.result, receipt.outcome));
        if let Some(previous) = entries.insert(receipt.call_id, digest) {
            if previous != digest {
                return Err(ScenarioError::ChangedReceipt(receipt.call_id.into()));
            }
        } else {
            unique.push(PreparedReceipt { receipt, digest });
        }
    }
    Ok(unique)
}

struct NewReceipt<'a> {
    decision: Arc<IssuedDecision>,
    slot: usize,
    receipt: ToolReceipt<'a>,
    digest: u64,
}

struct Proposal<'a> {
    epoch: u64,
    key: RequestKey,
    next: Next,
    receipts: Vec<NewReceipt<'a>>,
    checkpoint_accepted: bool,
}

enum Next {
    Issue { step: usize, revision: Revision },
    Replay(Revision),
}

struct Committed {
    decision: Arc<IssuedDecision>,
    outstanding: Vec<usize>,
    attempt: u32,
    allow_fault: bool,
    replayed: bool,
    confirmed_call_ids: Vec<String>,
    checkpoint_accepted: bool,
}

impl SessionData {
    fn decision(&self, revision: Revision) -> &Arc<IssuedDecision> {
        &self.decisions[revision.0 - 1].decision
    }

    fn outstanding(&self, decision: &IssuedDecision, incoming: &HashSet<&str>) -> Vec<usize> {
        if self.decisions[decision.revision.0 - 1]
            .runner_observation
            .is_some()
        {
            return Vec::new();
        }
        decision
            .calls
            .iter()
            .enumerate()
            .filter_map(|(index, call)| {
                (!self.accepted.contains_key(&call.call_id)
                    && !incoming.contains(call.call_id.as_str()))
                .then_some(index)
            })
            .collect()
    }

    fn propose<'a>(
        &self,
        session: &Session,
        request: &ScenarioRequest<'_>,
        receipts: &[PreparedReceipt<'a>],
        turn_boundary_key: u64,
        constraint_digest: u64,
    ) -> Result<Proposal<'a>, ScenarioError> {
        let mut parent = request
            .parent_response_id
            .map(|id| {
                self.by_response
                    .get(id)
                    .copied()
                    .ok_or_else(|| ScenarioError::UnknownParent(id.into()))
            })
            .transpose()?
            .unwrap_or_default();

        let mut incoming = HashSet::new();
        let mut new_receipts = Vec::new();
        for &PreparedReceipt { receipt, digest } in receipts {
            let id = receipt.call_id;
            let Some(&(revision, slot)) = self.by_call.get(id) else {
                if let Some(scope) = call_scope(id)
                    && scope != session.id_scope
                {
                    return Err(ScenarioError::ForeignCall(id.into()));
                }
                return Err(ScenarioError::UnknownCall(id.into()));
            };
            if request.parent_response_id.is_none() {
                parent = parent.max(revision);
            }
            if let Some(&existing) = self.accepted.get(id) {
                if existing != digest {
                    return Err(ScenarioError::ChangedReceipt(id.into()));
                }
            } else {
                incoming.insert(id);
                new_receipts.push(NewReceipt {
                    decision: Arc::clone(self.decision(revision)),
                    slot,
                    receipt,
                    digest,
                });
            }
        }

        let mut checkpoint_accepted = false;
        if let Some(checkpoint) = request.checkpoint {
            let (revision, marker, kind) = self
                .checkpoints
                .get(checkpoint.checkpoint_id)
                .ok_or(ScenarioError::InvalidCheckpoint)?;
            if marker != checkpoint.proof_marker || *kind != checkpoint.kind {
                return Err(ScenarioError::InvalidCheckpoint);
            }
            if request.parent_response_id.is_none() {
                parent = parent.max(*revision);
            }
            checkpoint_accepted = matches!(&self.state,
                ScenarioSessionState::AwaitingCheckpoint(pending) if pending.revision == *revision);
        }

        let pending_call_ids_digest = if parent == Revision::default() {
            digest(&Vec::<&str>::new())
        } else {
            let decision = self.decision(parent);
            digest(
                &self
                    .outstanding(decision, &incoming)
                    .iter()
                    .map(|&index| decision.calls[index].call_id.as_str())
                    .collect::<Vec<_>>(),
            )
        };
        let key = RequestKey {
            parent_revision: parent,
            turn_boundary_key,
            pending_call_ids_digest,
            constraint_digest,
        };

        let issue = |step| Next::Issue {
            step,
            revision: Revision(self.decisions.len() + 1),
        };
        let replay = |current| Next::Replay(self.by_request.get(&key).copied().unwrap_or(current));
        let next = match &self.state {
            ScenarioSessionState::AwaitingInput => issue(self.step),
            ScenarioSessionState::AwaitingReceipts(batch)
                if batch.outstanding == new_receipts.len() =>
            {
                issue(self.step + 1)
            }
            ScenarioSessionState::AwaitingReceipts(batch) if !new_receipts.is_empty() => {
                Next::Replay(batch.revision)
            }
            ScenarioSessionState::AwaitingReceipts(batch) => replay(batch.revision),
            ScenarioSessionState::AwaitingRunnerObservation { revision, .. } => replay(*revision),
            ScenarioSessionState::AwaitingCheckpoint(_) if checkpoint_accepted => {
                issue(self.step + 1)
            }
            ScenarioSessionState::AwaitingCheckpoint(checkpoint) => replay(checkpoint.revision),
            ScenarioSessionState::FinalIssued(final_receipt) => replay(final_receipt.revision),
            ScenarioSessionState::Verified(_) => replay(Revision(self.decisions.len())),
            ScenarioSessionState::RunnerTerminated { .. } => {
                return Err(ScenarioError::RunnerTerminated);
            }
        };

        Ok(Proposal {
            epoch: self.epoch,
            key,
            next,
            receipts: new_receipts,
            checkpoint_accepted,
        })
    }

    fn accept_progress(&mut self, proposal: Proposal<'_>) {
        if proposal.receipts.is_empty() && !proposal.checkpoint_accepted {
            return;
        }
        let Next::Issue { step, .. } = proposal.next else {
            unreachable!("only new issuance can fail to bind");
        };
        self.accept_receipts(proposal.receipts);
        self.step = step;
        self.epoch += 1;
        self.state = ScenarioSessionState::AwaitingInput;
    }

    fn accept_receipts(&mut self, receipts: Vec<NewReceipt<'_>>) {
        for receipt in receipts {
            self.accepted
                .insert(receipt.receipt.call_id.into(), receipt.digest);
        }
    }

    fn commit(
        &mut self,
        proposal: Proposal<'_>,
        decision: Option<Arc<IssuedDecision>>,
        spec: &ScenarioSpec,
    ) -> Committed {
        let Proposal {
            key,
            next,
            receipts,
            checkpoint_accepted,
            ..
        } = proposal;
        let has_progress = !receipts.is_empty() || checkpoint_accepted;
        let constraint_digest = key.constraint_digest;
        let confirmed_call_ids = receipts
            .iter()
            .map(|receipt| receipt.receipt.call_id.to_owned())
            .collect();
        self.accept_receipts(receipts);

        let (revision, replayed) = match next {
            Next::Issue { step, revision } => {
                let decision = decision.expect("prepared issuance");
                self.step = step;
                self.by_request.insert(key, revision);
                self.by_response
                    .insert(decision.response_id.clone(), revision);
                self.by_call.extend(
                    decision
                        .calls
                        .iter()
                        .enumerate()
                        .map(|(slot, call)| (call.call_id.clone(), (revision, slot))),
                );
                self.state = match &spec.steps[step].action {
                    CanonicalAction::TriggerCompaction { mode, proof_marker } => {
                        let checkpoint_id = checkpoint_id(&decision);
                        let evidence_kind = (*mode).into();
                        self.checkpoints.insert(
                            checkpoint_id.clone(),
                            (revision, proof_marker.clone(), evidence_kind),
                        );
                        ScenarioSessionState::AwaitingCheckpoint(PendingCheckpoint {
                            revision,
                            checkpoint_id,
                            proof_marker: proof_marker.clone(),
                            evidence_kind,
                        })
                    }
                    CanonicalAction::FinalAnswer { .. } => {
                        ScenarioSessionState::FinalIssued(FinalReceipt {
                            revision,
                            response_id: decision.response_id.clone(),
                        })
                    }
                    CanonicalAction::BadToolCall {
                        expect_handling, ..
                    }
                    | CanonicalAction::UnknownTool {
                        expect_handling, ..
                    } if let Some(kind) = expect_handling.runner_observation() => {
                        ScenarioSessionState::AwaitingRunnerObservation { revision, kind }
                    }
                    _ => ScenarioSessionState::AwaitingReceipts(PendingBatch {
                        revision,
                        outstanding: decision.calls.len(),
                    }),
                };
                self.decisions.push(Publication {
                    decision,
                    attempt: 0,
                    runner_observation: None,
                });
                (revision, false)
            }
            Next::Replay(revision) => (revision, true),
        };

        let decision = Arc::clone(self.decision(revision));
        let outstanding = self.outstanding(&decision, &HashSet::new());
        if let ScenarioSessionState::AwaitingReceipts(batch) = &mut self.state
            && batch.revision == revision
        {
            batch.outstanding = outstanding.len();
        }

        // Replaying an older boundary must never re-inject faults into a later step.
        let same_constraints = constraint_digest == decision.request_key.constraint_digest;
        let allow_fault = same_constraints
            && decision.recipe.step == self.step
            && !matches!(self.state, ScenarioSessionState::Verified(_));
        let publication = &mut self.decisions[revision.0 - 1];
        if same_constraints {
            publication.attempt = publication.attempt.saturating_add(1);
        }
        if !replayed || has_progress {
            self.epoch += 1;
        }
        Committed {
            decision,
            outstanding,
            attempt: publication.attempt,
            allow_fault,
            replayed,
            confirmed_call_ids,
            checkpoint_accepted,
        }
    }
}

fn call_scope(id: &str) -> Option<&str> {
    let (prefix, slot) = id.strip_prefix("call_")?.rsplit_once('_')?;
    let (scope, revision) = prefix.rsplit_once('_')?;
    let (owner, generation) = scope.rsplit_once('_')?;
    let (run, session) = owner.split_once('_')?;
    let is_hex = |part: &str| {
        !part.is_empty()
            && part.len().is_multiple_of(2)
            && part.bytes().all(|b| b.is_ascii_hexdigit())
    };
    (is_hex(run)
        && is_hex(session)
        && u64::from_str_radix(generation, 16).is_ok()
        && revision.parse::<usize>().is_ok()
        && slot.parse::<usize>().is_ok())
    .then_some(scope)
}

impl ScenarioEngine {
    pub(crate) fn compaction_output(
        &self,
        session_id: &str,
    ) -> Option<(Revision, CompactionOutput)> {
        let session = self.session(session_id).ok()?;
        let data = session.inner.lock().unwrap();
        let ScenarioSessionState::AwaitingCheckpoint(checkpoint) = &data.state else {
            return None;
        };
        Some((
            checkpoint.revision,
            CompactionOutput {
                id: checkpoint.checkpoint_id.clone(),
                encrypted_content: format!("mock:{}", checkpoint.proof_marker),
                summary: format!("{} {}", checkpoint.checkpoint_id, checkpoint.proof_marker),
                signature: None,
                pause_after_compaction: true,
            },
        ))
    }

    /// Use an identity already resolved by the caller's routing layer.
    pub fn evaluate_normalized(
        &self,
        session_id: &str,
        request: &NormalizedRequest,
    ) -> Result<ScenarioEvaluation, ScenarioError> {
        let session = self.session(session_id)?;
        self.evaluate_wire(&session, request, request.previous_response_id.as_deref())
    }

    pub(crate) fn evaluate_with_parent_revision(
        &self,
        session_id: &str,
        request: &NormalizedRequest,
        revision: Revision,
    ) -> Result<ScenarioEvaluation, ScenarioError> {
        let session = self.session(session_id)?;
        let decision = if let Some(index) = revision.0.checked_sub(1) {
            let data = session.inner.lock().unwrap();
            Some(Arc::clone(
                &data
                    .decisions
                    .get(index)
                    .ok_or_else(|| {
                        ScenarioError::UnknownParent(
                            request.previous_response_id.clone().unwrap_or_default(),
                        )
                    })?
                    .decision,
            ))
        } else {
            None
        };
        self.evaluate_wire(
            &session,
            request,
            decision
                .as_deref()
                .map(|decision| decision.response_id.as_str()),
        )
    }

    fn evaluate_wire(
        &self,
        session: &Session,
        request: &NormalizedRequest,
        parent: Option<&str>,
    ) -> Result<ScenarioEvaluation, ScenarioError> {
        let catalog = ToolCatalog::from_request(request);
        let mut input = ScenarioRequest::new(&catalog, request.protocol);
        let (receipts, checkpoint) = wire_evidence(request)?;
        let pending_summary = {
            let data = session.inner.lock().unwrap();
            match &data.state {
                ScenarioSessionState::AwaitingCheckpoint(pending)
                    if pending.evidence_kind == CheckpointEvidenceKind::ClientSummary =>
                {
                    Some(pending.clone())
                }
                _ => None,
            }
        };
        input.receipts = &receipts;
        input.checkpoint = pending_summary
            .as_ref()
            .and_then(|pending| client_summary_receipt(request, pending))
            .or(checkpoint);
        input.parent_response_id = parent;
        input.turn_boundary = request
            .headers
            .get("x-maka-bench-turn")
            .map(String::as_str)
            .or_else(|| {
                request
                    .messages
                    .iter()
                    .rev()
                    .find(|msg| msg.role == NormalizedRole::User)
                    .map(|msg| msg.text.as_str())
            });
        input.tool_choice = request.options.tool_choice.as_ref().unwrap_or(&Value::Null);
        input.allow_parallel_tools = request.options.parallel_tool_calls.unwrap_or(true);
        input.native_compaction =
            request.protocol.is_responses() || request.anthropic_compaction_enabled;
        self.evaluate(session, input)
    }
}

fn client_summary_receipt<'a>(
    request: &NormalizedRequest,
    pending: &'a PendingCheckpoint,
) -> Option<CheckpointReceipt<'a>> {
    let prompt = checkpoint_prompt(&pending.checkpoint_id, &pending.proof_marker);
    let texts = request.system_text.iter().chain(
        request
            .messages
            .iter()
            .filter(|message| {
                message.kind == NormalizedMessageKind::Message
                    && message.role != NormalizedRole::Tool
            })
            .map(|message| &message.text),
    );
    let has_token = |text: &str, token: &str| {
        let continues = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-');
        let has_start_boundary = token.starts_with(continues);
        let has_end_boundary = token.ends_with(continues);
        text.match_indices(token).any(|(start, matched)| {
            (!has_start_boundary || !text[..start].ends_with(continues))
                && (!has_end_boundary || !text[start + matched.len()..].starts_with(continues))
        })
    };
    // A retained copy of the assistant's compaction instruction is not a returned summary.
    texts
        .flat_map(|text| text.split(prompt.as_str()))
        .any(|text| {
            has_token(text, &pending.checkpoint_id) && has_token(text, &pending.proof_marker)
        })
        .then_some(CheckpointReceipt {
            checkpoint_id: &pending.checkpoint_id,
            proof_marker: &pending.proof_marker,
            kind: CheckpointEvidenceKind::ClientSummary,
        })
}

type WireEvidence<'a> = (Vec<ToolReceipt<'a>>, Option<CheckpointReceipt<'a>>);

fn wire_evidence<'a>(request: &'a NormalizedRequest) -> Result<WireEvidence<'a>, ScenarioError> {
    let mut receipts = Vec::new();
    let mut checkpoint = None;
    let items = |key: &str| request.raw_body[key].as_array().into_iter().flatten();
    let mut receipt = |id: &'a Value, result: &'a Value, is_error: bool| {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ScenarioError::UnknownCall(String::new()))?;
        let outcome = if is_error || result_failed(result) || result["handling"] == "tool_error" {
            ReceiptOutcome::ToolError
        } else {
            ReceiptOutcome::Success
        };
        receipts.push(ToolReceipt {
            call_id: id,
            result,
            outcome,
        });
        Ok::<_, ScenarioError>(())
    };
    match request.protocol {
        Protocol::AnthropicMessages => {
            for block in items("messages")
                .flat_map(|message| message["content"].as_array().into_iter().flatten())
            {
                match block["type"].as_str() {
                    Some("tool_result") => receipt(
                        &block["tool_use_id"],
                        &block["content"],
                        block["is_error"] == true,
                    )?,
                    Some("compaction") => {
                        if let Some((id, marker)) =
                            block["content"].as_str().and_then(|s| s.split_once(' '))
                            && id.starts_with("cmp_")
                        {
                            checkpoint = Some(CheckpointReceipt {
                                checkpoint_id: id,
                                proof_marker: marker,
                                kind: CheckpointEvidenceKind::NativeCompaction,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        Protocol::OpenaiChatCompletions => {
            for item in items("messages").filter(|item| item["role"] == "tool") {
                receipt(
                    &item["tool_call_id"],
                    &item["content"],
                    item["is_error"] == true,
                )?;
            }
        }
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => {
            for item in items("input") {
                match item["type"].as_str() {
                    Some("function_call_output" | "custom_tool_call_output") => {
                        receipt(&item["call_id"], &item["output"], item["is_error"] == true)?;
                    }
                    Some("compaction") => {
                        if let (Some(id), Some(marker)) = (
                            item["id"].as_str(),
                            item["encrypted_content"]
                                .as_str()
                                .and_then(|s| s.strip_prefix("mock:")),
                        ) {
                            checkpoint = Some(CheckpointReceipt {
                                checkpoint_id: id,
                                proof_marker: marker,
                                kind: CheckpointEvidenceKind::NativeCompaction,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Ok((receipts, checkpoint))
}

impl TurnHandler for ScenarioEngine {
    fn handle<'a>(
        &'a self,
        request: &'a NormalizedRequest,
        _: &'a TurnContext,
    ) -> HandlerFuture<'a> {
        Box::pin(async move {
            let route =
                crate::routing::parse_route("POST", &request.path, None, false, &BTreeMap::new());
            let session_id = if let Some(scope) = route.scope.as_ref() {
                if scope.run_id.0 != self.run_id {
                    return None;
                }
                scope.session_id.0.as_str()
            } else {
                request
                    .headers
                    .get("x-maka-bench-session")
                    .unwrap_or(&request.session_key)
            };
            let session = self.session(session_id).ok()?;
            let plan = match self.evaluate_wire(
                &session,
                request,
                request.previous_response_id.as_deref(),
            ) {
                Ok(evaluation) => evaluation.plan,
                Err(error) => {
                    tracing::warn!(session_id, %error, "scenario request rejected");
                    match error {
                        ScenarioError::UnknownParent(id) => TurnPlan::http_error(
                            previous_response_not_found_error(request.protocol, &id),
                        ),
                        _ => TurnPlan::http_error(HttpErrorSpec::new(
                            400,
                            "invalid_request_error",
                            error.to_string(),
                        )),
                    }
                }
            };
            Some(TurnDecision::Plan(plan))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Transport, normalize_request};
    use serde_json::json;

    fn spec() -> ScenarioSpec {
        ScenarioSpec::new("files", 73, "files-v1", BenchmarkTrack::Native)
            .with_fixture(
                "a",
                FixtureDef::File {
                    path: "a.txt".into(),
                    content: "alpha\n".into(),
                },
            )
            .with_fixture(
                "b",
                FixtureDef::File {
                    path: "b.txt".into(),
                    content: "beta\n".into(),
                },
            )
    }

    fn read(path: &str, marker: &str) -> CanonicalAction {
        CanonicalAction::ReadFile {
            path: path.into(),
            expect_marker: marker.into(),
        }
    }

    fn final_answer() -> CanonicalAction {
        CanonicalAction::FinalAnswer {
            text: "proof: files complete".into(),
            expect_markers: vec!["files complete".into()],
        }
    }

    fn engine(spec: ScenarioSpec) -> ScenarioEngine {
        let engine = ScenarioEngine::new(spec, "run-a").unwrap();
        engine
            .register_session("session-a", "lane-1", "/bench/work")
            .unwrap();
        engine
    }

    fn read_decl() -> Value {
        json!({"type": "function", "name": "Read", "parameters": {
            "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"],
            "additionalProperties": false
        }})
    }

    fn normalize(protocol: Protocol, transport: Transport, body: Value) -> NormalizedRequest {
        normalize_request(
            0,
            protocol,
            transport,
            "/v1/responses".into(),
            BTreeMap::from([("x-maka-session-id".into(), "session-a".into())]),
            Default::default(),
            body,
        )
    }

    fn read_catalog() -> ToolCatalog {
        ToolCatalog::from_request(&normalize(
            Protocol::OpenaiResponsesHttp,
            Transport::Http,
            json!({"tools": [read_decl()]}),
        ))
    }

    fn calls(plan: &TurnPlan) -> Vec<&ToolCallSpec> {
        plan.events
            .iter()
            .filter_map(|event| {
                let TurnEvent::ToolCall(call) = event else {
                    return None;
                };
                Some(call)
            })
            .collect()
    }

    fn receipt<'a>(call_id: &'a str, result: &'a Value) -> ToolReceipt<'a> {
        ToolReceipt {
            call_id,
            result,
            outcome: ReceiptOutcome::Success,
        }
    }

    #[test]
    fn faults_retry_the_same_publication_across_http_and_ws_until_receipt() {
        let engine = engine(
            spec()
                .with_step("read", read("a.txt", "alpha"))
                .with_step("done", final_answer())
                .with_fault(ScheduledFault {
                    step: "read".into(),
                    attempt: 1,
                    at: FaultBoundary::BeforeHeaders,
                    emit: FaultKind::Http429,
                })
                .with_fault(ScheduledFault {
                    step: "read".into(),
                    attempt: 2,
                    at: FaultBoundary::BeforeHeaders,
                    emit: FaultKind::Http503,
                }),
        );
        let body = json!({"input": "start", "tools": [read_decl()]});
        let mut http = normalize(Protocol::OpenaiResponsesHttp, Transport::Http, body.clone());
        let first = engine.evaluate_normalized("session-a", &http).unwrap();
        assert!(
            matches!(&first.plan.events[..], [TurnEvent::HttpError(error)] if error.status == 429)
        );
        http.sequence = 99;
        http.headers
            .insert("authorization".into(), "Bearer rotated".into());
        let second = engine.evaluate_normalized("session-a", &http).unwrap();
        assert!(
            matches!(&second.plan.events[..], [TurnEvent::HttpError(error)] if error.status == 503)
        );
        let ws = normalize(
            Protocol::OpenaiResponsesWs,
            Transport::WebSocket {
                connection_id: 7,
                turn_on_connection: 1,
            },
            body,
        );
        let third = engine.evaluate_normalized("session-a", &ws).unwrap();
        let retry = engine.evaluate_normalized("session-a", &http).unwrap();
        for evaluation in [&second, &third, &retry] {
            assert_eq!(evaluation.decision.request_key, first.decision.request_key);
            assert_eq!(evaluation.plan.response_id, first.plan.response_id);
            assert_eq!(
                evaluation.decision.calls[0].call_id,
                first.decision.calls[0].call_id
            );
            assert!(evaluation.replayed);
        }
        assert_eq!(
            [first.attempt, second.attempt, third.attempt, retry.attempt],
            [1, 2, 3, 4]
        );
        assert_eq!(calls(&third.plan), calls(&retry.plan));
        assert_eq!(
            calls(&third.plan)[0].payload,
            Some(ToolCallPayload::FunctionArgs(json!({"path": "a.txt"})))
        );

        let continuation = normalize(
            Protocol::OpenaiResponsesWs,
            ws.transport,
            json!({
                "previous_response_id": third.decision.response_id,
                "input": [{"type": "function_call_output", "call_id": third.decision.calls[0].call_id, "output": "alpha\n"}],
                "tools": [read_decl()]
            }),
        );
        let done = engine
            .evaluate_normalized("session-a", &continuation)
            .unwrap();
        assert_eq!(done.decision.revision, Revision(2));
        assert!(
            matches!(&done.plan.events[0], TurnEvent::Text { text, .. } if text == "proof: files complete")
        );
        assert!(matches!(
            engine.state("session-a").unwrap(),
            ScenarioSessionState::FinalIssued(_)
        ));
        assert!(matches!(
            engine.verify_completion(
                "session-a",
                CompletionProof {
                    response_id: done.decision.response_id.clone(),
                    observed_markers: BTreeSet::new(),
                }
            ),
            Err(ScenarioError::InvalidCompletionProof)
        ));
        engine
            .verify_completion(
                "session-a",
                CompletionProof {
                    response_id: done.decision.response_id.clone(),
                    observed_markers: BTreeSet::from(["files complete".into()]),
                },
            )
            .unwrap();
        assert!(matches!(
            engine.state("session-a").unwrap(),
            ScenarioSessionState::Verified(_)
        ));
    }

    #[test]
    fn parallel_receipts_are_order_independent_and_never_reissue_confirmed_slots() {
        let engine = engine(
            spec()
                .with_step(
                    "batch",
                    CanonicalAction::ParallelBatch(vec![
                        read("a.txt", "alpha"),
                        read("b.txt", "beta"),
                    ]),
                )
                .with_step("done", final_answer())
                .with_fault(ScheduledFault {
                    step: "batch".into(),
                    attempt: 1,
                    at: FaultBoundary::AfterFirstCompleteCall,
                    emit: FaultKind::Eof,
                }),
        );
        let catalog = read_catalog();
        let request = || ScenarioRequest::new(&catalog, Protocol::OpenaiResponsesHttp);
        let first = engine.evaluate_request("session-a", request()).unwrap();
        assert_eq!(calls(&first.plan).len(), 1);
        assert!(matches!(
            first.plan.events.last(),
            Some(TurnEvent::TruncateEof)
        ));
        let retry = engine.evaluate_request("session-a", request()).unwrap();
        assert_eq!(calls(&retry.plan).len(), 2);
        assert_eq!(calls(&first.plan)[0], calls(&retry.plan)[0]);
        let [first_call, second_call] = retry.decision.calls.as_slice() else {
            panic!("two calls")
        };
        let alpha = json!(["alpha\n"]);
        let beta = json!({"content": "beta\n"});
        let second_receipt = [receipt(&second_call.call_id, &beta)];
        let partial = engine
            .evaluate_request(
                "session-a",
                ScenarioRequest {
                    receipts: &second_receipt,
                    ..request()
                },
            )
            .unwrap();
        assert_eq!(partial.decision.revision, Revision(1));
        assert_eq!(calls(&partial.plan), vec![calls(&retry.plan)[0]]);
        let stale = engine.evaluate_request("session-a", request()).unwrap();
        assert_eq!(calls(&stale.plan), calls(&partial.plan));
        assert!(matches!(
            engine.state("session-a").unwrap(),
            ScenarioSessionState::AwaitingReceipts(PendingBatch { outstanding: 1, .. })
        ));

        let both = [
            receipt(&second_call.call_id, &beta),
            receipt(&first_call.call_id, &alpha),
        ];
        let done = engine
            .evaluate_request(
                "session-a",
                ScenarioRequest {
                    receipts: &both,
                    ..request()
                },
            )
            .unwrap();
        assert_eq!(done.decision.revision, Revision(2));
        let repeat = engine
            .evaluate_request(
                "session-a",
                ScenarioRequest {
                    receipts: &both,
                    ..request()
                },
            )
            .unwrap();
        assert_eq!(repeat.decision.response_id, done.decision.response_id);
        assert!(
            matches!(&repeat.plan.events[0], TurnEvent::Text { text, .. } if text == "proof: files complete")
        );

        let changed = json!("beta but changed");
        assert!(
            matches!(engine.evaluate_request("session-a", ScenarioRequest {
            receipts: &[receipt(&second_call.call_id, &changed)], ..request()
        }), Err(ScenarioError::ChangedReceipt(id)) if id == second_call.call_id)
        );
        engine
            .register_session("session-b", "lane-1", "/bench/other")
            .unwrap();
        assert!(
            matches!(engine.evaluate_request("session-b", ScenarioRequest { receipts: &both, ..request() }),
            Err(ScenarioError::ForeignCall(id)) if id == second_call.call_id)
        );
        assert!(
            matches!(engine.evaluate_request("session-a", ScenarioRequest {
            receipts: &[receipt("unknown-id", &alpha)], ..request()
        }), Err(ScenarioError::UnknownCall(id)) if id == "unknown-id")
        );
    }

    #[test]
    fn concurrent_retries_publish_once_and_transfer_fault_attempts() {
        let engine = engine(
            spec()
                .with_step("read", read("a.txt", "alpha"))
                .with_step("done", final_answer())
                .with_fault(ScheduledFault {
                    step: "read".into(),
                    attempt: 1,
                    at: FaultBoundary::BeforeHeaders,
                    emit: FaultKind::Http429,
                }),
        );
        let catalog = read_catalog();
        let run = || {
            engine
                .evaluate_request(
                    "session-a",
                    ScenarioRequest::new(&catalog, Protocol::OpenaiResponsesHttp),
                )
                .unwrap()
        };
        let (one, other) = std::thread::scope(|scope| {
            let a = scope.spawn(run);
            let b = scope.spawn(run);
            (a.join().unwrap(), b.join().unwrap())
        });
        assert_eq!(one.decision.response_id, other.decision.response_id);
        let (first, second) = if one.attempt == 1 {
            (one, other)
        } else {
            (other, one)
        };
        assert_eq!(second.attempt, 2);
        assert!(
            matches!(&first.plan.events[..], [TurnEvent::HttpError(error)] if error.status == 429)
        );
        assert_eq!(calls(&second.plan)[0].id, first.decision.calls[0].call_id);
    }

    #[test]
    fn failed_next_binding_does_not_forget_a_confirmed_receipt() {
        let engine = engine(
            spec()
                .with_step("read-a", read("a.txt", "alpha"))
                .with_step("read-b", read("b.txt", "beta"))
                .with_step("done", final_answer()),
        );
        let catalog = read_catalog();
        let request = || ScenarioRequest::new(&catalog, Protocol::OpenaiResponsesHttp);
        let first = engine.evaluate_request("session-a", request()).unwrap();
        let alpha = json!("alpha");
        assert!(matches!(
            engine.evaluate_request(
                "session-a",
                ScenarioRequest {
                    catalog: &ToolCatalog::default(),
                    receipts: &[receipt(&first.decision.calls[0].call_id, &alpha)],
                    ..request()
                }
            ),
            Err(ScenarioError::Bind(ToolBindError::UnsupportedAction { .. }))
        ));
        let next = engine.evaluate_request("session-a", request()).unwrap();
        assert_eq!(next.decision.revision, Revision(2));
        assert_eq!(
            calls(&next.plan)[0].payload,
            Some(ToolCallPayload::FunctionArgs(json!({"path": "b.txt"})))
        );
    }

    #[test]
    fn pending_calls_keep_their_identity_if_the_declaration_changes() {
        let engine = engine(
            spec()
                .with_step("read", read("a.txt", "alpha"))
                .with_step("done", final_answer()),
        );
        let good = read_catalog();
        let initial = engine
            .evaluate_request(
                "session-a",
                ScenarioRequest::new(&good, Protocol::OpenaiResponsesHttp),
            )
            .unwrap();
        let mut incompatible = read_decl();
        incompatible["parameters"]["properties"]["path"]["pattern"] = json!("^elsewhere/");
        let incompatible = ToolCatalog::from_request(&normalize(
            Protocol::OpenaiResponsesHttp,
            Transport::Http,
            json!({
                "tools": [incompatible]
            }),
        ));
        let error = engine
            .evaluate_request(
                "session-a",
                ScenarioRequest::new(&incompatible, Protocol::OpenaiResponsesHttp),
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("/properties/path/pattern"),
            "{error}"
        );
        let replay = engine
            .evaluate_request(
                "session-a",
                ScenarioRequest::new(&good, Protocol::OpenaiResponsesHttp),
            )
            .unwrap();
        assert_eq!(initial.plan.response_id, replay.plan.response_id);
        assert_eq!(calls(&initial.plan), calls(&replay.plan));
    }

    #[test]
    fn malformed_arguments_are_wired_as_a_function_call_with_invalid_json() {
        let engine = engine(
            spec()
                .with_step(
                    "malformed",
                    CanonicalAction::BadToolCall {
                        mode: BadToolMode::MalformedJson,
                        expect_handling: FailureHandling::ToolError,
                    },
                )
                .with_step("done", final_answer()),
        );
        let catalog = read_catalog();
        let issued = engine
            .evaluate_request(
                "session-a",
                ScenarioRequest::new(&catalog, Protocol::OpenaiResponsesHttp),
            )
            .unwrap();
        let events = calls(&issued.plan);
        assert_eq!(events[0].name, "Read");
        assert!(!events[0].is_freeform());
        let Some(ToolCallPayload::MalformedRaw(raw)) = &events[0].payload else {
            panic!("expected malformed wire input")
        };
        assert!(serde_json::from_str::<Value>(raw).is_err());
    }

    #[test]
    fn native_checkpoint_requires_matching_returned_evidence() {
        let engine = engine(
            spec()
                .with_step(
                    "compact",
                    CanonicalAction::TriggerCompaction {
                        mode: CompactionMode::Native,
                        proof_marker: "checkpoint-proof".into(),
                    },
                )
                .with_step("done", final_answer()),
        );
        let open = normalize(
            Protocol::OpenaiResponsesHttp,
            Transport::Http,
            json!({"input": "start"}),
        );
        let issued = engine.evaluate_normalized("session-a", &open).unwrap();
        let TurnEvent::NativeCompaction(compaction) = &issued.plan.events[0] else {
            panic!("compaction expected");
        };
        assert_eq!(
            engine
                .evaluate_normalized("session-a", &open)
                .unwrap()
                .decision
                .response_id,
            issued.decision.response_id
        );
        let follow = |marker: &str| {
            normalize(
                Protocol::OpenaiResponsesHttp,
                Transport::Http,
                json!({
                    "previous_response_id": issued.decision.response_id,
                    "input": [{"type": "compaction", "id": compaction.id, "encrypted_content": format!("mock:{marker}")}]
                }),
            )
        };
        assert!(matches!(
            engine.evaluate_normalized("session-a", &follow("wrong")),
            Err(ScenarioError::InvalidCheckpoint)
        ));
        let text = normalize(
            Protocol::OpenaiResponsesHttp,
            Transport::Http,
            json!({"input": compaction.summary}),
        );
        let replay = engine.evaluate_normalized("session-a", &text).unwrap();
        assert_eq!(replay.plan.response_id, issued.plan.response_id);
        let final_answer = engine
            .evaluate_normalized("session-a", &follow("checkpoint-proof"))
            .unwrap();
        assert!(
            matches!(&final_answer.plan.events[0], TurnEvent::Text { text, .. } if text == "proof: files complete")
        );
    }

    #[test]
    fn checkpoint_prompt_requires_a_returned_summary_instead_of_its_own_history() {
        let marker = "checkpoint-proof";
        for protocol in [
            Protocol::OpenaiChatCompletions,
            Protocol::AnthropicMessages,
            Protocol::OpenaiResponsesHttp,
        ] {
            let engine = engine(
                spec()
                    .with_step(
                        "compact",
                        CanonicalAction::TriggerCompaction {
                            mode: CompactionMode::Prompt,
                            proof_marker: marker.into(),
                        },
                    )
                    .with_step("done", final_answer()),
            );
            let request = |body| normalize(protocol, Transport::Http, body);
            let start = request(if protocol.is_responses() {
                json!({"input": "start"})
            } else {
                json!({"messages": [{"role": "user", "content": "start"}]})
            });
            let issued = engine.evaluate_normalized("session-a", &start).unwrap();
            let TurnEvent::Text { text: prompt, .. } = &issued.plan.events[0] else {
                panic!("expected a compaction prompt");
            };
            let (_, checkpoint) = engine.compaction_output("session-a").unwrap();
            let follow = |summary: &str| {
                request(match protocol {
                    Protocol::OpenaiChatCompletions => json!({"messages": [
                        {"role": "assistant", "content": format!("[Conversation summary]\n{summary}")},
                        {"role": "user", "content": "continue"}
                    ]}),
                    Protocol::AnthropicMessages => json!({
                        "system": [{"type": "text", "text": summary}],
                        "messages": [{"role": "user", "content": "continue"}]
                    }),
                    _ => json!({"input": [{"role": "user", "content": summary}]}),
                })
            };
            for stale in [
                prompt.clone(),
                format!("{}_old {marker}", checkpoint.id),
                format!("{} wrong-{marker}", checkpoint.id),
            ] {
                let replay = engine
                    .evaluate_normalized("session-a", &follow(&stale))
                    .unwrap();
                assert_eq!(replay.plan.response_id, issued.plan.response_id);
            }
            let next = engine
                .evaluate_normalized("session-a", &follow(&checkpoint.summary))
                .unwrap();
            assert_eq!(
                next.adopted_checkpoint_id.as_deref(),
                Some(checkpoint.id.as_str())
            );
            assert!(
                matches!(&next.plan.events[0], TurnEvent::Text { text, .. } if text == "proof: files complete")
            );
        }
    }

    #[test]
    fn anthropic_single_tool_choice_disallows_a_parallel_batch() {
        let engine = engine(
            spec()
                .with_step(
                    "batch",
                    CanonicalAction::ParallelBatch(vec![
                        read("a.txt", "alpha"),
                        read("b.txt", "beta"),
                    ]),
                )
                .with_step("done", final_answer()),
        );
        let request = |disabled| {
            normalize(
                Protocol::AnthropicMessages,
                Transport::Http,
                json!({
                    "messages": [{"role": "user", "content": "start"}],
                    "tool_choice": {"type": "auto", "disable_parallel_tool_use": disabled},
                    "tools": [{"name": "Read", "input_schema": read_decl()["parameters"]}]
                }),
            )
        };
        let error = engine
            .evaluate_normalized("session-a", &request(true))
            .unwrap_err();
        assert!(
            error.to_string().contains("disallows multiple tool calls"),
            "{error}"
        );
        let batch = engine
            .evaluate_normalized("session-a", &request(false))
            .unwrap();
        assert_eq!(calls(&batch.plan).len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn large_output_uses_lane_seed_and_has_exact_utf8_byte_count() {
        let bytes = 1024 * 1024 + 1;
        let engine = engine(
            spec()
                .with_fixture(
                    "generated",
                    FixtureDef::LargeOutput {
                        pattern: "fixture 雪".into(),
                    },
                )
                .with_step(
                    "large",
                    CanonicalAction::LargeOutput {
                        fixture: "generated".into(),
                        bytes,
                    },
                )
                .with_step("done", final_answer()),
        );
        engine
            .register_session("session-b", "lane-1", "/bench/other")
            .unwrap();
        engine
            .register_session("session-c", "lane-2", "/bench/third")
            .unwrap();
        let tool = |name: &str, key: &str| {
            json!({"type": "function", "name": name, "parameters": {
                "type": "object", "properties": {key: {"type": "string"}}, "required": [key],
                "additionalProperties": false
            }})
        };
        let req = |name, key| {
            normalize(
                Protocol::OpenaiResponsesHttp,
                Transport::Http,
                json!({"tools": [tool(name, key)]}),
            )
        };
        let first = engine
            .evaluate_normalized("session-a", &req("Shell", "command"))
            .unwrap();
        let peer = engine
            .evaluate_normalized("session-b", &req("exec_command", "cmd"))
            .unwrap();
        let other = engine
            .evaluate_normalized("session-c", &req("Shell", "command"))
            .unwrap();
        let command = |plan: &TurnPlan, key: &str| {
            let Some(ToolCallPayload::FunctionArgs(args)) = &calls(plan)[0].payload else {
                panic!("expected function command");
            };
            args[key].as_str().unwrap().to_owned()
        };
        let shell = command(&first.plan, "command");
        assert_eq!(shell, command(&peer.plan, "cmd"));
        assert_ne!(shell, command(&other.plan, "command"));
        assert_ne!(
            first.decision.calls[0].call_id,
            peer.decision.calls[0].call_id
        );
        assert_ne!(first.decision.response_id, peer.decision.response_id);
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&shell)
            .output()
            .unwrap();
        assert!(out.status.success(), "{:?}", out.stderr);
        assert_eq!(out.stdout.len(), bytes);
        assert!(
            std::str::from_utf8(&out.stdout)
                .unwrap()
                .contains("fixture 雪")
        );
        assert_eq!(
            calls(&first.plan),
            calls(
                &engine
                    .evaluate_normalized("session-a", &req("Shell", "command"))
                    .unwrap()
                    .plan
            )
        );
    }

    #[test]
    fn rejected_tool_call_requires_the_configured_failure_evidence() {
        let engine = engine(
            spec()
                .with_step(
                    "unknown",
                    CanonicalAction::UnknownTool {
                        name: "unlisted_fixture_tool".into(),
                        expect_handling: FailureHandling::ProtocolRejection,
                    },
                )
                .with_step("done", final_answer()),
        );
        let catalog = read_catalog();
        let request = || ScenarioRequest::new(&catalog, Protocol::OpenaiResponsesHttp);
        let issued = engine.evaluate_request("session-a", request()).unwrap();
        assert_eq!(calls(&issued.plan)[0].name, "unlisted_fixture_tool");
        let observation = RunnerObservation {
            session_id: "session-a".into(),
            attempt: issued.attempt,
            call_id: issued.decision.calls[0].call_id.clone(),
            kind: RunnerObservationKind::ProtocolRejection,
            detail: "client rejected the unlisted tool".into(),
        };
        for invalid in [
            RunnerObservation {
                kind: RunnerObservationKind::HarnessTermination,
                ..observation.clone()
            },
            RunnerObservation {
                attempt: issued.attempt + 1,
                ..observation.clone()
            },
            RunnerObservation {
                call_id: "another-call".into(),
                ..observation.clone()
            },
        ] {
            assert!(matches!(
                engine.record_runner_observation("session-a", invalid),
                Err(ScenarioError::InvalidRunnerObservation(_))
            ));
        }
        engine
            .record_runner_observation("session-a", observation.clone())
            .unwrap();
        engine
            .record_runner_observation("session-a", observation)
            .unwrap();
        let done = engine.evaluate_request("session-a", request()).unwrap();
        assert!(
            matches!(&done.plan.events[0], TurnEvent::Text { text, .. } if text == "proof: files complete")
        );
    }

    #[test]
    fn validates_serialized_specs_and_parallel_conflicts() {
        let spec = spec()
            .with_step(
                "batch",
                CanonicalAction::ParallelBatch(vec![
                    read("a.txt", "alpha"),
                    CanonicalAction::WriteFile {
                        path: "a.txt".into(),
                        content: "replacement\n".into(),
                    },
                ]),
            )
            .with_step("done", final_answer());
        let serialized = serde_json::to_string(&spec).unwrap();
        let error = ScenarioSpec::from_json_str(&serialized)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("parallel file access conflicts at \"a.txt\""),
            "{error}"
        );

        #[cfg(feature = "rules")]
        {
            let parsed = ScenarioSpec::from_yaml_str(
                r"
version: 1
scenario: files
seed: 73
fixture: files-v1
track: native
steps:
  - id: done
    finalAnswer:
      text: files complete
      expectMarkers: [files complete]
",
            )
            .unwrap();
            assert_eq!(parsed.steps[0].id, "done");
        }
    }
}
