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

use super::{ComputerAppDecision, Decision, InteractionAnswer};
use maka_sandbox::grant;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalAllow {
    Allow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAppApproval {
    Once,
    Session,
    Always,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "decision", rename_all = "snake_case", deny_unknown_fields)]
pub enum PermissionApproval {
    Allow {
        permissions: grant::Permissions,
        scope: grant::Scope,
    },
}

/// Only access-expanding child decisions can require a parent's human confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionApprovalAnswer {
    ServiceApproval { decision: ApprovalAllow },
    Permissions { decision: PermissionApproval },
    ClientCapability { decision: ApprovalAllow },
    ComputerApp { decision: ComputerAppApproval },
}

impl SessionApprovalAnswer {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Self::Permissions {
            decision: PermissionApproval::Allow { permissions, .. },
        } = self
        {
            permissions
                .validate()
                .map_err(|_| "Invalid approved permissions")?;
        }
        Ok(())
    }

    pub fn denied(self) -> InteractionAnswer {
        match self {
            Self::ServiceApproval { .. } => InteractionAnswer::ServiceApproval {
                decision: Decision::Deny,
            },
            Self::Permissions { .. } => InteractionAnswer::Permissions {
                decision: grant::Decision::Deny,
            },
            Self::ClientCapability { .. } => InteractionAnswer::ClientCapability {
                decision: Decision::Deny,
            },
            Self::ComputerApp { .. } => InteractionAnswer::ComputerApp {
                decision: ComputerAppDecision::Deny,
            },
        }
    }
}

impl TryFrom<&InteractionAnswer> for SessionApprovalAnswer {
    type Error = &'static str;

    fn try_from(answer: &InteractionAnswer) -> Result<Self, Self::Error> {
        Ok(match answer {
            InteractionAnswer::ServiceApproval {
                decision: Decision::Allow,
            } => Self::ServiceApproval {
                decision: ApprovalAllow::Allow,
            },
            InteractionAnswer::Permissions {
                decision: grant::Decision::Allow { permissions, scope },
            } => Self::Permissions {
                decision: PermissionApproval::Allow {
                    permissions: permissions.clone(),
                    scope: *scope,
                },
            },
            InteractionAnswer::ClientCapability {
                decision: Decision::Allow,
            } => Self::ClientCapability {
                decision: ApprovalAllow::Allow,
            },
            InteractionAnswer::ComputerApp { decision } => Self::ComputerApp {
                decision: match decision {
                    ComputerAppDecision::Once => ComputerAppApproval::Once,
                    ComputerAppDecision::Session => ComputerAppApproval::Session,
                    ComputerAppDecision::Always => ComputerAppApproval::Always,
                    ComputerAppDecision::Deny => {
                        return Err("Not an access-expanding child decision");
                    }
                },
            },
            _ => return Err("Not an access-expanding child decision"),
        })
    }
}

impl From<SessionApprovalAnswer> for InteractionAnswer {
    fn from(answer: SessionApprovalAnswer) -> Self {
        match answer {
            SessionApprovalAnswer::ServiceApproval { .. } => Self::ServiceApproval {
                decision: Decision::Allow,
            },
            SessionApprovalAnswer::Permissions {
                decision: PermissionApproval::Allow { permissions, scope },
            } => Self::Permissions {
                decision: grant::Decision::Allow { permissions, scope },
            },
            SessionApprovalAnswer::ClientCapability { .. } => Self::ClientCapability {
                decision: Decision::Allow,
            },
            SessionApprovalAnswer::ComputerApp { decision } => Self::ComputerApp {
                decision: match decision {
                    ComputerAppApproval::Once => ComputerAppDecision::Once,
                    ComputerAppApproval::Session => ComputerAppDecision::Session,
                    ComputerAppApproval::Always => ComputerAppDecision::Always,
                },
            },
        }
    }
}
