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

use super::{executions, store};
use maka_event_log::root::FileLease;
use maka_sandbox::{
    filesystem::{Access, Rule, Scope},
    windows::{
        Account, WriteCapability,
        acl::{self, Permission, Target},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// The restricting token layer does not authorize execution by itself.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteRule {
    pub path: PathBuf,
    pub scope: Scope,
    pub access: WriteAccess,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteAccess {
    Allowed,
    Preserve,
    Denied,
}
impl WriteAccess {
    fn permission(self) -> Permission {
        match self {
            Self::Allowed => Permission::Write,
            Self::Preserve => Permission::WritePreserve,
            Self::Denied => Permission::DenyWrite,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteGrant {
    rule: WriteRule,
    target: Target,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    rule: Rule,
    target: Target,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    account: String,
    grants: Vec<Grant>,
    capability: Uuid,
    writes: Vec<WriteGrant>,
    network: maka_sandbox::Network,
}

/// Owns a complete cached ACL surface. Every execution still has its own Job.
/// Capture once before choosing a slot; aliases and duplicate native objects
/// must not make the published surface differ from the one being compared.
pub(super) struct Plan {
    grants: Vec<Grant>,
    files: Vec<File>,
    writes: Vec<WriteGrant>,
    write_files: Vec<File>,
    network: maka_sandbox::Network,
}
impl Plan {
    fn same_surface(&self, intent: &Intent) -> bool {
        intent.grants == self.grants
            && intent.writes == self.writes
            && intent.network == self.network
    }

    // Temporary protected leaves can be recreated between commands. Refresh
    // those objects without walking unchanged writable trees. A changed grant
    // of write access, even at the same path, always retires the capability.
    fn can_refresh(&self, intent: &Intent) -> bool {
        intent.network == self.network
            && intent.writes.len() == self.writes.len()
            && intent.writes.iter().zip(&self.writes).all(|(old, new)| {
                old.rule == new.rule
                    && (old.target == new.target || new.rule.access == WriteAccess::Denied)
            })
            && intent.grants.len() == self.grants.len()
            && intent.grants.iter().zip(&self.grants).all(|(old, new)| {
                old.rule == new.rule
                    && (old.target == new.target
                        || self.writes.iter().any(|write| {
                            write.rule.path == new.rule.path
                                && write.rule.access == WriteAccess::Denied
                        }))
            })
    }

    pub(super) fn capture(
        rules: &[Rule],
        writes: &[WriteRule],
        network: &maka_sandbox::Network,
    ) -> io::Result<Self> {
        let mut rules = rules.to_vec();
        rules.sort_by(|a, b| {
            a.path
                .components()
                .count()
                .cmp(&b.path.components().count())
                .then(a.path.cmp(&b.path))
                .then(a.scope.cmp(&b.scope))
                .then(a.access.cmp(&b.access))
        });
        rules.dedup();
        let mut grants: Vec<Grant> = Vec::with_capacity(rules.len());
        let mut identities = std::collections::HashSet::with_capacity(rules.len());
        let mut files = Vec::with_capacity(rules.len());
        for rule in rules {
            let (target, file) = Target::capture(&rule.path)
                .map_err(|error| context("capture", &rule.path, error))?;
            if !identities.insert(target.clone()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "overlapping account boundaries",
                ));
            }
            grants.push(Grant { rule, target });
            files.push(file);
        }
        let mut write_rules = writes.to_vec();
        write_rules.sort_by(|a, b| {
            a.path
                .components()
                .count()
                .cmp(&b.path.components().count())
                .then(a.cmp(b))
        });
        write_rules.dedup();
        let mut writes = Vec::with_capacity(write_rules.len());
        let mut write_files = Vec::with_capacity(write_rules.len());
        identities.clear();
        for rule in write_rules {
            let (target, file) = Target::capture(&rule.path)
                .map_err(|error| context("capture write", &rule.path, error))?;
            if !identities.insert(target.clone()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "overlapping write boundaries",
                ));
            }
            writes.push(WriteGrant { rule, target });
            write_files.push(file);
        }
        Ok(Self {
            grants,
            files,
            writes,
            write_files,
            network: network.clone(),
        })
    }

    pub(super) fn matches(&self, root: &Path, account: &Account) -> io::Result<bool> {
        let name = format!("account-{}", account.name());
        let Some(intent) = store::read::<Intent>(&root.join(format!("{name}.json")))? else {
            return Ok(false);
        };
        if intent.account != account.sid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "account surface identity changed",
            ));
        }
        Ok(self.can_refresh(&intent)
            && store::read::<bool>(&root.join(format!("{name}.ready")))? == Some(true))
    }

    /// Caller holds the installation admission lock until it owns both this
    /// shared surface lease and its persisted execution identity. No ACL changes
    /// are possible while another execution retains that permission surface.
    pub(super) fn acquire(
        &self,
        root: &Path,
        account: &Account,
    ) -> io::Result<Option<(File, Uuid)>> {
        let name = format!("account-{}", account.name());
        let lock = root.join(format!("{name}.lock"));
        store::lease_file(&lock)?;
        let exclusive = match FileLease::acquire(&lock) {
            Ok(lease) => Some(lease),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => None,
            Err(error) => return Err(error),
        };
        let intent_path = root.join(format!("{name}.json"));
        if exclusive.is_none() {
            let intent: Intent = store::required(&intent_path)?;
            if intent.account != account.sid() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "account surface identity changed",
                ));
            }
            return if self.same_surface(&intent)
                && store::read::<bool>(&root.join(format!("{name}.ready")))? == Some(true)
            {
                store::shared_lease(&lock).map(|lease| Some((lease, intent.capability)))
            } else {
                Ok(None)
            };
        }
        // A crashed Host can release the file lease before its native tree has
        // settled. Job facts, not lease absence alone, permit account reuse.
        match executions::settle_account(root, account.sid()) {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
            result => result?,
        }
        if let Some(intent) = store::read::<Intent>(&intent_path)?
            && intent.account == account.sid()
            && self.can_refresh(&intent)
            && store::read::<bool>(&root.join(format!("{name}.ready")))? == Some(true)
        {
            if !self.same_surface(&intent) {
                self.refresh(root, &name, &intent)?;
            }
            drop(exclusive);
            return store::shared_lease(&lock).map(|lease| Some((lease, intent.capability)));
        }
        restore(root, &name)?;
        let intent = Intent {
            account: account.sid().into(),
            grants: self.grants.clone(),
            capability: Uuid::new_v4(),
            writes: self.writes.clone(),
            network: self.network.clone(),
        };
        store::publish(root, &format!("{name}.json"), &intent)?;
        let result = (|| {
            let capability = WriteCapability::new(intent.capability);
            for (grant, file) in self.writes.iter().zip(&self.write_files) {
                acl::set(
                    file,
                    capability.sid(),
                    grant.rule.scope,
                    Some(grant.rule.access.permission()),
                )
                .map_err(|error| context("apply write", &grant.rule.path, error))?;
            }
            for (grant, file) in self.grants.iter().zip(&self.files) {
                acl::set(
                    file,
                    account.sid(),
                    grant.rule.scope,
                    Some(permission(grant.rule.access)),
                )
                .map_err(|error| context("apply", &grant.rule.path, error))?;
            }
            store::publish(root, &format!("{name}.ready"), &true)
        })();
        if let Err(error) = result {
            return match restore(root, &name) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(io::Error::other(format!(
                    "{error}; account ACL cleanup pending: {cleanup}"
                ))),
            };
        }
        drop(exclusive);
        store::shared_lease(&lock).map(|lease| Some((lease, intent.capability)))
    }

    /// Exclusive slot ownership and drained native Jobs are required. Record
    /// both generations before touching either, so interrupted refresh can
    /// revoke every owned ACE using object identities, not reused path names.
    fn refresh(&self, root: &Path, name: &str, previous: &Intent) -> io::Result<()> {
        store::remove(&root.join(format!("{name}.ready")))?;
        let mut pending = previous.clone();
        pending.grants.extend(
            self.grants
                .iter()
                .zip(&previous.grants)
                .filter(|(new, old)| new != old)
                .map(|(new, _)| new.clone()),
        );
        pending.writes.extend(
            self.writes
                .iter()
                .zip(&previous.writes)
                .filter(|(new, old)| new != old)
                .map(|(new, _)| new.clone()),
        );
        store::publish(root, &format!("{name}.refresh"), &pending)?;
        let capability = WriteCapability::new(previous.capability);
        for ((old, new), file) in previous
            .writes
            .iter()
            .zip(&self.writes)
            .zip(&self.write_files)
        {
            if old != new {
                if let Some(old_file) = old.target.reopen()? {
                    acl::set(&old_file, capability.sid(), old.rule.scope, None)?;
                }
                acl::set(
                    file,
                    capability.sid(),
                    new.rule.scope,
                    Some(new.rule.access.permission()),
                )?;
            }
        }
        for ((old, new), file) in previous.grants.iter().zip(&self.grants).zip(&self.files) {
            if old != new {
                if let Some(old_file) = old.target.reopen()? {
                    acl::set(&old_file, &previous.account, old.rule.scope, None)?;
                }
                acl::set(
                    file,
                    &previous.account,
                    new.rule.scope,
                    Some(permission(new.rule.access)),
                )?;
            }
        }
        let current = Intent {
            grants: self.grants.clone(),
            writes: self.writes.clone(),
            ..previous.clone()
        };
        store::remove(&root.join(format!("{name}.json")))?;
        store::publish(root, &format!("{name}.json"), &current)?;
        store::remove(&root.join(format!("{name}.refresh")))?;
        store::publish(root, &format!("{name}.ready"), &true)
    }
}

