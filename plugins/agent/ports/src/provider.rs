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

//! Compiled provider policy for authentication, discovery and model adapters.
//! Credentials and connections belong to Host, not to the contribution catalog.
pub mod authentication;
mod refresh;
pub use refresh::RefreshCall;
mod inspection;
pub use inspection::{Discovery, Verification};
pub mod configuration;

use crate::model::Credentials;
use crate::model::Transport;
use authentication::{Authenticate, Credential, Interaction};
pub use configuration::{Connection, Descriptor, Model, Resolve};
use futures_util::future::BoxFuture;
use maka_agent_facts::configuration::ModelInfo;
pub use maka_agent_facts::provider::Identity;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Context {
    pub transport: Arc<dyn Transport>,
    pub cancellation: CancellationToken,
    /// Present only for a Host-admitted interactive login.
    pub interaction: Option<Arc<dyn Interaction>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum Error {
    #[error("provider registration is unavailable")]
    Unavailable,
    #[error("provider operation was cancelled")]
    Cancelled,
    #[error("provider requires authentication")]
    AuthenticationRequired,
    /// Caller-facing explanation supplied by the provider. Must not include
    /// credentials or unfiltered remote response bodies.
    #[error("provider rejected the request: {0}")]
    Rejected(String),
    #[error("invalid provider input or output: {0}")]
    Invalid(String),
    #[error("invalid provider configuration")]
    InvalidConfiguration,
    #[error("invalid selected model")]
    InvalidModel,
    #[error("invalid prepared model")]
    InvalidPreparedModel,
    #[error("provider changed the selected model identity")]
    SelectedModelChanged,
    #[error("unsupported model thinking level")]
    UnsupportedThinkingLevel,
    #[error("provider execution profile or semantic features are not supported")]
    UnsupportedExecutionProfile,
    #[error("provider adapter or protocol is not supported")]
    UnsupportedProtocol,
    #[error("invalid provider endpoint")]
    InvalidEndpoint,
    #[error("Responses contract is not declared")]
    MissingResponsesContract,
    #[error("provider protocol does not expose parallel-call policy")]
    UnsupportedParallelPolicy,
    #[error("model output limit does not leave a positive text budget")]
    InsufficientOutputBudget,
    #[error("provider facts are unavailable")]
    ProviderFactsUnavailable,
    #[error("provider probe authentication is not supported")]
    UnsupportedProbeAuthentication,
    #[error("provider request outcome is unknown")]
    OutcomeUnknown,
    #[error("provider transport failed: {0}")]
    Transport(String),
    /// Status only; provider error bodies can contain credentials.
    #[error("provider HTTP request failed with status {0}")]
    Http(u16),
}

/// Pure request policy is separate from credential resolution. Host can freeze
/// policy without disclosing tokens; authorization follows execution admission.
pub trait Provider: Send + Sync {
    fn resolve(&self, request: Resolve) -> BoxFuture<'_, Result<Model, Error>>;

    fn authorize(
        &self,
        connection: Connection,
        credential: Option<Credential>,
        session_id: String,
    ) -> BoxFuture<'_, Result<Credentials, Error>>;

    fn authenticate(
        &self,
        _request: Authenticate,
        _context: Context,
    ) -> BoxFuture<'_, Result<Credential, Error>> {
        Box::pin(async { Err(Error::AuthenticationRequired) })
    }

    fn refresh(
        &self,
        _connection: Connection,
        _credential: Credential,
        _context: Context,
    ) -> BoxFuture<'_, Result<Credential, Error>> {
        Box::pin(async { Err(Error::AuthenticationRequired) })
    }

    fn discover(
        &self,
        _request: Discovery,
        _context: Context,
    ) -> BoxFuture<'_, Result<Vec<ModelInfo>, Error>> {
        Box::pin(async { Err(Error::Unavailable) })
    }

    /// The provider chooses its meaningful readiness check. Host does not
    /// infer subscription behavior from a vendor name or fabricate a probe.
    fn verify(
        &self,
        _request: Verification,
        _context: Context,
    ) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async { Err(Error::Unavailable) })
    }
}

/// Validated, immutable descriptor and compiled input schemas shared by definitions.
pub struct Policy {
    descriptor: Descriptor,
    configuration: jsonschema::Validator,
    authentication: std::collections::BTreeMap<String, jsonschema::Validator>,
}

impl std::fmt::Debug for Policy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Policy")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

impl Policy {
    /// Validate the descriptor and compile all input schemas before sharing policy.
    ///
    /// # Errors
    /// Returns an error for an invalid descriptor or schema.
    pub fn new(descriptor: Descriptor) -> Result<Self, Error> {
        descriptor.validate()?;
        let compile = |schema: &serde_json::Value| {
            jsonschema::options()
                .offline()
                .should_validate_formats(false)
                .build(schema)
                .map_err(|_| Error::Invalid("invalid provider schema".into()))
        };
        let configuration = compile(&descriptor.configuration_schema)?;
        let authentication = descriptor
            .authentication
            .iter()
            .map(|method| Ok((method.id.clone(), compile(&method.input_schema)?)))
            .collect::<Result<_, Error>>()?;
        Ok(Self {
            descriptor,
            configuration,
            authentication,
        })
    }
}

