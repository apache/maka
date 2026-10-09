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

//! The Host's runtime policy as the settings surface reads and writes it:
//! one `runtime.policy.query` for every page that shows part of it (with
//! `credential.vault.query` for whether the network proxy's password is
//! saved), `runtime.policy.mutate` for a change, and
//! `runtime.policy.network-proxy.update` for the proxy and its password,
//! each retried once after a revision conflict.

use gpui_kit::{App, Context, Entity, SharedString, Subscription, Task};
use host_protocol::{
    CredentialLocator, CredentialStatus, CredentialVaultQuery, CredentialVaultQueryInput,
    CredentialVaultQueryResult, HostOperationErrorCode, NetworkProxyCredentialUpdate,
    NetworkProxyPolicy, NetworkProxyUpdate, NetworkProxyUpdateInput, NetworkProxyUpdateResult,
    RuntimePolicy, RuntimePolicyMutate, RuntimePolicyMutateInput, RuntimePolicyMutateResult,
    RuntimePolicyMutation, RuntimePolicyQuery, RuntimePolicyQueryInput, RuntimePolicySnapshot,
};
use shared::copy::Locale;
use shared::copy::settings as copy;
use workspace::{HostRequestError, HostRequester, HostSession, HostSessionEvent};

/// Where reading the policy stands. A loaded snapshot stays while it is
/// read again or a change is sent.
#[derive(Debug, Clone, PartialEq)]
enum PolicyState {
    Idle,
    Loading,
    Loaded(Box<RuntimePolicySnapshot>),
    Failed(SharedString),
}

/// Why the Host did not take a change: the reason as a clause for
/// [`shared::copy::failure`], and the error code when the Host answered
/// with one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    reason: String,
    code: Option<HostOperationErrorCode>,
}

impl Refusal {
    fn new(reason: impl Into<String>) -> Self {
        Self { reason: reason.into(), code: None }
    }

    /// The Host's error, as its sentence.
    pub(crate) fn from_error(error: &HostRequestError, locale: Locale) -> Self {
        let code = match error {
            HostRequestError::Operation { code, .. } => Some(code.clone()),
            _ => None,
        };
        Self { reason: host_error_reason(error, locale), code }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    /// The Host's error code, when it answered with one.
    pub fn code(&self) -> Option<&HostOperationErrorCode> {
        self.code.as_ref()
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

/// What a proxy change does with the saved password.
#[derive(Clone, PartialEq, Eq)]
pub enum ProxyPassword {
    /// Leave it as saved (deleted when authentication is turned off).
    Keep,
    /// Save this one instead. Its `Debug` leaves it out.
    Replace(String),
}

impl std::fmt::Debug for ProxyPassword {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Keep => f.write_str("Keep"),
            Self::Replace(_) => f.write_str("Replace(..)"),
        }
    }
}

/// Behavior owner of the runtime policy for one settings surface.
///
/// It reads the policy when the Host is connected, and again on each new
/// connection; a failed read keeps a snapshot it already had. A change is
/// described by a function from the policy to the mutation that makes it,
/// so a retry after a revision conflict builds it again from the policy as
/// it then stands (the other fields of the section kept as read). One
/// change runs at a time; while it does, [`Self::policy`] is the policy as
/// the change leaves it, so the pages show the new value at once, and a
/// refusal puts the committed one back. Once committed the snapshot shows
/// the change at the new revision; what the Host normalized in it (trimmed
/// text, a subagent preset it dropped) shows at the next read.
///
/// It knows whether the proxy password is saved, never the password: the
/// Host keeps it in its vault and answers only its status.
pub struct HostPolicy {
    host: Entity<HostSession>,
    state: PolicyState,
    /// The policy as the change in flight leaves it.
    pending: Option<Box<RuntimePolicy>>,
    /// The proxy password's status, read with the policy.
    proxy_password: Option<CredentialStatus>,
    saving: bool,
    _load: Option<Task<()>>,
    _subscription: Subscription,
}

impl std::fmt::Debug for HostPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostPolicy")
            .field("state", &self.state)
            .field("saving", &self.saving)
            .finish_non_exhaustive()
    }
}

