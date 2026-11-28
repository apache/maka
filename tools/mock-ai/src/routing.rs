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

//! Scoped routing, session identity resolution, request classification, and response lineage.

use crate::protocol::{NormalizedRequest, NormalizedRole};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, hash_map::Entry};

macro_rules! id_types {
    ($($name:ident($inner:ty)),+ $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub $inner);

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    )+};
}

id_types!(
    RunId(String),
    SessionId(String),
    ResponseId(String),
    StepId(String),
    CallId(String),
    Revision(u64),
    AttemptId(u64),
    LogicalLane(String),
    PrincipalId(String),
);

impl std::borrow::Borrow<str> for SessionId {
    fn borrow(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RouteScope {
    pub run_id: RunId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointKind {
    ScopedForbidden,
    Metrics,
    Admin,
    Models,
    ModelById(String),
    ChatCompletions,
    AnthropicMessages,
    AnthropicCountTokens,
    ResponsesCreate,
    ResponsesWs,
    ResponsesCompact,
    GetResponse(String),
    DeleteResponse(String),
    RelayTokenUsage,
    V1Usage,
    ExtraGet(String),
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRoute<'a> {
    pub scope: Option<RouteScope>,
    pub canonical_path: &'a str,
    pub raw_path: &'a str,
    pub query: Option<&'a str>,
    pub endpoint: EndpointKind,
}

impl ParsedRoute<'_> {
    pub fn canonical_path_and_query(&self) -> std::borrow::Cow<'_, str> {
        match self.query {
            Some(query) => format!("{}?{query}", self.canonical_path).into(),
            None => self.canonical_path.into(),
        }
    }
}

fn scoped_parts(path: &str) -> Option<(&str, &str, &str)> {
    let (run, tail) = path.strip_prefix("/s/")?.split_once('/')?;
    let session_end = tail.find('/').unwrap_or(tail.len());
    let (session, canonical) = tail.split_at(session_end);
    (!run.is_empty() && !session.is_empty()).then_some((run, session, canonical))
}

/// Strip the runner prefix from a path or path-and-query, preserving the provider suffix verbatim.
pub fn strip_scope_prefix(path_and_query: &str) -> std::borrow::Cow<'_, str> {
    let (path, query) = path_and_query
        .split_once('?')
        .map_or((path_and_query, None), |(path, query)| (path, Some(query)));
    let Some((_, _, canonical)) = scoped_parts(path) else {
        return path_and_query.into();
    };
    if canonical.is_empty() {
        return match query {
            Some(query) => format!("/?{query}").into(),
            None => "/".into(),
        };
    }
    path_and_query[path.len() - canonical.len()..].into()
}

fn is_admin_path(path: &str) -> bool {
    path == "/admin" || path.starts_with("/admin/")
}

pub(crate) fn is_local_control_path(path: &str) -> bool {
    is_admin_path(path) || path == "/metrics"
}

pub fn parse_route<'a>(
    method: &str,
    path: &'a str,
    query: Option<&'a str>,
    is_ws_upgrade: bool,
    extra_get_routes: &BTreeMap<String, Value>,
) -> ParsedRoute<'a> {
    use EndpointKind::*;

    let (scope, canonical_path) = match scoped_parts(path) {
        Some((run, session, canonical)) => (
            Some(RouteScope {
                run_id: RunId(run.into()),
                session_id: SessionId(session.into()),
            }),
            if canonical.is_empty() { "/" } else { canonical },
        ),
        None => (None, path),
    };
    let endpoint = if scope.is_some() && is_local_control_path(canonical_path) {
        ScopedForbidden
    } else if is_admin_path(canonical_path) {
        Admin
    } else {
        let provider_path = canonical_path
            .strip_prefix("/v1/")
            .unwrap_or_else(|| canonical_path.strip_prefix('/').unwrap_or(canonical_path));
        let mut segments = provider_path.split('/');
        match (
            method,
            is_ws_upgrade,
            segments.next(),
            segments.next(),
            segments.next(),
        ) {
            ("GET", false, ..) if canonical_path == "/metrics" => Metrics,
            ("GET", false, ..) if canonical_path == "/v1/usage" => V1Usage,
            ("GET", false, ..)
                if matches!(canonical_path, "/api/usage/token" | "/api/usage/token/") =>
            {
                RelayTokenUsage
            }
            ("GET", false, Some("models"), None, None) => Models,
            ("GET", false, Some("models"), Some(id), None) if !id.is_empty() => {
                ModelById(id.into())
            }
            ("POST", false, Some("chat"), Some("completions"), None) => ChatCompletions,
            ("POST", false, Some("messages"), None, None) => AnthropicMessages,
            ("POST", false, Some("messages"), Some("count_tokens"), None) => AnthropicCountTokens,
            ("POST", false, Some("responses"), None, None) => ResponsesCreate,
            ("GET", true, Some("responses"), None, None) => ResponsesWs,
            ("POST", false, Some("responses"), Some("compact"), None) => ResponsesCompact,
            (_, _, Some("responses"), Some("compact"), None) => Unknown,
            ("GET", false, Some("responses"), Some(id), None) if !id.is_empty() => {
                GetResponse(id.into())
            }
            ("DELETE", false, Some("responses"), Some(id), None) if !id.is_empty() => {
                DeleteResponse(id.into())
            }
            ("GET", false, ..) if extra_get_routes.contains_key(canonical_path) => {
                ExtraGet(canonical_path.into())
            }
            _ => Unknown,
        }
    };
    ParsedRoute {
        scope,
        canonical_path,
        raw_path: path,
        query,
        endpoint,
    }
}

