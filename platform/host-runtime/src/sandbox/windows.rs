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

mod accounts;
mod executions;
mod guards;
mod launch;
pub use launch::Backend;
mod policy;
mod provision;
mod reads;
pub use reads::{READ_PREPARATION, prepare_default_reads};
mod network;
mod store;
pub use accounts::{WriteAccess, WriteRule};
use maka_sandbox::filesystem::Rule;

// Shared read surfaces reuse a slot concurrently. Different surfaces must never
// mutate one another's account ACLs; exhausted capacity fails admission promptly.
const ACCOUNT_SLOTS: usize = 8;
pub use provision::{Operation, Provision};

use maka_event_log::root::FileLease;
/// Installation state, not a claim that every filesystem policy is supported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    NotRequired,
    NotConfigured,
    SetupRequired,
    Ready,
    Removing,
    Busy,
}

/// Preferred Windows isolation needs no installation on MXC-capable systems.
/// Individual commands still check whether MXC can enforce their whole policy;
/// unsupported policies require the explicitly configured account sandbox.
pub fn status(state_root: &Path) -> io::Result<Status> {
    if maka_sandbox::windows::mxc::is_available() {
        Ok(Status::NotRequired)
    } else {
        Installation::new(state_root).status()
    }
}

use maka_sandbox::Network;
use maka_sandbox::windows::{
    Account, AccountId, Credential, ExecutionJob, NetworkRules, Password, ReadGroup,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

/// One State Root's native provisioning authority. Opening this value has no
/// side effects; only setup may create the private control directory.
pub struct Installation {
    root: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupRequest {
    id: Uuid,
    owner: String,
    offline: Vec<Identity>,
    online: Vec<Identity>,
    proxy_ports: Vec<std::num::NonZeroU16>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    id: AccountId,
    credential: Credential,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configured {
    namespace: Uuid,
    read_group_sid: String,
    offline_sids: Vec<String>,
    online_sids: Vec<String>,
    proxy_ports: Vec<std::num::NonZeroU16>,
}

/// Holds exclusive ownership until the privileged helper has completed and
/// its result is committed. Dropping it leaves the immutable intent recoverable.
pub struct Setup {
    installation: Installation,
    _lease: FileLease,
    request: SetupRequest,
    _preparation: reads::Foreground,
}
pub struct Removal {
    installation: Installation,
    _lease: FileLease,
    request: Option<SetupRequest>,
    executions: Vec<Uuid>,
    _preparation: reads::Foreground,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemovalRequest {
    namespace: Uuid,
    accounts: Vec<AccountId>,
    executions: Vec<Uuid>,
    owner: String,
}
#[derive(Serialize, Deserialize)]
#[serde(transparent)]
pub struct Removed(Uuid);
pub struct ExecutionAccount {
    pub id: Uuid,
    pub capability: Uuid,
    pub account: Account,
    pub password: Password,
    pub job: Arc<ExecutionJob>,
    /// Retain through native tree settlement, including in the trusted runner.
    pub leases: Vec<File>,
    pub proxy_port: Option<std::num::NonZeroU16>,
}

impl Installation {
    pub fn new(state_root: &Path) -> Self {
        Self {
            root: state_root.join("windows-sandbox"),
        }
    }

    /// Observe recovery state without starting setup, revoking ACLs or waiting
    /// for an installation owner. A lost helper reply is resolved from here.
    pub fn status(&self) -> io::Result<Status> {
        let _lease = match store::shared_lease(&self.root.join("lifecycle.lock")) {
            Ok(lease) => lease,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Status::NotConfigured);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return Ok(Status::Busy);
            }
            Err(error) => return Err(error),
        };
        if self.root.join("removing").try_exists()? {
            return Ok(Status::Removing);
        }
        let Some(request) = store::read::<SetupRequest>(&self.root.join("installation.json"))?
        else {
            return Ok(Status::NotConfigured);
        };
        request.validate_owner()?;
        let Some(configured) = store::read::<Configured>(&self.root.join("ready.json"))? else {
            return Ok(Status::SetupRequired);
        };
        request.validate(&configured)?;
        Ok(match request.validate_accounts(&configured)? {
            AccountState::Ready => Status::Ready,
            AccountState::RepairRequired => Status::SetupRequired,
        })
    }

    pub fn begin_setup(&self) -> io::Result<Setup> {
        let preparation = reads::Foreground::acquire()?;
        maka_event_log::root::private_directory(&self.root)?;
        match maka_event_log::root::windows::create_private_file(&self.root.join("lifecycle.lock"))
        {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let lease = FileLease::acquire(&self.root.join("lifecycle.lock"))?;
        if self.root.join("removing").try_exists()? {
            return Err(io::Error::other(
                "finish Windows sandbox removal before setup",
            ));
        }
        executions::recover(&self.root)?;
        accounts::recover(&self.root)?;
        guards::recover()?;
        store::lease_file(&self.root.join("admission.lock"))?;
        let request = match store::read(&self.root.join("installation.json"))? {
            Some(request) => request,
            None => {
                let owner = maka_event_log::root::windows::account_sid()?;
                let listeners = (0..ACCOUNT_SLOTS)
                    .map(|_| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)))
                    .collect::<io::Result<Vec<_>>>()?;
                let proxy_ports = listeners
                    .iter()
                    .map(|listener| {
                        listener.local_addr().map(|address| {
                            std::num::NonZeroU16::new(address.port()).expect("bound port")
                        })
                    })
                    .collect::<io::Result<Vec<_>>>()?;
                let identity = || -> io::Result<Identity> {
                    Ok(Identity {
                        id: AccountId::new(Uuid::new_v4(), &owner)?,
                        credential: Password::generate().protect()?,
                    })
                };
                let request = SetupRequest {
                    id: Uuid::new_v4(),
                    offline: (0..ACCOUNT_SLOTS)
                        .map(|_| identity())
                        .collect::<io::Result<_>>()?,
                    online: (0..ACCOUNT_SLOTS)
                        .map(|_| identity())
                        .collect::<io::Result<_>>()?,
                    owner,
                    proxy_ports,
                };
                store::publish(&self.root, "installation.json", &request)?;
                request
            }
        };
        request.validate_owner()?;
        if let Some(configured) = store::read::<Configured>(&self.root.join("ready.json"))? {
            request.validate(&configured)?;
            // Retire the old SID snapshot before privileged repair. If an
            // account must be recreated and the reply is lost, its new SID
            // belongs to this still-persisted intent, not a foreign installation.
            if matches!(
                request.validate_accounts(&configured)?,
                AccountState::RepairRequired
            ) {
                reads::recover(&self.root)?;
                store::remove(&self.root.join("ready.json"))?;
            }
        } else {
            reads::recover(&self.root)?;
        }
        Ok(Setup {
            installation: Self {
                root: self.root.clone(),
            },
            _lease: lease,
            request,
            _preparation: preparation,
        })
    }

    pub fn begin_removal(&self) -> io::Result<Removal> {
        let preparation = reads::Foreground::acquire()?;
        let lease = FileLease::acquire(&self.root.join("lifecycle.lock"))?;
        let request: Option<SetupRequest> = store::read(&self.root.join("installation.json"))?;
        if let Some(request) = &request {
            request.validate_owner()?;
        }
        let executions = executions::list(&self.root)?;
        store::publish(&self.root, "removing", &true)?;
        Ok(Removal {
            installation: Self {
                root: self.root.clone(),
            },
            _lease: lease,
            request,
            executions,
            _preparation: preparation,
        })
    }

    /// Never creates accounts or elevates. The caller must surface
    /// setup-required instead of silently weakening the requested isolation.
    pub fn execution(
        &self,
        network: Network,
        reads: &[Rule],
        writes: &[WriteRule],
    ) -> io::Result<ExecutionAccount> {
        let _preparation = reads::Foreground::acquire()?;
        let lease = store::shared_lease(&self.root.join("lifecycle.lock"))?;
        if self.root.join("removing").try_exists()? {
            return Err(io::Error::other("Windows sandbox is being removed"));
        }
        let request: SetupRequest = store::required(&self.root.join("installation.json"))?;
        request.validate_owner()?;
        let configured: Configured = store::required(&self.root.join("ready.json"))?;
        request.validate(&configured)?;
        let _admission = store::admission(&self.root)?;
        let surface = accounts::Plan::capture(reads, writes, &network)?;
        let (identities, expected) = match &network {
            Network::Denied | Network::Restricted { .. } => {
                (&request.offline, &configured.offline_sids)
            }
            Network::Allowed => (&request.online, &configured.online_sids),
        };
        let mut available = Vec::with_capacity(identities.len());
        for (index, (identity, expected)) in identities.iter().zip(expected).enumerate() {
            let account = identity.id.resolve()?.ok_or_else(setup_required)?;
            if account.sid() != expected || !account.is_enabled() {
                return Err(setup_required());
            }
            let matches = surface.matches(&self.root, &account)?;
            available.push((!matches, identity, account, index));
        }
        // Prefer the existing surface, even if an earlier slot is idle. This
        // preserves capacity for genuinely different policies and avoids ACL churn.
        available.sort_by_key(|(different, _, _, _)| *different);
        let mut selected = None;
        for (_, identity, account, index) in available {
            if let Some((surface_lease, capability)) = surface.acquire(&self.root, &account)? {
                selected = Some((
                    account,
                    identity.credential.unprotect()?,
                    surface_lease,
                    capability,
                    index,
                ));
                break;
            }
        }
        let (account, password, surface_lease, capability, index) = selected.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                "sandbox isolation capacity is busy; retry after an execution finishes",
            )
        })?;
        // The recovery identity reaches disk before the first native process.
        // Each WithLogon tree needs its own Job; a shared installation Job
        // cannot span Secondary Logon's independent parent hierarchies.
        let id = executions::begin(&self.root, account.sid())?;
        let job = Arc::new(ExecutionJob::create(id)?);
        Ok(ExecutionAccount {
            id,
            capability,
            account,
            password,
            job,
            leases: vec![lease, surface_lease],
            proxy_port: matches!(network, Network::Restricted { .. })
                .then(|| request.proxy_ports[index]),
        })
    }

    /// Forget only a confirmed empty native tree. A crash before this point
    /// leaves its identity for exclusive setup/removal recovery.
    pub fn settle(&self, execution: Uuid) -> io::Result<()> {
        let _preparation = reads::Foreground::acquire()?;
        let _lease = store::shared_lease(&self.root.join("lifecycle.lock"))?;
        let _admission = store::admission(&self.root)?;
        executions::settle(&self.root, execution)
    }
}

