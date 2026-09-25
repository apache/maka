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
use crate::plugin::remote::failure;
use maka_plugins::authorization::{Id, Request as Authorization};

pub(super) async fn authority(
    skills: &Skills,
    operation: uuid::Uuid,
    cx: &Cx,
) -> Result<Authorization, Error> {
    crate::plugin::remote::authorize_user(skills, &cx.caller, operation, Copy::Authorize.text(cx))
        .await
}
pub(super) enum Consent {
    Granted(Id),
    Needed(Authorization),
}
pub(super) async fn consent(
    skills: &Skills,
    grant: Option<Id>,
    operation: uuid::Uuid,
    cx: &Cx,
) -> Result<Consent, Error> {
    let request = authority(skills, operation, cx).await?;
    let id = match grant {
        Some(id) => Some(id),
        None => skills.user_status().await.map_err(failure)?.grant,
    };
    if let Some(id) = id {
        match skills.user.authorizations.open(id).await {
            Ok(authorized) => {
                let matches = authorized.grant.request.target == request.target
                    && request
                        .capabilities
                        .is_subset(&authorized.grant.request.capabilities);
                authorized
                    .call
                    .finish()
                    .await
                    .map_err(|_| Error::CleanupUnconfirmed)?;
                if !matches {
                    return Err(invalid(
                        "Skill authorization does not cover the user library",
                    ));
                }
                return Ok(Consent::Granted(id));
            }
            Err(
                maka_plugins::execution::CommandError::Denied
                | maka_plugins::execution::CommandError::Revoked,
            ) if grant.is_none() => {}
            Err(error) => return Err(Error::Provider(error.to_string())),
        }
    }
    Ok(Consent::Needed(request))
}