const SESSION_HEADERS: [&str; 2] = ["x-maka-bench-session", "x-maka-session-id"];

#[cfg(feature = "proxy")]
pub(crate) fn is_runner_routing_header(name: &str) -> bool {
    name.starts_with("x-maka-bench-") || name == "x-maka-session-id"
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialBinding {
    Shared(PrincipalId),
    UniqueTestCredential(PrincipalId),
}

impl CredentialBinding {
    fn principal(&self) -> &PrincipalId {
        match self {
            Self::Shared(id) | Self::UniqueTestCredential(id) => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientSessionSource {
    Header(String),
    MetadataField(String),
}

impl ClientSessionSource {
    fn value<'a>(&self, headers: &'a BTreeMap<String, String>, body: &'a Value) -> Option<&'a str> {
        match self {
            Self::Header(name) => headers.get(name).map(String::as_str),
            Self::MetadataField(name) => body.get("metadata")?.get(name)?.as_str(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientSessionAlias {
    pub source: ClientSessionSource,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRegistration {
    #[serde(alias = "runId", alias = "run")]
    pub run_id: RunId,
    #[serde(alias = "sessionId", alias = "session")]
    pub session_id: SessionId,
    pub harness: String,
    #[serde(alias = "logicalLane", alias = "lane")]
    pub logical_lane: LogicalLane,
    pub scenario: String,
    #[serde(default, alias = "launchMode")]
    pub launch_mode: String,
    #[serde(alias = "credentialBinding", alias = "credential")]
    pub credential_binding: Option<CredentialBinding>,
    #[serde(default, alias = "clientSessionAliases")]
    pub client_session_aliases: Vec<ClientSessionAlias>,
    #[serde(default = "active_registration")]
    pub active: bool,
}

fn active_registration() -> bool {
    true
}

impl SessionRegistration {
    fn principal(&self) -> Option<&PrincipalId> {
        self.credential_binding
            .as_ref()
            .map(CredentialBinding::principal)
    }

    fn accepts(&self, principal: Option<&PrincipalId>) -> bool {
        self.principal()
            .is_none_or(|bound| Some(bound) == principal)
    }
}

type AliasIndex = BTreeMap<ClientSessionSource, HashMap<String, SessionId>>;

#[derive(Debug)]
enum PrincipalSessions {
    Shared(usize),
    Unique(SessionId),
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: HashMap<SessionId, SessionRegistration>,
    credentials: HashMap<PrincipalId, PrincipalSessions>,
    aliases: HashMap<Option<PrincipalId>, AliasIndex>,
    connections: HashMap<u64, SessionId>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum RegistrationError {
    #[error("session {0} is already registered")]
    DuplicateSession(SessionId),
    #[error("invalid session registration")]
    InvalidRegistration,
    #[error("test credential is already bound")]
    DuplicateCredential,
    #[error("stable client session alias is already bound")]
    DuplicateAlias,
    #[error("invalid stable client session alias")]
    InvalidAlias,
}

impl SessionRegistry {
    pub fn register(&mut self, mut record: SessionRegistration) -> Result<(), RegistrationError> {
        use RegistrationError::*;

        if [&record.run_id.0, &record.session_id.0]
            .into_iter()
            .any(|id| id.is_empty() || id.contains(['/', '?', '#']))
            || !record.active
        {
            return Err(InvalidRegistration);
        }
        if self.sessions.contains_key(&record.session_id) {
            return Err(DuplicateSession(record.session_id));
        }
        if let Some(binding) = &record.credential_binding
            && let Some(existing) = self.credentials.get(binding.principal())
            && !matches!(
                (binding, existing),
                (CredentialBinding::Shared(_), PrincipalSessions::Shared(_))
            )
        {
            return Err(DuplicateCredential);
        }

        for alias in &mut record.client_session_aliases {
            let source_is_valid = match &mut alias.source {
                ClientSessionSource::Header(name) => {
                    name.make_ascii_lowercase();
                    !name.is_empty()
                        && !matches!(
                            name.as_str(),
                            "authorization"
                                | "x-api-key"
                                | "api-key"
                                | "x-codex-turn-state"
                                | "prompt_cache_key"
                        )
                        && !name.starts_with("x-maka-bench-")
                        && !SESSION_HEADERS.contains(&name.as_str())
                }
                ClientSessionSource::MetadataField(name) => !matches!(
                    name.as_str(),
                    "" | "prompt_cache_key" | "x-codex-turn-state"
                ),
            };
            if !source_is_valid || alias.value.is_empty() {
                return Err(InvalidAlias);
            }
        }
        let principal = record.principal().cloned();
        let aliases = self.aliases.get(&principal);
        for alias in &record.client_session_aliases {
            if aliases
                .and_then(|index| index.get(&alias.source))
                .is_some_and(|values| values.contains_key(&alias.value))
            {
                return Err(DuplicateAlias);
            }
        }

        match &record.credential_binding {
            Some(CredentialBinding::UniqueTestCredential(principal)) => {
                self.credentials.insert(
                    principal.clone(),
                    PrincipalSessions::Unique(record.session_id.clone()),
                );
            }
            Some(CredentialBinding::Shared(principal)) => {
                let PrincipalSessions::Shared(count) = self
                    .credentials
                    .entry(principal.clone())
                    .or_insert(PrincipalSessions::Shared(0))
                else {
                    unreachable!("conflicting credentials were rejected");
                };
                *count += 1;
            }
            None => {}
        }
        for alias in &record.client_session_aliases {
            self.aliases
                .entry(principal.clone())
                .or_default()
                .entry(alias.source.clone())
                .or_default()
                .insert(alias.value.clone(), record.session_id.clone());
        }
        self.sessions.insert(record.session_id.clone(), record);
        Ok(())
    }

    pub fn get(&self, session: &SessionId) -> Option<&SessionRegistration> {
        self.sessions.get(session)
    }

    pub fn finalize(&mut self, session: &SessionId) -> bool {
        let Some(record) = self
            .sessions
            .get_mut(session)
            .filter(|record| record.active)
        else {
            return false;
        };
        record.active = false;
        if let Some(principal) = record.principal()
            && let Entry::Occupied(mut entry) = self.credentials.entry(principal.clone())
        {
            match entry.get_mut() {
                PrincipalSessions::Shared(count) if *count > 1 => *count -= 1,
                _ => {
                    entry.remove();
                }
            }
        }
        let principal = record.principal().cloned();
        if let Some(index) = self.aliases.get_mut(&principal) {
            for alias in &record.client_session_aliases {
                if let std::collections::btree_map::Entry::Occupied(mut source) =
                    index.entry(alias.source.clone())
                {
                    source.get_mut().remove(&alias.value);
                    if source.get().is_empty() {
                        source.remove();
                    }
                }
            }
            if index.is_empty() {
                self.aliases.remove(&principal);
            }
        }
        true
    }

    pub(crate) fn remove_session(&mut self, session: &SessionId) {
        self.finalize(session);
        self.sessions.remove(session);
        self.connections.retain(|_, owner| owner != session);
    }

    pub fn bind_connection(
        &mut self,
        connection: u64,
        session: &SessionId,
    ) -> Result<(), IdentityError> {
        if !self.get(session).is_some_and(|record| record.active) {
            return Err(IdentityError::Unroutable);
        }
        match self.connections.entry(connection) {
            Entry::Vacant(entry) => {
                entry.insert(session.clone());
                Ok(())
            }
            Entry::Occupied(entry) if entry.get() == session => Ok(()),
            Entry::Occupied(entry) => Err(IdentityError::Conflict {
                preferred: session.clone(),
                conflicting: entry.get().clone(),
                evidence: IdentitySource::WebSocket,
            }),
        }
    }

    pub fn unbind_connection(&mut self, connection: u64) {
        self.connections.remove(&connection);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentitySource {
    PathScope,
    RunnerHeader,
    TestCredential,
    ClientAlias,
    PreviousResponse,
    WebSocket,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum IdentityError {
    #[error("request has no registered session identity")]
    Unroutable,
    #[error("unknown benchmark scope {run_id}/{session_id}")]
    UnknownScope {
        run_id: RunId,
        session_id: SessionId,
    },
    #[error("unregistered session in {0}")]
    UnknownSessionHeader(&'static str),
    #[error("session {0} is finalized")]
    InactiveSession(SessionId),
    #[error("authenticated principal does not own session {0}")]
    PrincipalMismatch(SessionId),
    #[error("session {preferred} conflicts with {conflicting} from {evidence:?}")]
    Conflict {
        preferred: SessionId,
        conflicting: SessionId,
        evidence: IdentitySource,
    },
}

pub struct IdentityRequest<'a> {
    pub scope: Option<&'a RouteScope>,
    /// The authenticated fixture principal, determined by the caller before resolving identity.
    pub principal: Option<&'a PrincipalId>,
    pub headers: &'a BTreeMap<String, String>,
    pub body: &'a Value,
    pub previous_response_id: Option<&'a ResponseId>,
    pub connection_id: Option<u64>,
}

pub struct SessionIdentityResolver<'a> {
    registry: &'a SessionRegistry,
    lineage: &'a LineageStore,
}

impl<'a> SessionIdentityResolver<'a> {
    pub fn new(registry: &'a SessionRegistry, lineage: &'a LineageStore) -> Self {
        Self { registry, lineage }
    }

    pub fn resolve(
        &self,
        request: IdentityRequest<'_>,
    ) -> Result<&'a SessionRegistration, IdentityError> {
        let mut preferred: Option<&SessionRegistration> = None;
        let mut consider = |candidate: &'a SessionRegistration, evidence| {
            if let Some(first) = preferred
                && first.session_id != candidate.session_id
            {
                return Err(IdentityError::Conflict {
                    preferred: first.session_id.clone(),
                    conflicting: candidate.session_id.clone(),
                    evidence,
                });
            }
            if !candidate.active {
                return Err(IdentityError::InactiveSession(candidate.session_id.clone()));
            }
            if !candidate.accepts(request.principal) {
                return Err(IdentityError::PrincipalMismatch(
                    candidate.session_id.clone(),
                ));
            }
            preferred = Some(candidate);
            Ok(())
        };

        if let Some(scope) = request.scope {
            let record = self
                .registry
                .get(&scope.session_id)
                .filter(|record| record.run_id == scope.run_id)
                .ok_or_else(|| IdentityError::UnknownScope {
                    run_id: scope.run_id.clone(),
                    session_id: scope.session_id.clone(),
                })?;
            consider(record, IdentitySource::PathScope)?;
        }
        for name in SESSION_HEADERS {
            if let Some(value) = request.headers.get(name) {
                let record = self
                    .registry
                    .sessions
                    .get(value.as_str())
                    .ok_or(IdentityError::UnknownSessionHeader(name))?;
                consider(record, IdentitySource::RunnerHeader)?;
            }
        }
        if let Some(PrincipalSessions::Unique(session)) = request
            .principal
            .and_then(|id| self.registry.credentials.get(id))
        {
            consider(
                &self.registry.sessions[session],
                IdentitySource::TestCredential,
            )?;
        }
        if let Some(aliases) = self.registry.aliases.get(&request.principal.cloned()) {
            for (source, values) in aliases {
                if let Some(session) = source
                    .value(request.headers, request.body)
                    .and_then(|value| values.get(value))
                {
                    consider(
                        &self.registry.sessions[session],
                        IdentitySource::ClientAlias,
                    )?;
                }
            }
        }
        if let Some(record) = request
            .previous_response_id
            .and_then(|id| self.lineage.owner(id))
            .and_then(|owner| self.registry.get(owner))
            .filter(|record| record.active && record.principal() == request.principal)
        {
            consider(record, IdentitySource::PreviousResponse)?;
        }
        if let Some(session) = request
            .connection_id
            .and_then(|id| self.registry.connections.get(&id))
        {
            consider(&self.registry.sessions[session], IdentitySource::WebSocket)?;
        }
        preferred.ok_or(IdentityError::Unroutable)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestUse {
    Main,
    Side(SideKind),
    Compact(CompactKind),
    Control,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SideKind {
    Title,
    Probe,
    SummaryAux,
    Custom(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactKind {
    ResponsesEndpoint,
    ResponsesTrigger,
    AnthropicNative,
    ClientSummary,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RequestClassifier {
    pub paths: BTreeMap<String, RequestUse>,
    pub model_aliases: BTreeMap<String, RequestUse>,
}

impl RequestClassifier {
    /// Call after the runner headers and harness identity have been verified.
    pub fn classify(
        &self,
        route: &ParsedRoute<'_>,
        request: &NormalizedRequest,
        harness: Option<&str>,
    ) -> RequestUse {
        use EndpointKind::*;
        use RequestUse::*;

        match route.endpoint {
            ResponsesCompact => return Compact(CompactKind::ResponsesEndpoint),
            ResponsesCreate | ResponsesWs if request.has_compaction_trigger => {
                return Compact(CompactKind::ResponsesTrigger);
            }
            ChatCompletions | AnthropicMessages | ResponsesCreate | ResponsesWs | Unknown => {}
            _ => return Control,
        }
        let explicit = self
            .paths
            .get(route.canonical_path)
            .cloned()
            .or_else(|| {
                request
                    .headers
                    .get("x-maka-bench-request-use")
                    .and_then(|value| {
                        Some(match value.as_str() {
                            "title" => Side(SideKind::Title),
                            "probe" => Side(SideKind::Probe),
                            "summary_aux" => Side(SideKind::SummaryAux),
                            "client_summary" => Compact(CompactKind::ClientSummary),
                            "anthropic_native" => Compact(CompactKind::AnthropicNative),
                            value => {
                                Side(SideKind::Custom(value.strip_prefix("side:")?.to_owned()))
                            }
                        })
                    })
            })
            .or_else(|| self.model_aliases.get(&request.model).cloned());

        let system = request.system_text.as_deref().unwrap_or("");
        let is_opencode = harness.is_some_and(|h| h == "opencode" || h.starts_with("opencode-"));
        let is_claude = harness
            .is_some_and(|h| h == "claude" || h == "claude-code" || h.starts_with("claude-"))
            && route.endpoint == AnthropicMessages;
        let is_codex = harness.is_some_and(|h| h == "codex" || h.starts_with("codex-"));
        let last_user = request
            .messages
            .last()
            .filter(|msg| msg.role == NormalizedRole::User)
            .map_or("", |msg| msg.text.as_str());

        let opencode_summary = is_opencode
            && ((last_user
                .starts_with("Provide a detailed prompt for continuing our conversation above.")
                && last_user.contains("## Discoveries")
                && last_user.contains("## Accomplished"))
                || ((last_user.starts_with(
                    "You MUST summarize the conversation above into a structured summary",
                ) || last_user
                    .starts_with("Update the existing checkpoint in the conversation above"))
                    && last_user
                        .contains("Return only the structured summary in the requested format.")));
        let claude_summary = is_claude
            && last_user.starts_with("CRITICAL: Respond with TEXT ONLY.")
            && last_user.contains("Your task is to create a detailed summary of the conversation")
            && last_user.contains("<analysis>")
            && last_user.contains("<summary>");
        let codex_summary = is_codex
            && matches!(route.endpoint, ResponsesCreate | ResponsesWs)
            && request.tools.is_empty()
            && request.last_user_text().is_some_and(|text| {
                text.starts_with(
                    "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM",
                )
            });
        if opencode_summary || claude_summary || codex_summary {
            return Compact(CompactKind::ClientSummary);
        }
        if let Some(explicit) = explicit {
            return explicit;
        }

        // A native edit can be configured on every turn. Only an explicit compaction-only
        // request is a separate operation; a normal turn can trigger compaction in its response.
        if route.endpoint == AnthropicMessages
            && request.anthropic_compaction_enabled
            && request.options.anthropic_pause_after_compaction
        {
            return Compact(CompactKind::AnthropicNative);
        }

        if !request.tools.is_empty() {
            return Main;
        }
        if is_opencode
            && (system.contains("You are a title generator. You output ONLY a thread title.")
                || ((last_user
                    .starts_with("Here is the first message of the conversation:\n\n<message>\n")
                    && last_user.ends_with("</message>\n\nReply with only the title."))
                    || (last_user
                        .starts_with("Here is the conversation so far:\n\n<conversation>\n")
                        && last_user.ends_with("</conversation>\n\nReply with only the title.")))
                    && request
                        .messages
                        .iter()
                        .filter(|msg| msg.role == NormalizedRole::User)
                        .count()
                        == 1)
        {
            return Side(SideKind::Title);
        }
        if is_claude {
            if system.contains("Generate a concise, sentence-case title (3-7 words)")
                && system.contains("Return JSON with a single \"title\" field.")
            {
                return Side(SideKind::Title);
            }
            if request.options.max_output_tokens == Some(1)
                && system.is_empty()
                && request.messages.len() == 1
                && last_user == "quota"
            {
                return Side(SideKind::Probe);
            }
        }
        Main
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseLineage {
    pub response_id: ResponseId,
    pub owner_session: SessionId,
    pub parent_id: Option<ResponseId>,
    pub logical_revision: Revision,
    pub effective_context_tokens: u64,
    pub effective_context_bytes: usize,
    /// Whether an authorized request can resume independently of the originating connection.
    pub resumable: bool,
    /// Whether the protocol allows a stored body for this response.
    pub store_readable: bool,
    pub created_on_conn: Option<u64>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum LineageError {
    #[error("previous_response_not_found: {0}")]
    PreviousResponseNotFound(ResponseId),
    #[error("cross_session_parent: {0}")]
    CrossSessionParent(ResponseId),
    #[error("deleted_parent: {0}")]
    DeletedParent(ResponseId),
    #[error("response {0} already has lineage")]
    DuplicateResponse(ResponseId),
}

#[derive(Debug)]
enum LineageEntry {
    Live(ResponseLineage),
    Deleted(SessionId),
}

impl LineageEntry {
    fn owner(&self) -> &SessionId {
        match self {
            Self::Live(response) => &response.owner_session,
            Self::Deleted(owner) => owner,
        }
    }
}

#[derive(Debug, Default)]
pub struct LineageStore {
    entries: HashMap<ResponseId, LineageEntry>,
    latest_on_connection: HashMap<u64, ResponseId>,
}

impl LineageStore {
    pub fn insert(&mut self, response: ResponseLineage) -> Result<(), LineageError> {
        self.insert_with_parent_check(response, true)
    }

    pub(crate) fn insert_admitted(
        &mut self,
        response: ResponseLineage,
    ) -> Result<(), LineageError> {
        self.insert_with_parent_check(response, false)
    }

    fn insert_with_parent_check(
        &mut self,
        response: ResponseLineage,
        check_parent: bool,
    ) -> Result<(), LineageError> {
        if self.entries.contains_key(&response.response_id) {
            return Err(LineageError::DuplicateResponse(response.response_id));
        }
        if check_parent && let Some(parent) = &response.parent_id {
            self.resolve_parent(&response.owner_session, parent, response.created_on_conn)?;
        }
        if let Some(connection) = response.created_on_conn {
            self.latest_on_connection
                .insert(connection, response.response_id.clone());
        }
        self.entries
            .insert(response.response_id.clone(), LineageEntry::Live(response));
        Ok(())
    }

    pub fn owner(&self, id: &ResponseId) -> Option<&SessionId> {
        self.entries.get(id).map(LineageEntry::owner)
    }

    pub fn resolve_parent(
        &self,
        owner: &SessionId,
        id: &ResponseId,
        connection: Option<u64>,
    ) -> Result<&ResponseLineage, LineageError> {
        use LineageError::*;

        match self.entries.get(id) {
            Some(entry) if entry.owner() == owner => match entry {
                LineageEntry::Live(response) => {
                    let is_baseline = connection
                        .is_some_and(|conn| self.latest_on_connection.get(&conn) == Some(id));
                    if response.resumable || is_baseline {
                        Ok(response)
                    } else {
                        Err(PreviousResponseNotFound(id.clone()))
                    }
                }
                LineageEntry::Deleted(_) => Err(DeletedParent(id.clone())),
            },
            Some(_) => Err(CrossSessionParent(id.clone())),
            None => Err(PreviousResponseNotFound(id.clone())),
        }
    }

    pub fn delete_owned(&mut self, owner: &SessionId, id: &ResponseId) -> bool {
        if let Some(entry @ LineageEntry::Live(_)) = self.entries.get_mut(id)
            && let LineageEntry::Live(response) = entry
            && &response.owner_session == owner
            && response.store_readable
        {
            if let Some(conn) = response.created_on_conn
                && self.latest_on_connection.get(&conn) == Some(id)
            {
                self.latest_on_connection.remove(&conn);
            }
            *entry = LineageEntry::Deleted(owner.clone());
            true
        } else {
            false
        }
    }

    pub(crate) fn observe_on_connection(&mut self, connection: u64, id: &ResponseId) {
        if matches!(self.entries.get(id), Some(LineageEntry::Live(_))) {
            self.latest_on_connection.insert(connection, id.clone());
        }
    }

    pub(crate) fn remove_owner(&mut self, owner: &SessionId) {
        self.entries.retain(|_, entry| entry.owner() != owner);
        self.latest_on_connection
            .retain(|_, id| self.entries.contains_key(id));
    }

    pub fn close_connection(&mut self, connection: u64) {
        self.latest_on_connection.remove(&connection);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Protocol, Transport, normalize_request};
    use serde_json::json;

    fn registration(
        id: &str,
        credential_binding: Option<CredentialBinding>,
    ) -> SessionRegistration {
        SessionRegistration {
            run_id: RunId("run".into()),
            session_id: SessionId(id.into()),
            harness: "opencode".into(),
            logical_lane: LogicalLane(id.into()),
            scenario: "benchmark".into(),
            launch_mode: "cold".into(),
            credential_binding,
            client_session_aliases: Vec::new(),
            active: true,
        }
    }

    #[test]
    fn scoped_static_routes_take_precedence_over_ids_and_extras() {
        let extra = BTreeMap::from([("/v1/responses/compact".into(), json!({}))]);
        let path = "/s/run/a/v1/responses/compact";
        let route = parse_route("POST", path, Some("beta=1"), false, &extra);
        assert_eq!(route.scope.unwrap().session_id, SessionId("a".into()));
        assert_eq!(route.canonical_path, "/v1/responses/compact");
        assert_eq!(route.raw_path, path);
        assert_eq!(route.endpoint, EndpointKind::ResponsesCompact);
        assert_eq!(
            strip_scope_prefix("/s/run/a/v1/responses/compact?beta=%2f&beta=1"),
            "/v1/responses/compact?beta=%2f&beta=1"
        );
        for (method, path, upgrade, expected) in [
            ("GET", path, false, EndpointKind::Unknown),
            ("DELETE", path, false, EndpointKind::Unknown),
            (
                "GET",
                "/s/run/a/admin/reset",
                false,
                EndpointKind::ScopedForbidden,
            ),
            (
                "GET",
                "/s/run/a/metrics",
                false,
                EndpointKind::ScopedForbidden,
            ),
            (
                "GET",
                "/s/run/a/responses/r1",
                false,
                EndpointKind::GetResponse("r1".into()),
            ),
            (
                "GET",
                "/s/run/a/responses/r1/more",
                false,
                EndpointKind::Unknown,
            ),
            (
                "GET",
                "/s/run/a/v1/responses",
                true,
                EndpointKind::ResponsesWs,
            ),
            ("GET", "/s/run/a/v1/responses", false, EndpointKind::Unknown),
        ] {
            assert_eq!(
                parse_route(method, path, None, upgrade, &extra).endpoint,
                expected
            );
        }
    }

    #[test]
    fn identical_openers_in_64_sessions_remain_distinct_after_the_opener_is_dropped() {
        let shared = PrincipalId("shared".into());
        let mut registry = SessionRegistry::default();
        for i in 0..64 {
            registry
                .register(registration(
                    &format!("s{i}"),
                    Some(CredentialBinding::Shared(shared.clone())),
                ))
                .unwrap();
        }
        let lineage = LineageStore::default();
        let resolver = SessionIdentityResolver::new(&registry, &lineage);
        let empty_headers = BTreeMap::new();
        let initial = json!({"messages":[{"role":"user","content":"same task"}]});
        let compacted = json!({
            "messages":[{"role":"user","content":"continue from checkpoint"}],
            "prompt_cache_key": "shared",
        });
        for i in 0..64 {
            let id = SessionId(format!("s{i}"));
            let scope = RouteScope {
                run_id: RunId("run".into()),
                session_id: id.clone(),
            };
            for body in [&initial, &compacted] {
                let resolved = resolver
                    .resolve(IdentityRequest {
                        scope: Some(&scope),
                        principal: Some(&shared),
                        headers: &empty_headers,
                        body,
                        previous_response_id: None,
                        connection_id: None,
                    })
                    .unwrap();
                assert_eq!(resolved.session_id, id);
            }
        }
        let weak_headers = BTreeMap::from([("x-codex-turn-state".into(), "s0".into())]);
        assert_eq!(
            resolver
                .resolve(IdentityRequest {
                    scope: None,
                    principal: Some(&shared),
                    headers: &weak_headers,
                    body: &compacted,
                    previous_response_id: None,
                    connection_id: None,
                })
                .unwrap_err(),
            IdentityError::Unroutable
        );
    }

    #[test]
    fn independent_authorities_must_agree_and_previous_owner_requires_same_principal() {
        let shared = PrincipalId("shared".into());
        let unique = PrincipalId("one-to-one".into());
        let mut registry = SessionRegistry::default();
        registry
            .register(registration(
                "a",
                Some(CredentialBinding::Shared(shared.clone())),
            ))
            .unwrap();
        let mut b = registration("b", Some(CredentialBinding::Shared(shared.clone())));
        b.client_session_aliases.push(ClientSessionAlias {
            source: ClientSessionSource::MetadataField("client_session".into()),
            value: "client-b".into(),
        });
        registry.register(b).unwrap();
        registry
            .register(registration(
                "c",
                Some(CredentialBinding::UniqueTestCredential(unique.clone())),
            ))
            .unwrap();
        registry
            .bind_connection(10, &SessionId("b".into()))
            .unwrap();

        let a_id = SessionId("a".into());
        let b_id = SessionId("b".into());
        let mut lineage = LineageStore::default();
        let a_response = response("r-a", &a_id, None, None, true);
        lineage.insert(a_response.clone()).unwrap();

        let scope = RouteScope {
            run_id: RunId("run".into()),
            session_id: a_id.clone(),
        };
        let header = BTreeMap::from([("x-maka-bench-session".into(), "b".into())]);
        let empty = BTreeMap::new();
        let body = json!({});
        let metadata = json!({"metadata":{"client_session":"client-b"}});
        let resolver = SessionIdentityResolver::new(&registry, &lineage);
        let request = || IdentityRequest {
            scope: None,
            principal: Some(&shared),
            headers: &empty,
            body: &body,
            previous_response_id: None,
            connection_id: None,
        };
        assert_eq!(
            resolver
                .resolve(IdentityRequest {
                    scope: Some(&scope),
                    headers: &header,
                    ..request()
                })
                .unwrap_err(),
            IdentityError::Conflict {
                preferred: a_id.clone(),
                conflicting: b_id.clone(),
                evidence: IdentitySource::RunnerHeader
            },
        );
        for req in [
            IdentityRequest {
                headers: &header,
                ..request()
            },
            IdentityRequest {
                body: &metadata,
                ..request()
            },
            IdentityRequest {
                connection_id: Some(10),
                ..request()
            },
        ] {
            assert_eq!(resolver.resolve(req).unwrap().session_id, b_id);
        }
        assert_eq!(
            resolver
                .resolve(IdentityRequest {
                    previous_response_id: Some(&a_response.response_id),
                    ..request()
                })
                .unwrap()
                .session_id,
            a_id
        );
        assert_eq!(
            resolver
                .resolve(IdentityRequest {
                    principal: None,
                    previous_response_id: Some(&a_response.response_id),
                    ..request()
                })
                .unwrap_err(),
            IdentityError::Unroutable,
        );
        assert_eq!(
            resolver
                .resolve(IdentityRequest {
                    principal: Some(&unique),
                    ..request()
                })
                .unwrap()
                .session_id
                .0,
            "c"
        );
        assert!(registry.finalize(&b_id));
        assert_eq!(
            SessionIdentityResolver::new(&registry, &lineage)
                .resolve(IdentityRequest {
                    headers: &header,
                    ..request()
                })
                .unwrap_err(),
            IdentityError::InactiveSession(b_id)
        );
    }

    fn response(
        id: &str,
        owner: &SessionId,
        parent: Option<&str>,
        connection: Option<u64>,
        store: bool,
    ) -> ResponseLineage {
        ResponseLineage {
            response_id: ResponseId(id.into()),
            parent_id: parent.map(|id| ResponseId(id.into())),
            owner_session: owner.clone(),
            logical_revision: Revision(1),
            effective_context_tokens: 22,
            effective_context_bytes: 90,
            created_on_conn: connection,
            resumable: store,
            store_readable: store,
        }
    }

    #[test]
    fn transient_parent_works_only_as_the_latest_same_connection_baseline() {
        let owner = SessionId("owner".into());
        let intruder = SessionId("other".into());
        let transient = ResponseId("ephemeral".into());
        let persisted = ResponseId("persisted".into());
        let mut lineage = LineageStore::default();
        lineage
            .insert(response("ephemeral", &owner, None, Some(10), false))
            .unwrap();
        assert_eq!(
            lineage
                .resolve_parent(&owner, &transient, Some(10))
                .unwrap()
                .effective_context_tokens,
            22
        );
        assert_eq!(
            lineage.resolve_parent(&owner, &transient, Some(11)),
            Err(LineageError::PreviousResponseNotFound(transient.clone()))
        );
        assert_eq!(
            lineage.resolve_parent(&intruder, &transient, Some(10)),
            Err(LineageError::CrossSessionParent(transient.clone()))
        );
        assert!(!lineage.delete_owned(&owner, &transient));
        lineage
            .insert(response(
                "persisted",
                &owner,
                Some("ephemeral"),
                Some(10),
                true,
            ))
            .unwrap();
        assert_eq!(
            lineage.resolve_parent(&owner, &transient, Some(10)),
            Err(LineageError::PreviousResponseNotFound(transient))
        );
        lineage.close_connection(10);
        assert_eq!(
            lineage
                .resolve_parent(&owner, &persisted, Some(11))
                .unwrap()
                .logical_revision,
            Revision(1)
        );
        assert!(!lineage.delete_owned(&intruder, &persisted));
        assert!(lineage.delete_owned(&owner, &persisted));
        assert_eq!(
            lineage.resolve_parent(&owner, &persisted, None),
            Err(LineageError::DeletedParent(persisted))
        );
    }

    fn classify(harness: &str, protocol: Protocol, body: Value) -> RequestUse {
        let path = match protocol {
            Protocol::AnthropicMessages => "/v1/messages",
            _ => "/v1/chat/completions",
        };
        let req = normalize_request(
            1,
            protocol,
            Transport::Http,
            path.into(),
            BTreeMap::new(),
            body.to_string().into(),
            body,
        );
        let routes = BTreeMap::new();
        RequestClassifier::default().classify(
            &parse_route("POST", path, None, false, &routes),
            &req,
            Some(harness),
        )
    }

    #[test]
    fn only_known_title_and_probe_shapes_leave_the_main_lane() {
        let v2_title = json!({"messages":[{"role":"user","content":
            "Here is the first message of the conversation:\n\n<message>\nFix tests\n</message>\n\nReply with only the title."
        }]});
        assert_eq!(
            classify(
                "opencode",
                Protocol::OpenaiChatCompletions,
                v2_title.clone()
            ),
            RequestUse::Side(SideKind::Title)
        );
        assert_eq!(
            classify("unknown", Protocol::OpenaiChatCompletions, v2_title),
            RequestUse::Main
        );

        let claude = Protocol::AnthropicMessages;
        let title = json!({
            "system":[{"type":"text","text":"Generate a concise, sentence-case title (3-7 words) ... Return JSON with a single \"title\" field."}],
            "messages":[{"role":"user","content":"Fix tests"}]
        });
        assert_eq!(
            classify("claude-code", claude, title),
            RequestUse::Side(SideKind::Title)
        );
        for (model, prompt, max_tokens, expected) in [
            (
                "claude-haiku-4-5-20251001",
                "quota",
                1,
                RequestUse::Side(SideKind::Probe),
            ),
            (
                "claude-haiku-4-5-20251001",
                "给文章起标题",
                1,
                RequestUse::Main,
            ),
            ("claude-haiku-4-5-20251001", "quota", 16, RequestUse::Main),
        ] {
            let body = json!({"model":model, "max_tokens":max_tokens, "messages":[{"role":"user","content":prompt}]});
            assert_eq!(classify("claude-code", claude, body), expected);
        }
    }

    #[test]
    fn compaction_summary_is_a_checkpoint_operation() {
        let codex = Protocol::OpenaiResponsesHttp;
        let ordinary = json!({"input": [
            {"role": "user", "content": "Can you explain what a CONTEXT CHECKPOINT COMPACTION is and how a handoff summary works?"}
        ]});
        assert_eq!(classify("codex", codex, ordinary), RequestUse::Main);

        let body = json!({"messages":[
            {"role":"user","content":"Implement feature A"},
            {"role":"assistant","content":"I edited the request parser."},
            {"role":"user","content":"You MUST summarize the conversation above into a structured summary ... Return only the structured summary in the requested format."}
        ]});
        assert_eq!(
            classify("opencode", Protocol::OpenaiChatCompletions, body),
            RequestUse::Compact(CompactKind::ClientSummary)
        );

        let mut body = json!({
            "messages":[{"role":"user","content":"Continue feature A"}],
            "context_management":{"edits":[{"type":"compact_20260112"}]},
        });
        assert_eq!(
            classify("claude-code", Protocol::AnthropicMessages, body.clone()),
            RequestUse::Main
        );
        body["context_management"]["edits"][0]["pause_after_compaction"] = json!(true);
        assert_eq!(
            classify("claude-code", Protocol::AnthropicMessages, body),
            RequestUse::Compact(CompactKind::AnthropicNative)
        );
    }
}
