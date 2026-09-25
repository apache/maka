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

use maka_plugins::{
    authorization::{Grant, Id, Request, Target},
    composition::Scope,
    remote::ClientIdentity,
};
use serde::{Deserialize, Serialize};

/// Sent by the application's consent UI, not the plugin Host bridge.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum AuthorizationInput {
    Client {
        client: ClientIdentity,
        scope: Scope,
        command: AuthorizationCommand,
    },
    Remote {
        binding: super::RemoteBinding,
        target: maka_plugins::remote::Target,
        command: AuthorizationCommand,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorizationCommand {
    Approve { request: Request },
    Query { id: Id },
    Revoke { id: Id },
}
impl AuthorizationInput {
    pub fn command(&self) -> &AuthorizationCommand {
        match self {
            Self::Client { command, .. } | Self::Remote { command, .. } => command,
        }
    }
    pub fn validate(&self) -> crate::Result<()> {
        let session = match self {
            Self::Client { client, scope, .. } => {
                super::remote::validate_client(client)?;
                match scope {
                    Scope::DesktopUi => {
                        return Err(crate::ProtocolError::invalid(
                            "authorization requires a Host scope",
                        ));
                    }
                    Scope::Session(id) => Some(id.as_str()),
                    Scope::Profile => None,
                }
            }
            Self::Remote {
                binding, target, ..
            } => {
                if !matches!(binding, super::RemoteBinding::Package { .. }) {
                    return Err(crate::ProtocolError::invalid(
                        "Remote consent requires an application binding",
                    ));
                }
                super::remote::validate_binding(binding)?;
                super::remote::validate_target(target)?;
                // Remote discovery may select a Profile owner from a Session
                // page. Only the Host knows the bound endpoint's actual scope.
                if let Some(context) = binding.session_id()
                    && let AuthorizationCommand::Approve { request } = self.command()
                    && let Target::Session { session_id } = &request.target
                    && session_id != context
                {
                    return Err(crate::ProtocolError::invalid(
                        "authorization target differs from its Session context",
                    ));
                }
                None
            }
        };
        if let AuthorizationCommand::Approve { request } = self.command() {
            request
                .validate()
                .map_err(|error| crate::ProtocolError::invalid(error.to_string()))?;
            if let Some(id) = session
                && !matches!(&request.target, Target::Session { session_id } if session_id == id)
            {
                return Err(crate::ProtocolError::invalid(
                    "Session-scoped authorization cannot escape its Session",
                ));
            }
        }
        Ok(())
    }
    pub fn uses_host_paths(&self) -> bool {
        matches!(
            self.command(),
            AuthorizationCommand::Approve {
                request: Request {
                    target: Target::Directory { .. }
                        | Target::Workspace {
                            workspace: maka_runtime::execution::WorkspaceTarget::HostPath { .. },
                            ..
                        },
                    ..
                }
            }
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorizationResult {
    Grant { grant: Option<Grant> },
    Revoked,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remote_consent_separates_discovery_context_from_backend_scope() {
        let mut value = json!({
            "binding":{"packageId":"example.plugin","method":"terminal","sessionId":null},
            "target":{"entryId":"example.plugin","activation":uuid::Uuid::new_v4(),"registration":uuid::Uuid::new_v4()},
            "command":{"kind":"approve","request":{"operationId":uuid::Uuid::new_v4(),"title":"Read files",
                "target":{"kind":"directory","path":"/work"},"capabilities":["read_files"]}}
        });
        let input: AuthorizationInput = serde_json::from_value(value.clone()).unwrap();
        input.validate().unwrap();
        assert!(input.uses_host_paths());
        value["scope"] = json!("profile");
        assert!(serde_json::from_value::<AuthorizationInput>(value.clone()).is_err());
        value.as_object_mut().unwrap().remove("scope");
        value["binding"]["sessionId"] = json!("one");
        serde_json::from_value::<AuthorizationInput>(value.clone())
            .unwrap()
            .validate()
            .unwrap();
        value["command"]["request"]["target"] = json!({"kind":"session","sessionId":"two"});
        assert!(
            serde_json::from_value::<AuthorizationInput>(value.clone())
                .unwrap()
                .validate()
                .is_err()
        );
        value["command"]["request"]["target"] = json!({"kind":"session","sessionId":"one"});
        serde_json::from_value::<AuthorizationInput>(value)
            .unwrap()
            .validate()
            .unwrap();
    }
}
