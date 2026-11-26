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

//! Preferences and localized instructions for optional composer predictions.
use crate::language::Language;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "MessagePredictionSettings")]
pub struct MessagePredictionSettings {
    pub enabled: bool,
    pub ordinary_sessions_only: bool,
    #[schemars(range(min = 0, max = 100))]
    pub live_sample_percent: f64,
    #[schemars(range(min = 0, max = 100))]
    pub catch_up_sample_percent: f64,
    /// None or blank selects the localized built-in instructions.
    pub prompt: Option<String>,
}
impl Default for MessagePredictionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ordinary_sessions_only: false,
            live_sample_percent: 100.0,
            catch_up_sample_percent: 50.0,
            prompt: None,
        }
    }
}
impl MessagePredictionSettings {
    pub fn validate(&self) -> Result<(), String> {
        if ![self.live_sample_percent, self.catch_up_sample_percent]
            .into_iter()
            .all(|percent| (0.0..=100.0).contains(&percent))
        {
            return Err("prediction sampling must be between 0 and 100 percent".into());
        }
        Ok(())
    }
}

pub fn default_prediction_prompt(language: Language) -> &'static str {
    crate::i18n::prediction::default_prompt(language)
}
