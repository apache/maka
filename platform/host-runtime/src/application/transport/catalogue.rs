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

//! Read-only facts from actual captured Host registrations.
use super::{Endpoints, wire};
use crate::application::Result;
use maka_plugin_core::{
    composition::InstanceId,
    contract::{Contract, Interface, Transport},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Description {
    pub provider: InstanceId,
    pub export: String,
    pub contract: Contract,
    /// None is a checked declaration without a current executable registration.
    pub registration_epoch: Option<Uuid>,
}
/// This catalogue is received over the embedding's authenticated bootstrap.
/// It grants no admission and never constructs a Host Binding from metadata.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalogue {
    endpoints: BTreeMap<String, Description>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_error: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Selection {
    pub(super) endpoint: String,
    pub(super) description: Description,
}
impl Selection {
    pub fn description(&self) -> &Description {
        &self.description
    }
}
impl Catalogue {
    pub fn captured(endpoints: &Endpoints) -> Self {
        Self {
            endpoints: endpoints.descriptions(),
            startup_error: endpoints.startup_error.clone(),
        }
    }
    /// Diagnostic only; endpoint registration and admission stay independent.
    pub fn startup_error(&self) -> Option<&str> {
        self.startup_error.as_deref()
    }

    pub fn epochs(&self) -> BTreeMap<String, Option<Uuid>> {
        self.endpoints
            .iter()
            .map(|(name, description)| (name.clone(), description.registration_epoch))
            .collect()
    }
    pub fn check_names<'a>(&self, names: impl Iterator<Item = &'a String>) -> Result<()> {
        if !self.endpoints.keys().eq(names) {
            return Err("Host endpoint catalogue differs from configured selections".into());
        }
        Ok(())
    }
    pub fn describe(&self, endpoint: &str) -> Result<&Description> {
        self.endpoints
            .get(endpoint)
            .ok_or("Host endpoint not found".into())
    }
    pub fn select(&self, endpoint: &str) -> Result<Selection> {
        let description = self.describe(endpoint)?.clone();
        if description.registration_epoch.is_none() {
            return Err("Host endpoint is unavailable".into());
        }
        Ok(Selection {
            endpoint: endpoint.into(),
            description,
        })
    }
    /// Preserve buffered bytes from the exact same physical bootstrap stream.
    /// Receiving metadata does not authorize calls or retarget an old selection.
    pub async fn read<R: AsyncRead + Unpin>(reader: R) -> Result<(Self, BufReader<R>)> {
        let mut reader = wire::Reader::new(reader);
        let catalogue: Self = reader.read().await?;
        let catalogue = catalogue.checked().await?;
        Ok((catalogue, reader.inner))
    }
    pub fn validate(&self) -> Result<()> {
        for (name, description) in &self.endpoints {
            if name.is_empty()
                || description
                    .registration_epoch
                    .is_some_and(|epoch| epoch.is_nil())
                || description.provider.validate().is_err()
                || description.export.is_empty()
                || description.contract.transport != Transport::Remote
                || !matches!(description.contract.interface, Interface::Service { .. })
            {
                return Err("invalid Host endpoint description".into());
            }
            description.contract.validate().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Schema compilation must not occupy the async caller's poll stack.
    pub(crate) async fn checked(self) -> Result<Self> {
        tokio::task::spawn_blocking(move || {
            self.validate()?;
            Ok(self)
        })
        .await
        .map_err(|error| format!("Host catalogue validation task: {error}"))?
    }
    /// Only the trusted embedding publishes the actual captured catalogue.
    pub async fn write<W: AsyncWrite + Unpin>(&self, writer: &mut W) -> Result<()> {
        wire::write(writer, self).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugin_core::contract::{Method, MethodMode};
    use serde_json::json;

    #[test]
    fn catalogue_validation_fits_a_constrained_caller_stack() {
        const CHILD: &str = "MAKA_TEST_COLD_CATALOGUE";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "catalogue_validation_fits_a_constrained_caller_stack",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            assert!(
                String::from_utf8_lossy(&output.stdout)
                    .contains("catalogue_validation_fits_a_constrained_caller_stack")
            );
            return;
        }
        // Compile cold schemas in a subprocess so cache warming cannot hide the failure.
        let mut schema = json!({"type":"string", "pattern":"^[a-z]{1,64}$"});
        for _ in 0..24 {
            schema = json!({"type":"object", "properties":{"next":schema}, "additionalProperties":false});
        }
        let catalogue = Catalogue {
            endpoints: BTreeMap::from([(
                "service".into(),
                Description {
                    provider: InstanceId(vec![Uuid::new_v4()]),
                    export: "service".into(),
                    registration_epoch: Some(Uuid::new_v4()),
                    contract: Contract {
                        name: "test.cold-catalogue".into(),
                        version: 1,
                        transport: Transport::Remote,
                        interface: Interface::Service {
                            methods: BTreeMap::from([(
                                "query".into(),
                                Method {
                                    mode: MethodMode::Query,
                                    input: schema.into(),
                                    output: json!({"type":"null"}).into(),
                                    progress: None,
                                    resources: BTreeMap::new(),
                                },
                            )]),
                        },
                    },
                },
            )]),
            startup_error: None,
        };
        std::thread::Builder::new()
            .name("catalogue-caller".into())
            .stack_size(256 * 1024)
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                let mut checked = runtime.block_on(catalogue.checked()).unwrap();
                assert!(checked.describe("service").is_ok());
                let Interface::Service { methods } = &mut checked
                    .endpoints
                    .get_mut("service")
                    .unwrap()
                    .contract
                    .interface
                else {
                    panic!()
                };
                methods.get_mut("query").unwrap().input = json!({"type":"invalid-type"}).into();
                assert!(runtime.block_on(checked.checked()).is_err());
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