pub struct Definition {
    policy: Arc<Policy>,
    implementation: Arc<dyn Provider>,
}

impl Definition {
    pub fn new(policy: Arc<Policy>, implementation: Arc<dyn Provider>) -> Self {
        Self {
            policy,
            implementation,
        }
    }

    pub fn descriptor(&self) -> &Descriptor {
        &self.policy.descriptor
    }

    /// Defaults are materialized once, when creating the connection. Reading a
    /// stored connection never substitutes a newer plugin's endpoint or defaults.
    pub fn configure(&self, input: serde_json::Value) -> Result<serde_json::Value, Error> {
        let serde_json::Value::Object(input) = input else {
            return Err(Error::InvalidConfiguration);
        };
        let mut configuration = self
            .policy
            .descriptor
            .configuration_defaults
            .as_object()
            .expect("validated descriptor")
            .clone();
        configuration.extend(input);
        let configuration = serde_json::Value::Object(configuration);
        self.validate_configuration(&configuration)?;
        Ok(configuration)
    }

    /// Validated policy for a trusted embedding. The embedding must retain and
    /// drain its actual implementation owner; this value is not an admission grant.
    pub async fn prepare(&self, request: Resolve) -> Result<Model, Error> {
        self.validate_configuration(&request.connection.configuration)?;
        request.model.validate().map_err(|_| Error::InvalidModel)?;
        let expected = request.model.id.clone();
        let model = self.implementation.resolve(request).await?;
        model.validate().map_err(|_| Error::InvalidPreparedModel)?;
        if model.info.id != expected {
            return Err(Error::SelectedModelChanged);
        }
        Ok(model)
    }

    /// Private credential resolution after the embedding's execution admission.
    pub async fn authorize(
        &self,
        connection: Connection,
        credential: Option<Credential>,
        session_id: String,
    ) -> Result<Credentials, Error> {
        self.validate_configuration(&connection.configuration)?;
        if let Some(credential) = &credential {
            credential.validate().map_err(Error::Invalid)?;
        }
        let credentials = self
            .implementation
            .authorize(connection, credential, session_id)
            .await?;
        credentials.validate().map_err(Error::Invalid)?;
        Ok(credentials)
    }

    /// Prepare refresh for a trusted native owner, which retains the actual
    /// implementation and drains settlement independently of request waiters.
    pub fn prepare_refresh(
        &self,
        connection: Connection,
        credential: Credential,
    ) -> Result<RefreshCall, Error> {
        self.validate_configuration(&connection.configuration)?;
        credential.validate().map_err(Error::Invalid)?;
        Ok(RefreshCall {
            implementation: self.implementation.clone(),
            connection,
            credential,
        })
    }

    /// Authentication after the trusted embedding's actual execution admission.
    /// The embedding owns cancellation and physical settlement, as for authorize.
    pub async fn authenticate(
        &self,
        request: Authenticate,
        context: Context,
    ) -> Result<Credential, Error> {
        self.validate_authentication(&request, &context)?;
        let credential = self.implementation.authenticate(request, context).await?;
        credential.validate().map_err(Error::Invalid)?;
        Ok(credential)
    }

    fn validate_authentication(
        &self,
        request: &Authenticate,
        context: &Context,
    ) -> Result<(), Error> {
        self.validate_configuration(&request.connection.configuration)?;
        let validator = self
            .policy
            .authentication
            .get(&request.method)
            .ok_or_else(|| Error::Invalid("unknown authentication method".into()))?;
        // Validation errors must never echo submitted credentials.
        if serde_json::to_vec(&request.input)
            .map_err(|_| Error::Invalid("invalid authentication input".into()))?
            .len()
            > 64 * 1024
            || !validator.is_valid(&request.input)
        {
            return Err(Error::Invalid(
                "authentication input does not satisfy its schema".into(),
            ));
        }
        let method = self
            .policy
            .descriptor
            .authentication
            .iter()
            .find(|method| method.id == request.method)
            .expect("compiled authentication schema");
        if method.interactive && context.interaction.is_none() {
            return Err(Error::Unavailable);
        }
        Ok(())
    }

    pub fn validate_configuration(&self, configuration: &serde_json::Value) -> Result<(), Error> {
        if serde_json::to_vec(configuration)
            .map_err(|_| Error::InvalidConfiguration)?
            .len()
            > 64 * 1024
            || !self.policy.configuration.is_valid(configuration)
        {
            return Err(Error::InvalidConfiguration);
        }
        Ok(())
    }
}
