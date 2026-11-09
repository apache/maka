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

use super::{auth, provider};
use crate::{
    Agent,
    ports::Ports,
    transport::{Connection, Peer},
};
use agent_client_protocol::{v1::schema as acp, v2::schema as v2};
use futures_util::future::BoxFuture;
use maka_agent_ports::remote::Error;
use maka_capabilities::call::Scope;
use maka_capabilities::process;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "ExecutorSetupAction")]
pub enum Action {
    Check,
    Authenticate {
        #[schemars(length(min = 1))]
        method_id: String,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ExecutorAuthenticationMethod")]
pub struct Method {
    #[schemars(length(min = 1))]
    pub id: String,
    #[schemars(length(min = 1))]
    pub name: String,

    pub description: Option<String>,
    pub supported: bool,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "ExecutorSetupInfo")]
pub struct Info {
    pub title: Option<String>,

    pub name: String,

    pub version: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "ExecutorSetupResult")]
pub enum Outcome {
    Checked {
        info: Option<Info>,

        methods: Vec<Method>,
    },
    Authenticated,
    /// No authentication confirmation was observed; never automatically replay it.
    Unresolved {
        diagnostic: String,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ExecutorSetupProgress")]
pub enum Progress {
    AuthorizationUrl { url: String },
}
pub trait Output: Send + Sync {
    fn emit(&self, progress: Progress) -> BoxFuture<'_, Result<(), Error>>;
}
fn checked_text(value: &str) -> Result<String, Error> {
    if value.chars().any(char::is_control) {
        return Err(Error::Invalid("Invalid ACP setup metadata".into()));
    }
    Ok(value.to_owned())
}
fn info(name: &str, version: &str, title: Option<&str>) -> Result<Info, Error> {
    Ok(Info {
        title: title.map(checked_text).transpose()?,
        name: checked_text(name)?,
        version: checked_text(version)?,
    })
}
fn method(
    id: &str,
    name: &str,
    description: Option<&str>,
    supported: bool,
) -> Result<Method, Error> {
    if id.is_empty() || name.is_empty() {
        return Err(Error::Invalid("Invalid ACP authentication method".into()));
    }
    Ok(Method {
        id: checked_text(id)?,
        name: checked_text(name)?,
        description: description.map(str::to_owned),
        supported,
    })
}
fn unresolved(error: impl std::fmt::Display) -> Outcome {
    let message = error.to_string();
    Outcome::Unresolved {
        diagnostic: message,
    }
}

/// One setup attempt through the caller's actual admitted process capability.
/// Cleanup completes before a business result escapes, including cancellation.
pub async fn execute(
    agent: &Agent,
    host: Ports,
    scope: Scope,
    action: Action,
    output: &dyn Output,
) -> Result<Outcome, Error> {
    if scope.cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if let Action::Authenticate { method_id } = &action {
        if method_id.is_empty() {
            return Err(Error::Invalid("Invalid authentication method".into()));
        }
        checked_text(method_id)?;
    }
    let authenticate = matches!(action, Action::Authenticate { .. });
    let mut command = agent.command();
    command.lifetime = process::Lifetime::Invocation;
    // Do not drop accepted spawn while it may be acquiring physical custody.
    let handle = host
        .processes
        .spawn(scope.clone(), command.clone())
        .await
        .map_err(provider)?;
    let mut connection = Connection::new(host, scope.clone(), command, handle, false);
    let result = tokio::select! { biased;
        () = scope.cancellation.cancelled() => if authenticate {
            Ok(unresolved("Authentication cancelled without confirmation"))
        } else { Err(Error::Cancelled) },
        result = run(&mut connection, action, output) => result,
    };
    tokio::time::timeout(Duration::from_secs(4), connection.owner.close())
        .await
        .map_err(|error| {
            Error::OutcomeUnknown(format!("ACP setup original close timed out: {error}"))
        })?
        .map_err(|error| {
            Error::OutcomeUnknown(format!("ACP setup original close failed: {error}"))
        })?;
    result
}
async fn run(
    connection: &mut Connection,
    action: Action,
    output: &dyn Output,
) -> Result<Outcome, Error> {
    let mut stderr = auth::Urls::default();
    auth::initialize(connection, output, &mut stderr).await?;
    let (info, methods, is_v2) = match connection.peer.as_ref().unwrap() {
        Peer::V1(_, initialized) => (
            initialized
                .agent_info
                .as_ref()
                .map(|v| info(&v.name, &v.version, v.title.as_deref()))
                .transpose()?,
            initialized
                .auth_methods
                .iter()
                .map(|m| {
                    method(
                        m.id().0.as_ref(),
                        m.name(),
                        m.description(),
                        matches!(m, acp::AuthMethod::Agent(_)),
                    )
                })
                .collect::<Result<Vec<_>, _>>()?,
            false,
        ),
        Peer::V2(_, initialized) => (
            Some(info(
                &initialized.info.name,
                &initialized.info.version,
                initialized.info.title.as_deref(),
            )?),
            initialized
                .auth_methods
                .iter()
                .map(|m| {
                    method(
                        m.method_id().0.as_ref(),
                        m.name(),
                        m.description(),
                        matches!(m, v2::AuthMethod::Agent(_)),
                    )
                })
                .collect::<Result<Vec<_>, _>>()?,
            true,
        ),
    };
    let checked = Outcome::Checked { info, methods };
    match action {
        Action::Check => Ok(checked),
        Action::Authenticate { method_id } => {
            let Outcome::Checked { methods, .. } = checked else {
                unreachable!()
            };
            if !methods.iter().any(|m| m.id == method_id && m.supported) {
                return Err(Error::Invalid(
                    "Authentication method is not offered or requires an unsupported terminal"
                        .into(),
                ));
            }
            let result = if is_v2 {
                auth::rpc(
                    connection,
                    v2::LoginAuthRequest::new(method_id),
                    output,
                    &mut stderr,
                )
                .await
                .map(|_| ())
            } else {
                auth::rpc(
                    connection,
                    acp::AuthenticateRequest::new(method_id),
                    output,
                    &mut stderr,
                )
                .await
                .map(|_| ())
            };
            Ok(match result {
                Ok(()) => Outcome::Authenticated,
                Err(error) => unresolved(error),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_metadata_and_unresolved_diagnostics_preserve_complete_values() {
        let name = "external-agent-".repeat(6_000);
        let description =
            "Authentication instructions with a complete final marker. ".repeat(2_000);
        let method = method(&name, &name, Some(&description), true).unwrap();
        assert_eq!(method.id, name);
        assert_eq!(method.name, name);
        assert_eq!(method.description.as_deref(), Some(description.as_str()));
        let info = info(&name, "2026.10", Some(&description)).unwrap();
        assert_eq!(info.name, name);
        assert_eq!(info.title.as_deref(), Some(description.as_str()));
        let Outcome::Unresolved { diagnostic } = unresolved(&description) else {
            panic!("expected unresolved authentication");
        };
        assert_eq!(diagnostic, description);
        assert!(super::method("invalid\nmethod", "name", None, true).is_err());
    }
}