impl Setup {
    pub fn request(&self) -> &SetupRequest {
        &self.request
    }

    pub fn finish(self, configured: Configured) -> io::Result<()> {
        self.request.validate(&configured)?;
        if matches!(
            self.request.validate_accounts(&configured)?,
            AccountState::RepairRequired
        ) {
            return Err(setup_required());
        }
        store::publish(&self.installation.root, "ready.json", &configured)
    }
}

impl SetupRequest {
    fn read_group(&self) -> io::Result<ReadGroup> {
        ReadGroup::new(self.namespace(), &self.owner)
    }
    fn namespace(&self) -> Uuid {
        use sha2::{Digest, Sha256};
        // Private intent is user-editable. Binding native names to the captured
        // owner prevents a consented helper from adopting another user's WFP
        // namespace merely because its UUID is known.
        let mut hash = Sha256::new();
        hash.update(b"Maka Windows sandbox network\0");
        hash.update(self.owner.as_bytes());
        hash.update([0]);
        hash.update(self.id.as_bytes());
        Uuid::from_bytes(hash.finalize()[..16].try_into().expect("SHA-256 prefix"))
    }

    fn validate_owner(&self) -> io::Result<()> {
        if self.owner != maka_event_log::root::windows::account_sid()?
            || self.offline.len() != ACCOUNT_SLOTS
            || self.online.len() != ACCOUNT_SLOTS
            || self.proxy_ports.len() != ACCOUNT_SLOTS
            || self
                .proxy_ports
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != ACCOUNT_SLOTS
            || self
                .offline
                .iter()
                .chain(&self.online)
                .any(|identity| identity.id.owner() != self.owner)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox installation belongs to another OS user",
            ));
        }
        Ok(())
    }

    /// Run by an authenticated privileged helper, after the Host has persisted
    /// this request and acquired its exclusive installation lease.
    pub fn apply(&self) -> io::Result<Configured> {
        let ensure = |identity: &Identity| {
            identity
                .id
                .ensure(identity.credential.unprotect()?.as_wide())
        };
        let offline = self
            .offline
            .iter()
            .map(ensure)
            .collect::<io::Result<Vec<_>>>()?;
        let online = self
            .online
            .iter()
            .map(ensure)
            .collect::<io::Result<Vec<_>>>()?;
        let read_group_sid = self
            .read_group()?
            .ensure(&offline.iter().chain(&online).collect::<Vec<_>>())?;
        NetworkRules::new(self.namespace()).install(
            &offline
                .iter()
                .zip(&self.proxy_ports)
                .map(|(account, port)| maka_sandbox::windows::AccountNetwork {
                    sid: account.sid(),
                    proxy_port: Some(*port),
                })
                .collect::<Vec<_>>(),
            &online.iter().map(Account::sid).collect::<Vec<_>>(),
        )?;
        for account in offline.iter().chain(&online) {
            account.set_enabled(true)?;
        }
        Ok(Configured {
            namespace: self.namespace(),
            read_group_sid,
            offline_sids: offline.iter().map(|account| account.sid().into()).collect(),
            online_sids: online.iter().map(|account| account.sid().into()).collect(),
            proxy_ports: self.proxy_ports.clone(),
        })
    }

    fn validate(&self, configured: &Configured) -> io::Result<()> {
        if self.namespace() != configured.namespace
            || self.proxy_ports != configured.proxy_ports
            || configured.offline_sids.len() != ACCOUNT_SLOTS
            || configured.online_sids.len() != ACCOUNT_SLOTS
            || configured
                .offline_sids
                .iter()
                .chain(&configured.online_sids)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != ACCOUNT_SLOTS * 2
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox setup identity mismatch",
            ));
        }
        Ok(())
    }

    fn validate_accounts(&self, configured: &Configured) -> io::Result<AccountState> {
        let mut state = AccountState::Ready;
        match self.read_group()?.resolve()? {
            Some(sid) if sid == configured.read_group_sid => {}
            None => state = AccountState::RepairRequired,
            Some(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "sandbox read group identity differs from its installation",
                ));
            }
        }
        for (identity, expected) in self
            .offline
            .iter()
            .zip(&configured.offline_sids)
            .chain(self.online.iter().zip(&configured.online_sids))
        {
            let Some(current) = identity.id.resolve()? else {
                state = AccountState::RepairRequired;
                continue;
            };
            if current.sid() != expected {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "sandbox account identity differs from its installation",
                ));
            }
            if !current.is_enabled() {
                state = AccountState::RepairRequired;
            }
        }
        Ok(state)
    }
}

