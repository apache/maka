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

use super::{Result, error};
use crate::{body::NativeBody, budget};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) const CACHE_LIMIT: u32 = 32 * 1024 * 1024;

/// Connection metadata only. Full replay always comes from the immutable
/// canonical prompt held by NativeBody, never from a second wire history.
pub(super) struct Baseline {
    properties: Value,
    pub response_id: Option<String>,
    _permit: OwnedSemaphorePermit,
}
pub(super) struct Prepared {
    pub full: NativeBody,
    pub delta: Option<NativeBody>,
}
impl Prepared {
    pub fn new(body: NativeBody, baseline: Option<Baseline>) -> Result<Self> {
        let previous = body
            .properties
            .get("previous_response_id")
            .filter(|id| !id.is_null());
        let delta = if let Some(previous) = previous {
            let Some(baseline) =
                baseline.filter(|baseline| previous.as_str() == baseline.response_id.as_deref())
            else {
                return Err(error("Responses continuation has no confirmed baseline"));
            };
            let matching = properties(&body.properties).count()
                == properties(&baseline.properties).count()
                && properties(&body.properties)
                    .all(|(key, value)| baseline.properties.get(key) == Some(value));
            matching.then(|| body.clone())
        } else {
            None
        };
        Ok(Self {
            full: body.full(),
            delta,
        })
    }
    pub fn cache(self, budget: &Arc<Semaphore>) -> Option<Baseline> {
        let properties = self.full.properties;
        let bytes = budget::bytes(&properties, CACHE_LIMIT).ok()?;
        Some(Baseline {
            properties,
            response_id: None,
            _permit: budget.clone().try_acquire_many_owned(bytes).ok()?,
        })
    }
}
impl Baseline {
    pub fn complete(mut self, response: &Value) -> Option<Self> {
        self.response_id = Some(
            response["id"]
                .as_str()
                .filter(|id| !id.is_empty())?
                .to_owned(),
        );
        Some(self)
    }
}
fn properties(body: &Value) -> impl Iterator<Item = (&String, &Value)> {
    body.as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter(|(key, _)| key.as_str() != "previous_response_id")
}
