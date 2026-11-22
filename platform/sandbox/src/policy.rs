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

use crate::{Error, Network, filesystem};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// User-facing isolation preset, independent of whether approval may be requested.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// Execution isolation and interaction policy are independent. Never prompting
/// does not remove isolation, and a readable path is not an execution grant.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    pub sandbox: Sandbox,
    pub approval: Approval,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Sandbox {
    Managed {
        filesystem: filesystem::Policy,
        network: Network,
    },
    Disabled,
    /// Only an executor with a separately established isolation contract may use
    /// this. SSH, WSL or a plugin identity alone do not establish that contract.
    External {
        network: Network,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Approval {
    OnRequest,
    Never,
    Granular {
        sandbox: bool,
        rules: bool,
        permissions: bool,
        client: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalKind {
    Sandbox,
    Rules,
    Permissions,
    Client,
}

impl Approval {
    pub fn is_subset_of(self, other: Self) -> bool {
        [
            ApprovalKind::Sandbox,
            ApprovalKind::Rules,
            ApprovalKind::Permissions,
            ApprovalKind::Client,
        ]
        .into_iter()
        .all(|kind| !self.allows(kind) || other.allows(kind))
    }
    pub fn allows(self, kind: ApprovalKind) -> bool {
        match self {
            Self::OnRequest => true,
            Self::Never => false,
            Self::Granular {
                sandbox,
                rules,
                permissions,
                client,
            } => match kind {
                ApprovalKind::Sandbox => sandbox,
                ApprovalKind::Rules => rules,
                ApprovalKind::Permissions => permissions,
                ApprovalKind::Client => client,
            },
        }
    }

    pub fn intersect(self, other: Self) -> Self {
        let allowed = |kind| self.allows(kind) && other.allows(kind);
        let sandbox = allowed(ApprovalKind::Sandbox);
        let rules = allowed(ApprovalKind::Rules);
        let permissions = allowed(ApprovalKind::Permissions);
        let client = allowed(ApprovalKind::Client);
        match (sandbox, rules, permissions, client) {
            (true, true, true, true) => Self::OnRequest,
            (false, false, false, false) => Self::Never,
            _ => Self::Granular {
                sandbox,
                rules,
                permissions,
                client,
            },
        }
    }
}

impl Sandbox {
    pub fn network(&self) -> &Network {
        match self {
            Self::Managed { network, .. } | Self::External { network } => network,
            Self::Disabled => &Network::Allowed,
        }
    }

    /// Prove that an existing resource needs no authority beyond this policy.
    /// Differently written deny globs are conservatively treated as different;
    /// no glob-language equivalence solver is needed for safe rebinding.
    pub fn contains(&self, required: &Self) -> Result<bool, Error> {
        match (self, required) {
            (Self::External { .. }, _) | (_, Self::External { .. }) => Ok(false),
            (Self::Disabled, _) => Ok(true),
            (_, Self::Disabled) => Ok(false),
            (
                Self::Managed {
                    filesystem: available,
                    network: a,
                },
                Self::Managed {
                    filesystem: required,
                    network: b,
                },
            ) => Ok(a.contains(b)
                && available
                    .deny_globs
                    .iter()
                    .all(|rule| required.deny_globs.contains(rule))
                && available.compile()?.contains_paths(&required.compile()?)),
        }
    }

    pub fn intersect(&self, requested: &Self) -> Result<Self, Error> {
        match (self, requested) {
            (Self::External { .. }, _) | (_, Self::External { .. }) => Err(Error::Unsupported(
                "external isolation cannot be intersected locally".into(),
            )),
            (Self::Disabled, other) | (other, Self::Disabled) => {
                if let Self::Managed { filesystem, .. } = other {
                    filesystem.compile()?;
                }
                Ok(other.clone())
            }
            (
                Self::Managed {
                    filesystem: left,
                    network: a,
                },
                Self::Managed {
                    filesystem: right,
                    network: b,
                },
            ) => Ok(Self::Managed {
                filesystem: left
                    .compile()?
                    .intersect(&right.compile()?)?
                    .policy()
                    .clone(),
                network: a.intersect(b),
            }),
        }
    }
}
