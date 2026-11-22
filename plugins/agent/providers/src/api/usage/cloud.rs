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

use hmac::{Hmac, KeyInit, Mac};
use jiff::Timestamp;
use maka_agent_facts::configuration::UsageAccessKey as AccessKey;
use maka_agent_ports::provider::{Context, Error, UsageAuthentication, UsageLimit};
use serde::Deserialize;
use sha2::{Digest, Sha256};

mod tencent;
mod volcengine;

#[derive(Clone, Copy)]
pub(super) enum Source {
    VolcengineCoding,
    VolcengineAgent,
    TencentGuangzhou,
    TencentSingapore,
}

pub(super) fn source(id: &str) -> Option<Source> {
    match id {
        "volcengine-coding-plan" => Some(Source::VolcengineCoding),
        "volcengine-agent-plan" => Some(Source::VolcengineAgent),
        "tencent-token-plan-enterprise" => Some(Source::TencentGuangzhou),
        "tencent-token-plan-enterprise-intl" => Some(Source::TencentSingapore),
        _ => None,
    }
}

impl Source {
    pub(super) fn authentication(self) -> UsageAuthentication {
        match self {
            Self::VolcengineCoding | Self::VolcengineAgent => UsageAuthentication::AccessKey,
            Self::TencentGuangzhou | Self::TencentSingapore => UsageAuthentication::TeamAccessKey,
        }
    }

    pub(super) fn matches_path(self, path: &str) -> bool {
        let prefix = match self {
            Self::VolcengineCoding => "/api/coding",
            Self::VolcengineAgent => "/api/plan",
            Self::TencentGuangzhou | Self::TencentSingapore => "/plan",
        };
        path == prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }

    pub(super) async fn read(
        self,
        key: &AccessKey,
        context: &Context,
    ) -> Result<Vec<UsageLimit>, Error> {
        let result = match self {
            Self::VolcengineCoding => {
                volcengine::read(key, context, volcengine::Plan::Coding).await
            }
            Self::VolcengineAgent => volcengine::read(key, context, volcengine::Plan::Agent).await,
            Self::TencentGuangzhou => tencent::read(key, context, tencent::Region::Guangzhou).await,
            Self::TencentSingapore => tencent::read(key, context, tencent::Region::Singapore).await,
        };
        match result {
            Err(Error::Http(403)) => Err(Error::AuthenticationRequired),
            result => result,
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hmac(key: &[u8], message: &str) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().into()
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Number {
    // Not `f64`; see `plans::Number`.
    Decimal(serde_json::Number),
    String(String),
}

impl Number {
    fn nonnegative(&self) -> Option<f64> {
        let value = match self {
            Self::Decimal(value) => value.as_f64()?,
            Self::String(value) => value.trim().parse().ok()?,
        };
        (value.is_finite() && value >= 0.0).then_some(value)
    }

    fn unix_seconds(&self) -> Option<u64> {
        let seconds = self.nonnegative()?;
        (seconds > 0.0 && seconds <= 253_402_300_799.0).then_some(seconds as u64)
    }
}

fn timestamp(value: &str) -> Option<u64> {
    value
        .trim()
        .parse::<Timestamp>()
        .ok()
        .and_then(|value| u64::try_from(value.as_second()).ok())
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct VendorError {
    code: String,
}

impl VendorError {
    fn failure(&self) -> Error {
        let code = self.code.to_ascii_lowercase();
        if [
            "accesskey",
            "secretid",
            "signature",
            "accessdenied",
            "unauthorized",
            "forbidden",
            "authfailure",
        ]
        .iter()
        .any(|part| code.contains(part))
        {
            Error::AuthenticationRequired
        } else {
            Error::Rejected("cloud usage query rejected".into())
        }
    }
}
