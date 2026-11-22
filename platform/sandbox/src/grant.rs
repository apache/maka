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

//! Additional authority requested from the user, not a replacement sandbox.
//! Host-protected resources and the caller's capability ceiling still apply.

use crate::{Error, Network, Sandbox, filesystem};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    pub filesystem: Vec<filesystem::Rule>,
    pub network: Network,
}

impl Permissions {
    pub fn validate(&self) -> Result<(), Error> {
        if self
            .filesystem
            .iter()
            .any(|rule| rule.access == filesystem::Access::Deny)
        {
            return Err(Error::Invalid(
                "additional permissions cannot contain denials".into(),
            ));
        }
        self.compile()?;
        Ok(())
    }

    /// Partial approval may narrow paths, access and network, never expand them.
    /// Checking both sides' exact/subtree boundaries also catches a broad grant
    /// that would erase a read-only exception inside the requested subtree.
    pub fn contains(&self, granted: &Self) -> Result<bool, Error> {
        self.validate()?;
        granted.validate()?;
        if !self.network.contains(&granted.network) {
            return Ok(false);
        }
        let requested = self.compile()?;
        let granted_policy = granted.compile()?;
        Ok(requested.contains_paths(&granted_policy))
    }

    fn compile(&self) -> Result<filesystem::Compiled, Error> {
        filesystem::Policy {
            default: filesystem::Access::Deny,
            rules: self.filesystem.clone(),
            deny_globs: Vec::new(),
        }
        .compile()
    }
}

impl Sandbox {
    pub fn permits(&self, requested: &Permissions) -> Result<bool, Error> {
        requested.validate()?;
        match self {
            Self::Disabled => Ok(true),
            Self::Managed {
                filesystem,
                network,
            } => Ok(network.contains(&requested.network)
                && filesystem.deny_globs.is_empty()
                && filesystem.compile()?.contains_paths(&requested.compile()?)),
            Self::External { .. } => Ok(false),
        }
    }

    /// Apply an already-approved additive grant under an immutable Host ceiling.
    /// Neither the approval nor this calculation authorizes an effect to start.
    pub fn with_grant(&self, grant: &Permissions, ceiling: &Self) -> Result<Self, Error> {
        grant.validate()?;
        let widened = match self {
            Self::Managed {
                filesystem,
                network,
            } => Self::Managed {
                filesystem: filesystem
                    .compile()?
                    .with_grants(&grant.compile()?)?
                    .policy()
                    .clone(),
                network: network.union(&grant.network),
            },
            Self::Disabled => Self::Disabled,
            Self::External { .. } => {
                return Err(Error::Unsupported(
                    "external isolation requires executor-owned permission grants".into(),
                ));
            }
        };
        widened.intersect(ceiling)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Once,
    Turn,
    Session,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "decision", rename_all = "snake_case", deny_unknown_fields)]
pub enum Decision {
    Deny,
    Allow {
        permissions: Permissions,
        scope: Scope,
    },
}

impl Decision {
    pub fn validate_for(&self, requested: &Permissions) -> Result<(), Error> {
        requested.validate()?;
        if let Self::Allow { permissions, .. } = self
            && !requested.contains(permissions)?
        {
            return Err(Error::Invalid(
                "approved permissions exceed the request".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use filesystem::{Access, Rule};

    #[test]
    fn partial_approval_cannot_widen_nested_or_exact_authority() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let requested = Permissions {
            filesystem: vec![
                Rule::subtree(root, Access::Write),
                Rule::subtree(root.join("restricted"), Access::Read),
            ],
            network: Network::Denied,
        };
        let mut granted = Permissions {
            filesystem: vec![Rule::subtree(root, Access::Read)],
            network: Network::Denied,
        };
        assert!(requested.contains(&granted).unwrap());
        granted.filesystem[0].access = Access::Write;
        assert!(!requested.contains(&granted).unwrap());
        granted.filesystem = vec![Rule::exact(root.join("file"), Access::Write)];
        assert!(requested.contains(&granted).unwrap());
        let exact = granted.clone();
        granted.filesystem[0].scope = filesystem::Scope::Subtree;
        assert!(!exact.contains(&granted).unwrap());
        let sandbox = |grant: &Permissions| Sandbox::Managed {
            filesystem: filesystem::Policy {
                default: Access::Read,
                rules: grant.filesystem.clone(),
                deny_globs: Vec::new(),
            },
            network: grant.network.clone(),
        };
        assert!(!sandbox(&exact).contains(&sandbox(&granted)).unwrap());
        assert!(sandbox(&granted).contains(&sandbox(&exact)).unwrap());
        granted.network = Network::Allowed;
        assert!(!sandbox(&requested).contains(&sandbox(&granted)).unwrap());
        assert!(!requested.contains(&granted).unwrap());
        granted.filesystem[0].path = root.join("../escape");
        assert!(requested.contains(&granted).is_err());
    }
}