#[derive(Clone, Copy)]
enum AccountState {
    RepairRequired,
    Ready,
}

fn setup_required() -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, "Windows sandbox setup is required")
}

impl Removal {
    pub fn request(&self) -> Option<RemovalRequest> {
        self.request.as_ref().map(|request| RemovalRequest {
            namespace: request.namespace(),
            accounts: request
                .offline
                .iter()
                .chain(&request.online)
                .map(|identity| identity.id.clone())
                .collect(),
            executions: self.executions.clone(),
            owner: request.owner.clone(),
        })
    }

    pub fn finish(self, receipt: Option<Removed>) -> io::Result<()> {
        match (&self.request, receipt) {
            (Some(request), Some(Removed(id))) if request.namespace() == id => {
                for identity in request.offline.iter().chain(&request.online) {
                    if identity.id.resolve()?.is_some() {
                        return Err(io::Error::other("sandbox account removal is incomplete"));
                    }
                }
                if request.read_group()?.resolve()?.is_some() {
                    return Err(io::Error::other("sandbox read group removal is incomplete"));
                }
            }
            (None, None) => {}
            _ => return Err(io::Error::other("sandbox removal receipt does not match")),
        }
        // The intent disappears only after privileged cleanup is acknowledged.
        // Keep the stable lock inode; removing it would split lifecycle owners.
        executions::recover(&self.installation.root)?;
        accounts::recover(&self.installation.root)?;
        reads::recover(&self.installation.root)?;
        guards::recover()?;
        for name in [
            "ready.json",
            "installation.json",
            ".ready.json.pending",
            ".installation.json.pending",
            ".removing.pending",
            "removing",
        ] {
            store::remove(&self.installation.root.join(name))?;
        }
        Ok(())
    }
}

impl RemovalRequest {
    pub fn apply(&self) -> io::Result<Removed> {
        let accounts = self
            .accounts
            .iter()
            .map(AccountId::resolve)
            .collect::<io::Result<Vec<_>>>()?;
        for account in accounts.iter().flatten() {
            account.set_enabled(false)?;
        }
        // The shared lease blocks normal concurrent admission; each persisted
        // Job identity also covers trees still settling after a crashed Host.
        for execution in &self.executions {
            maka_sandbox::windows::ensure_drained(*execution)?;
        }
        for account in &self.accounts {
            account.remove()?;
        }
        ReadGroup::new(self.namespace, &self.owner)?.remove()?;
        NetworkRules::new(self.namespace).remove()?;
        Ok(Removed(self.namespace))
    }
}
