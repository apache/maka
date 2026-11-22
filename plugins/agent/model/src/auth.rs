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

use crate::ModelError;
use serde::Serialize;
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

/// Root-owned credential resolution happens after model admission, outside the
/// global control gate. Dropping a waiter must not abandon a spent refresh grant.
pub trait AuthResolver: Send + Sync {
    fn resolve(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderAuth, ModelError>> + Send + '_>>;
}

/// Authentication representations, independent of provider identity.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProviderAuth {
    ApiKey(String),
    RequestHeaders(BTreeMap<String, String>),
    Bound {
        /// Stable private route identity, not access/refresh token material.
        identity: String,
        #[serde(skip)]
        resolver: Arc<dyn AuthResolver>,
    },
}

pub(crate) async fn resolve(auth: &mut ProviderAuth) -> Result<(), ModelError> {
    if let ProviderAuth::Bound { resolver, .. } = auth {
        let resolved = resolver.resolve().await?;
        if matches!(resolved, ProviderAuth::Bound { .. }) {
            return Err(ModelError::Adapter(
                "credential resolver returned another binding".into(),
            ));
        }
        *auth = resolved;
    }
    Ok(())
}
