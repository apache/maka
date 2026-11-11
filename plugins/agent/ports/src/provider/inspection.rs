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

use super::{
    Connection, Context, Definition, Error, UsageAuthentication, authentication::Credential,
};
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::configuration::ModelOverride;
use maka_agent_facts::configuration::UsageAccessKey;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Host-supplied account material; never catalog metadata or canonical history.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub connection: Connection,
    pub credential: Option<Credential>,
    pub request_headers: BTreeMap<String, String>,
}

pub struct UsageLimitsRequest {
    pub connection: Connection,
    pub credential: UsageCredential,
}

pub enum UsageCredential {
    Provider {
        credential: Credential,
        request_headers: BTreeMap<String, String>,
    },
    AccessKey(UsageAccessKey),
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UsageLimit {
    Window {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        period: Option<UsagePeriod>,
        /// Reset time in Unix seconds.
        #[serde(skip_serializing_if = "Option::is_none")]
        resets_at: Option<u64>,
        used_percent: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        quantity: Option<UsageQuantity>,
    },
    Balance {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        amount: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Unlimited {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UsagePeriod {
    Duration { seconds: u32 },
    Monthly,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageQuantity {
    pub used: f64,
    pub limit: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

impl UsageLimit {
    fn validate(&self) -> Result<(), Error> {
        let valid_text = |value: Option<&str>| {
            value.is_none_or(|v| !v.trim().is_empty() && !v.chars().any(char::is_control))
        };
        let nonnegative = |v: f64| v.is_finite() && v >= 0.0;
        let valid = match self {
            Self::Window {
                label,
                period,
                resets_at,
                used_percent,
                quantity,
            } => {
                valid_text(label.as_deref())
                    && !matches!(period, Some(UsagePeriod::Duration { seconds: 0 }))
                    && resets_at.is_none_or(|time| time <= 8_640_000_000_000)
                    && nonnegative(*used_percent)
                    && quantity.as_ref().is_none_or(|value| {
                        nonnegative(value.used)
                            && nonnegative(value.limit)
                            && value.limit > 0.0
                            && valid_text(value.unit.as_deref())
                    })
            }
            Self::Balance {
                label,
                amount,
                unit,
            } => valid_text(label.as_deref()) && amount.is_finite() && valid_text(unit.as_deref()),
            Self::Unlimited { label } => valid_text(label.as_deref()),
        };
        if !valid {
            return Err(Error::Invalid("invalid provider usage limit".into()));
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verification {
    pub connection: Connection,
    pub credential: Option<Credential>,
    pub request_headers: BTreeMap<String, String>,
    pub model: ModelInfo,
    pub overrides: Option<ModelOverride>,
    pub request_body_overlay: Option<serde_json::Value>,
}

impl Definition {
    fn validate_inspection(
        &self,
        connection: &Connection,
        credential: Option<&Credential>,
        headers: &BTreeMap<String, String>,
    ) -> Result<(), Error> {
        self.validate_configuration(&connection.configuration)?;
        if let Some(credential) = credential {
            credential.validate().map_err(Error::Invalid)?;
        }
        crate::model::Credentials::RequestHeaders(headers.clone())
            .validate()
            .map_err(Error::Invalid)
    }

    pub async fn discover(
        &self,
        request: Discovery,
        context: Context,
    ) -> Result<Vec<ModelInfo>, Error> {
        if !self.policy.descriptor.discovery {
            return Err(Error::Unavailable);
        }
        self.validate_inspection(
            &request.connection,
            request.credential.as_ref(),
            &request.request_headers,
        )?;
        let models = self.implementation.discover(request, context).await?;
        let mut seen = std::collections::HashSet::new();
        for model in &models {
            model.validate().map_err(Error::Invalid)?;
            if !seen.insert(&model.id) {
                return Err(Error::Invalid("duplicate model identity".into()));
            }
        }
        Ok(models)
    }

    pub async fn verify(&self, request: Verification, context: Context) -> Result<(), Error> {
        self.validate_inspection(
            &request.connection,
            request.credential.as_ref(),
            &request.request_headers,
        )?;
        request.model.validate().map_err(Error::Invalid)?;
        if let Some(overlay) = &request.request_body_overlay {
            maka_agent_facts::configuration::validation::overlay(overlay)
                .map_err(Error::Invalid)?;
        }
        self.implementation.verify(request, context).await
    }

    pub async fn usage_limits(
        &self,
        request: UsageLimitsRequest,
        context: Context,
    ) -> Result<Vec<UsageLimit>, Error> {
        match (self.descriptor().usage_authentication, &request.credential) {
            (None, _) => return Err(Error::Unavailable),
            (
                Some(UsageAuthentication::Provider),
                UsageCredential::Provider {
                    credential,
                    request_headers,
                },
            ) => {
                self.validate_inspection(&request.connection, Some(credential), request_headers)?;
            }
            (Some(authentication), UsageCredential::AccessKey(key))
                if matches!(
                    (authentication, key.team_id.is_some()),
                    (UsageAuthentication::AccessKey, false)
                        | (UsageAuthentication::TeamAccessKey, true)
                ) =>
            {
                self.validate_configuration(&request.connection.configuration)?;
            }
            _ => return Err(Error::AuthenticationRequired),
        }
        let limits = self.implementation.usage_limits(request, context).await?;
        for limit in &limits {
            limit.validate()?;
        }
        Ok(limits)
    }
}