fn permission(access: Access) -> Permission {
    match access {
        Access::Read => Permission::Read,
        Access::Write => Permission::Write,
        Access::Deny => Permission::Deny,
    }
}

fn restore(root: &Path, name: &str) -> io::Result<()> {
    let intent = match store::read::<Intent>(&root.join(format!("{name}.refresh")))? {
        Some(pending) => Some(pending),
        None => store::read::<Intent>(&root.join(format!("{name}.json")))?,
    };
    if let Some(intent) = intent {
        store::remove(&root.join(format!("{name}.ready")))?;
        let capability = WriteCapability::new(intent.capability);
        for grant in intent.writes.iter().rev() {
            if let Some(file) = grant
                .target
                .reopen()
                .map_err(|error| context("reopen write", &grant.rule.path, error))?
            {
                acl::set(&file, capability.sid(), grant.rule.scope, None)
                    .map_err(|error| context("revoke write", &grant.rule.path, error))?;
            }
        }
        for grant in intent.grants.iter().rev() {
            if let Some(file) = grant
                .target
                .reopen()
                .map_err(|error| context("reopen", &grant.rule.path, error))?
            {
                acl::set(&file, &intent.account, grant.rule.scope, None)
                    .map_err(|error| context("revoke", &grant.rule.path, error))?;
            }
        }
        store::remove(&root.join(format!("{name}.json")))?;
        store::remove(&root.join(format!("{name}.refresh")))?;
    }
    Ok(())
}

fn context(action: &str, path: &Path, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!("cannot {action} account ACL at {}: {error}", path.display()),
    )
}

/// Exclusive installation ownership and drained execution Jobs are required.
pub(super) fn recover(root: &Path) -> io::Result<()> {
    let mut names = std::collections::BTreeSet::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let filename = entry.file_name();
        let Some(name) = filename
            .to_str()
            .and_then(|name| {
                name.strip_suffix(".json")
                    .or_else(|| name.strip_suffix(".refresh"))
            })
            .filter(|name| name.starts_with("account-maka-s-"))
        else {
            continue;
        };
        names.insert(name.to_owned());
    }
    for name in names {
        restore(root, &name)?;
    }
    Ok(())
}
