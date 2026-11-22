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

use crate::facts::AuthKind;
use maka_agent_ports::model::Credentials;
use maka_agent_ports::provider::Error;
use maka_agent_ports::provider::authentication::Authenticate;
use maka_agent_ports::provider::authentication::Credential;
use maka_agent_ports::provider::authentication::Method;
use serde::Deserialize;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    #[schemars(length(min = 1))]
    api_key: String,
}

pub(super) fn methods(kind: AuthKind) -> Result<Vec<Method>, Error> {
    if kind == AuthKind::None {
        return Ok(vec![]);
    }
    Ok(vec![Method {
        id: "api-key".into(),
        label: "API key".into(),
        input_schema: serde_json::to_value(schemars::schema_for!(Key))
            .map_err(|_| Error::Invalid("invalid API key form".into()))?,
        interactive: false,
    }])
}

pub(super) fn authenticate(request: Authenticate) -> Result<Credential, Error> {
    if request.method != "api-key" {
        return Err(Error::Invalid("unknown authentication method".into()));
    }
    let key: Key = serde_json::from_value(request.input)
        .map_err(|_| Error::Invalid("invalid API key".into()))?;
    let value = key.api_key.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(Error::Invalid("invalid API key".into()));
    }
    Ok(Credential {
        secret: value.into(),
        refresh_at: None,
    })
}

pub(super) fn authorize(
    kind: AuthKind,
    credential: Option<Credential>,
) -> Result<Credentials, Error> {
    match credential {
        Some(value) => {
            value.validate().map_err(Error::Invalid)?;
            Ok(Credentials::ApiKey(value.secret))
        }
        None if matches!(kind, AuthKind::None | AuthKind::OptionalApiKey) => {
            Ok(Credentials::RequestHeaders(Default::default()))
        }
        None => Err(Error::AuthenticationRequired),
    }
}
