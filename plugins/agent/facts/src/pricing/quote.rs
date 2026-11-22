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

//! A request's public provider identity and contemporaneous rate decision.
//! Missing pricing is captured too: a later catalog edit cannot price old work.
use super::Pricing;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quote {
    pub provider_id: String,
    pub revision: u64,
    pub pricing: Option<Pricing>,
}

impl Quote {
    pub fn validate(&self, model: &str) -> Result<(), &'static str> {
        if self.provider_id.is_empty()
            || self.provider_id.chars().any(char::is_control)
            || self.revision > 9_007_199_254_740_991
        {
            return Err("invalid model quote identity");
        }
        if let Some(pricing) = &self.pricing {
            pricing.validate()?;
            if pricing.model_key != format!("{}:{model}", self.provider_id) {
                return Err("model quote does not match the requested model");
            }
        }
        Ok(())
    }

    pub fn estimate(&self, usage: &crate::model::ModelUsage) -> Result<Option<f64>, &'static str> {
        self.pricing
            .as_ref()
            .map(|price| price.estimate(usage))
            .transpose()
            .map(Option::flatten)
    }
}
