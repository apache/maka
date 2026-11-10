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

use super::*;
use crate::search;
use maka_web_api::{search::Query, settings};

pub(super) async fn run(
    owner: Arc<Web>,
    input: Value,
    context: Context,
    failure: network::Failure,
) -> Result<Value, String> {
    let input: Key = serde_json::from_value(input).map_err(message)?;
    let credential = owner
        .repository
        .credentials
        .read(settings::KEY.into())
        .await
        .map_err(message)?;
    if credential.as_ref().map(|value| value.revision) != input.revision {
        return encode(Update::Changed);
    }
    let Some(credential) = credential else {
        return encode(Update::CheckUnavailable);
    };
    let Some(secret) = credential.secret else {
        return encode(Update::CheckUnavailable);
    };
    let authority = network::CredentialCheck {
        owner: owner.clone(),
        caller: context.scope().clone(),
        revision: credential.revision,
        failure: failure.clone(),
    };
    let http = Arc::new(maka_host_runtime::http::Http::new(Arc::new(authority)));
    let result = search::Search::new(http)
        .query(
            context.scope(),
            &secret,
            &Query {
                query: "Maka AI assistant".into(),
                limit: 1,
            },
        )
        .await;
    let outcome = match result {
        Ok(_) => settings::CheckOutcome::Valid,
        Err(search::Error::InvalidCredentials) => settings::CheckOutcome::InvalidCredentials,
        Err(search::Error::RateLimited) => settings::CheckOutcome::RateLimited,
        Err(search::Error::Network | search::Error::Status(_) | search::Error::Response) => {
            settings::CheckOutcome::NetworkError
        }
        Err(search::Error::Settlement(error)) => {
            failure.observe(&error);
            owner.stopping.cancel();
            return Err(message(error));
        }
        Err(
            search::Error::Input
            | search::Error::NotConfigured
            | search::Error::Denied
            | search::Error::Cancelled,
        ) => return encode(Update::CheckUnavailable),
    };
    if owner
        .repository
        .snapshot()
        .await
        .map_err(message)?
        .credential
        .revision
        != input.revision
    {
        return encode(Update::Changed);
    }
    owner
        .repository
        .record_check(settings::Check {
            credential_revision: credential.revision,
            outcome,
        })
        .await
        .map_err(message)?;
    encode(Update::Updated {
        snapshot: owner.repository.snapshot().await.map_err(message)?,
    })
}