impl HostPolicy {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscription = cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
            if matches!(event, HostSessionEvent::Connected { .. }) {
                this.reload(cx);
            }
        });
        let mut this = Self {
            host,
            state: PolicyState::Idle,
            pending: None,
            proxy_password: None,
            saving: false,
            _load: None,
            _subscription: subscription,
        };
        this.reload(cx);
        this
    }

    /// The policy as last read, with its revision.
    pub fn snapshot(&self) -> Option<&RuntimePolicySnapshot> {
        match &self.state {
            PolicyState::Loaded(snapshot) => Some(snapshot),
            _ => None,
        }
    }

    /// The policy to show: as a change in flight leaves it, else as read.
    pub fn policy(&self) -> Option<&RuntimePolicy> {
        let committed = &self.snapshot()?.policy;
        Some(self.pending.as_deref().unwrap_or(committed))
    }

    /// Whether the Host has the network proxy's password saved.
    pub fn proxy_password_saved(&self) -> bool {
        self.proxy_password.as_ref().is_some_and(|status| status.configured)
    }

    /// Whether the first read is in flight (or waits for a connection).
    pub fn is_loading(&self) -> bool {
        matches!(self.state, PolicyState::Idle | PolicyState::Loading)
    }

    /// Why the policy could not be read, while there is none to show.
    pub fn load_error(&self) -> Option<&SharedString> {
        match &self.state {
            PolicyState::Failed(message) => Some(message),
            _ => None,
        }
    }

    /// Whether a change is in flight.
    pub fn is_saving(&self) -> bool {
        self.saving
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    /// Reads the policy again, unless there is no connection to read on or
    /// a change is in flight.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() || self.saving {
            return;
        }
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        if !matches!(self.state, PolicyState::Loaded(_)) {
            self.state = PolicyState::Loading;
        }
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = requester.request::<RuntimePolicyQuery>(&RuntimePolicyQueryInput {}).await;
            // The password's status is read beside the policy; without it
            // the password reads as not saved.
            let password = read_proxy_password(&requester).await;
            this.update(cx, |this, cx| {
                this._load = None;
                match result {
                    Ok(snapshot) => this.state = PolicyState::Loaded(Box::new(snapshot)),
                    Err(error) => {
                        log::warn!("runtime.policy.query failed: {error}");
                        if !matches!(this.state, PolicyState::Loaded(_)) {
                            this.state =
                                PolicyState::Failed(host_error_reason(&error, locale).into());
                        }
                    }
                }
                match password {
                    Ok(status) => this.proxy_password = status,
                    Err(error) => log::warn!("credential.vault.query failed: {error}"),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Sends the mutation `change` builds from the policy, at its revision.
    /// `change` returns `None` when the policy already says what is asked,
    /// and nothing is sent. The task resolves once the change is committed,
    /// or with the reason it was not, in `locale`. Returns `None` (nothing
    /// sent) before the policy is read or while another change is in flight.
    pub fn mutate(
        &mut self,
        change: impl Fn(&RuntimePolicy) -> Option<RuntimePolicyMutation> + 'static,
        locale: Locale,
        cx: &mut Context<Self>,
    ) -> Option<Task<Result<(), Refusal>>> {
        let snapshot = Box::new(self.snapshot()?.clone());
        if self.saving {
            return None;
        }
        let requester = self.requester(cx);
        self.saving = true;
        self.pending = change(&snapshot.policy).map(|mutation| {
            let mut policy = Box::new(snapshot.policy.clone());
            apply(&mut policy, mutation);
            policy
        });
        cx.notify();
        Some(cx.spawn(async move |this, cx| {
            let result = send(&requester, snapshot, &change, locale).await;
            this.update(cx, |this, cx| this.finish(result.map(|snapshot| (snapshot, None)), cx))
                .unwrap_or_else(|_| Err(Refusal::new(copy::UNEXPECTED.in_locale(locale))))
        }))
    }

    /// Writes the proxy policy `change` makes of the proxy as read, with
    /// the password kept or replaced as `password` says (deleted instead
    /// while authentication is off, as the Host requires), through
    /// `runtime.policy.network-proxy.update`. A stale policy or password
    /// reads both again and tries once more. Like [`Self::mutate`] the task
    /// resolves with the reason a change was refused, and nothing is sent
    /// (`None`) before the policy is read or while a change is in flight.
    pub fn update_proxy(
        &mut self,
        change: impl Fn(&NetworkProxyPolicy) -> NetworkProxyPolicy + 'static,
        password: ProxyPassword,
        locale: Locale,
        cx: &mut Context<Self>,
    ) -> Option<Task<Result<(), Refusal>>> {
        let snapshot = Box::new(self.snapshot()?.clone());
        if self.saving {
            return None;
        }
        let requester = self.requester(cx);
        let status = self.proxy_password.clone();
        self.saving = true;
        let mut pending = Box::new(snapshot.policy.clone());
        pending.network_proxy = change(&snapshot.policy.network_proxy);
        self.pending = Some(pending);
        cx.notify();
        Some(cx.spawn(async move |this, cx| {
            let result = send_proxy(&requester, snapshot, status, &change, &password, locale).await;
            this.update(cx, |this, cx| {
                this.finish(result.map(|(snapshot, status)| (snapshot, Some(status))), cx)
            })
            .unwrap_or_else(|_| Err(Refusal::new(copy::UNEXPECTED.in_locale(locale))))
        }))
    }

    /// Takes a change's outcome: the committed policy (and password status),
    /// or the reason with the newest policy read on the way.
    fn finish(
        &mut self,
        result: Result<
            (Box<RuntimePolicySnapshot>, Option<Option<CredentialStatus>>),
            (Refusal, Option<Box<RuntimePolicySnapshot>>),
        >,
        cx: &mut Context<Self>,
    ) -> Result<(), Refusal> {
        self.saving = false;
        self.pending = None;
        let outcome = match result {
            Ok((snapshot, password)) => {
                self.state = PolicyState::Loaded(snapshot);
                if let Some(password) = password {
                    self.proxy_password = password;
                }
                Ok(())
            }
            Err((reason, fresh)) => {
                // A conflict's fresh read is still the newest policy.
                if let Some(fresh) = fresh {
                    self.state = PolicyState::Loaded(fresh);
                }
                log::warn!("a runtime policy change was refused: {reason}");
                Err(reason)
            }
        };
        cx.notify();
        outcome
    }
}

/// The reason a request to the Host failed, as the clause a settings error
/// ends with: a sentence for each error code the settings operations
/// declare, the transport's own words otherwise.
pub(crate) fn host_error_reason(error: &HostRequestError, locale: Locale) -> String {
    let text = match error {
        HostRequestError::NotConnected => copy::HOST_ERROR_NOT_CONNECTED,
        HostRequestError::Operation { code, message, .. } => match code {
            HostOperationErrorCode::HostNotReady => copy::HOST_ERROR_NOT_READY,
            HostOperationErrorCode::HostDraining => copy::HOST_ERROR_DRAINING,
            HostOperationErrorCode::OperationUnavailable => copy::HOST_ERROR_UNAVAILABLE,
            HostOperationErrorCode::InvalidRequest => copy::HOST_ERROR_INVALID,
            HostOperationErrorCode::InternalFailure => copy::HOST_ERROR_INTERNAL,
            HostOperationErrorCode::PersistenceFailed => copy::HOST_ERROR_PERSISTENCE,
            HostOperationErrorCode::CommitOutcomeUnknown => copy::HOST_ERROR_OUTCOME_UNKNOWN,
            HostOperationErrorCode::Unauthorized => copy::HOST_ERROR_UNAUTHORIZED,
            // A code no settings operation declares: the Host's words.
            _ => return message.to_string(),
        },
        _ => return error.to_string(),
    };
    text.in_locale(locale).to_owned()
}

/// The proxy password's status: `None` when the Host answers a kind this
/// client does not know.
async fn read_proxy_password(
    requester: &HostRequester,
) -> Result<Option<CredentialStatus>, HostRequestError> {
    let input = CredentialVaultQueryInput::new(CredentialLocator::network_proxy_password());
    Ok(match requester.request::<CredentialVaultQuery>(&input).await? {
        CredentialVaultQueryResult::Status { status } => Some(status),
        _ => None,
    })
}

/// A refused change, with the policy read on the way when there was one.
type Refused = (Refusal, Option<Box<RuntimePolicySnapshot>>);

/// Sends `change` at the snapshot's revision; after a conflict, reads the
/// policy and tries once more. Returns the policy as it now stands, or the
/// reason with the policy read in between, if one was.
async fn send(
    requester: &HostRequester,
    mut snapshot: Box<RuntimePolicySnapshot>,
    change: &impl Fn(&RuntimePolicy) -> Option<RuntimePolicyMutation>,
    locale: Locale,
) -> Result<Box<RuntimePolicySnapshot>, Refused> {
    let mut fresh = None;
    for attempt in 0..2 {
        let Some(mutation) = change(&snapshot.policy) else {
            return Ok(snapshot);
        };
        let input = RuntimePolicyMutateInput::new(snapshot.revision, mutation.clone());
        log::info!("runtime.policy.mutate at revision {}", snapshot.revision);
        match requester.request::<RuntimePolicyMutate>(&input).await {
            Ok(RuntimePolicyMutateResult::Committed { revision }) => {
                apply(&mut snapshot.policy, mutation);
                snapshot.revision = revision;
                return Ok(snapshot);
            }
            Ok(RuntimePolicyMutateResult::RevisionConflict { .. }) if attempt == 0 => {
                snapshot = Box::new(
                    requester
                        .request::<RuntimePolicyQuery>(&RuntimePolicyQueryInput {})
                        .await
                        .map_err(|error| (Refusal::from_error(&error, locale), None))?,
                );
                fresh = Some(snapshot.clone());
            }
            Ok(RuntimePolicyMutateResult::RevisionConflict { .. }) => break,
            Ok(_) => return Err((Refusal::new(copy::UNEXPECTED.in_locale(locale)), fresh)),
            Err(error) => return Err((Refusal::from_error(&error, locale), fresh)),
        }
    }
    Err((Refusal::new(copy::POLICY_KEPT_CHANGING.in_locale(locale)), fresh))
}

/// Sends the proxy `change` makes at the snapshot's revision and against
/// the password `status` read; after a stale policy or password, reads both
/// and tries once more. Returns the policy and the password's status as
/// they now stand, or the reason with the policy read in between, if one
/// was.
async fn send_proxy(
    requester: &HostRequester,
    mut snapshot: Box<RuntimePolicySnapshot>,
    mut status: Option<CredentialStatus>,
    change: &impl Fn(&NetworkProxyPolicy) -> NetworkProxyPolicy,
    password: &ProxyPassword,
    locale: Locale,
) -> Result<(Box<RuntimePolicySnapshot>, Option<CredentialStatus>), Refused> {
    let mut fresh = None;
    for attempt in 0..2 {
        let proxy = change(&snapshot.policy.network_proxy);
        let credential = match password {
            _ if !proxy.auth_enabled => NetworkProxyCredentialUpdate::Delete,
            ProxyPassword::Replace(secret) => NetworkProxyCredentialUpdate::Replace {
                secret: secret.clone(),
                expected_target: None,
            },
            ProxyPassword::Keep => NetworkProxyCredentialUpdate::Keep,
        };
        let basis = status.as_ref().and_then(CredentialStatus::basis);
        let input =
            NetworkProxyUpdateInput::new(snapshot.revision, basis, proxy.clone(), credential);
        log::info!("runtime.policy.network-proxy.update at revision {}", snapshot.revision);
        match requester.request::<NetworkProxyUpdate>(&input).await {
            Ok(NetworkProxyUpdateResult::Committed { revision, credential_status }) => {
                snapshot.policy.network_proxy = proxy;
                snapshot.revision = revision;
                return Ok((snapshot, Some(credential_status)));
            }
            Ok(
                NetworkProxyUpdateResult::RevisionConflict { .. }
                | NetworkProxyUpdateResult::CredentialStale { .. },
            ) if attempt == 0 => {
                let read = |error: HostRequestError| (Refusal::from_error(&error, locale), None);
                snapshot = Box::new(
                    requester
                        .request::<RuntimePolicyQuery>(&RuntimePolicyQueryInput {})
                        .await
                        .map_err(read)?,
                );
                fresh = Some(snapshot.clone());
                status = read_proxy_password(requester)
                    .await
                    .map_err(|error| (Refusal::from_error(&error, locale), fresh.clone()))?;
            }
            Ok(NetworkProxyUpdateResult::RevisionConflict { .. }) => {
                return Err((Refusal::new(copy::POLICY_KEPT_CHANGING.in_locale(locale)), fresh));
            }
            Ok(NetworkProxyUpdateResult::CredentialStale { .. }) => {
                let reason = copy::PROXY_PASSWORD_KEPT_CHANGING.in_locale(locale);
                return Err((Refusal::new(reason), fresh));
            }
            Ok(NetworkProxyUpdateResult::ProxyTargetMismatch { .. }) => {
                return Err((Refusal::new(copy::PROXY_TARGET_CHANGED.in_locale(locale)), fresh));
            }
            Ok(_) => return Err((Refusal::new(copy::UNEXPECTED.in_locale(locale)), fresh)),
            Err(error) => return Err((Refusal::from_error(&error, locale), fresh)),
        }
    }
    Err((Refusal::new(copy::POLICY_KEPT_CHANGING.in_locale(locale)), fresh))
}

/// Writes a committed `mutation` into this client's copy of the policy:
/// a `set_*` replaces its section, `patch_agent_settings` the fields it
/// gives (as the Host's `applyMutation` in
/// packages/storage/src/runtime-policy/policy-document.ts does).
fn apply(policy: &mut RuntimePolicy, mutation: RuntimePolicyMutation) {
    match mutation {
        RuntimePolicyMutation::SetJev { value } => policy.jev = Some(value),
        RuntimePolicyMutation::SetNetworkProxy { value } => policy.network_proxy = value,
        RuntimePolicyMutation::SetPersonalization { value } => policy.personalization = value,
        RuntimePolicyMutation::SetMemory { value } => policy.memory = value,
        RuntimePolicyMutation::SetWorkspaceInstructions { value } => {
            policy.workspace_instructions = value
        }
        RuntimePolicyMutation::SetPrivacy { value } => policy.privacy = value,
        RuntimePolicyMutation::SetChatDefaults { mut value } => {
            // The Host stores Code Mode only when on.
            if value.code_mode_enabled == Some(false) {
                value.code_mode_enabled = None;
            }
            policy.chat_defaults = value
        }
        RuntimePolicyMutation::SetWebSearch { value } => policy.web_search = value,
        RuntimePolicyMutation::SetSubagents { value } => policy.subagents = value,
        RuntimePolicyMutation::SetExternalAgents { value } => policy.external_agents = value,
        RuntimePolicyMutation::SetShell { value } => policy.shell = value,
        RuntimePolicyMutation::PatchAgentSettings { value } => {
            if let Some(patch) = value.personalization {
                if let Some(name) = patch.display_name {
                    policy.personalization.display_name = name;
                }
                if let Some(tone) = patch.assistant_tone {
                    policy.personalization.assistant_tone = tone;
                }
            }
            if let Some(patch) = value.memory {
                if let Some(enabled) = patch.enabled {
                    policy.memory.enabled = enabled;
                }
                if let Some(enabled) = patch.agent_read_enabled {
                    policy.memory.agent_read_enabled = enabled;
                }
            }
            if let Some(enabled) = value.workspace_instructions.and_then(|patch| patch.enabled) {
                policy.workspace_instructions.enabled = enabled;
            }
            if let Some(active) = value.privacy.and_then(|patch| patch.incognito_active) {
                policy.privacy.incognito_active = active;
            }
            if let Some(enabled) = value.web_search.and_then(|patch| patch.enabled) {
                policy.web_search.enabled = enabled;
            }
        }
        // A kind this client does not send.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use host_protocol::{
        AgentRuntimeSettingsPatch, EnabledPatch, MemoryPolicy, PrivacyPatch, ShellPolicy,
        ShellPreference,
    };

    use super::*;

    fn policy() -> RuntimePolicy {
        serde_json::from_value(crate::tests::policy_json("ask")).expect("policy")
    }

    #[test]
    fn a_committed_change_shows_in_the_clients_copy() {
        let mut policy = policy();
        apply(
            &mut policy,
            RuntimePolicyMutation::SetMemory { value: MemoryPolicy::new(false, true) },
        );
        assert_eq!(policy.memory, MemoryPolicy::new(false, true));
        apply(
            &mut policy,
            RuntimePolicyMutation::SetShell {
                value: ShellPolicy::new(ShellPreference::GitBash, "C:\\bash.exe"),
            },
        );
        assert_eq!(policy.shell.preference, ShellPreference::GitBash);
        let mut patch = AgentRuntimeSettingsPatch::default();
        patch.privacy = Some(PrivacyPatch::new(true));
        patch.web_search = Some(EnabledPatch::new(true));
        let before = policy.clone();
        apply(&mut policy, RuntimePolicyMutation::PatchAgentSettings { value: patch });
        assert!(policy.privacy.incognito_active);
        assert!(policy.web_search.enabled);
        assert_eq!(policy.web_search.default_provider, before.web_search.default_provider);
        assert_eq!(policy.memory, before.memory, "sections the patch leaves out stay");
    }
}
