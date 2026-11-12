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

use super::{ApiProvider, Configuration};
use maka_agent_ports::provider::{
    Context, Error, UsageAuthentication, UsageCredential, UsageLimit, UsageLimitsRequest,
};
use url::Url;

use crate::usage::{bearer, get_json};

mod balances;
mod cloud;
mod plans;
mod relay;

enum Source {
    Balance(balances::Source),
    Plan(plans::Source),
    Cloud(cloud::Source),
    Relay(relay::Source),
}

fn source(id: &str) -> Option<Source> {
    relay::source(id)
        .map(Source::Relay)
        .or_else(|| cloud::source(id).map(Source::Cloud))
        .or_else(|| plans::source(id).map(Source::Plan))
        .or_else(|| balances::source(id).map(Source::Balance))
}

pub(super) fn authentication(id: &str) -> Option<UsageAuthentication> {
    Some(match source(id)? {
        Source::Cloud(source) => source.authentication(),
        Source::Balance(_) | Source::Plan(_) | Source::Relay(_) => UsageAuthentication::Provider,
    })
}

pub(super) async fn read(
    provider: &ApiProvider,
    request: UsageLimitsRequest,
    context: Context,
) -> Result<Vec<UsageLimit>, Error> {
    let source = source(provider.id).ok_or(Error::Unavailable)?;
    let configuration = Configuration::read(&request.connection.configuration)?;
    let base = Url::parse(&configuration.base_url).map_err(|_| Error::InvalidEndpoint)?;
    // A named provider can also be configured to use a relay. Never send the
    // relay's key to the named provider's usage endpoint.
    if !matches!(source, Source::Relay(_)) {
        let official = Url::parse(&provider.facts.base_url).map_err(|_| Error::InvalidEndpoint)?;
        if base.origin() != official.origin() {
            return Err(Error::Unavailable);
        }
    }
    match (source, request.credential) {
        (Source::Cloud(source), UsageCredential::AccessKey(key)) => {
            if !source.matches_path(base.path()) {
                return Err(Error::Unavailable);
            }
            source.read(&key, &context).await
        }
        (Source::Plan(source), UsageCredential::Provider { credential, .. }) => {
            source.read(&base, &credential.secret, &context).await
        }
        (Source::Balance(source), UsageCredential::Provider { credential, .. }) => {
            source.read(&base, &credential.secret, &context).await
        }
        (Source::Relay(source), UsageCredential::Provider { credential, .. }) => {
            source.read(&base, &credential.secret, &context).await
        }
        _ => Err(Error::AuthenticationRequired),
    }
}
