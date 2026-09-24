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

impl Driver<'_> {
    pub(super) async fn configure(
        &mut self,
        live: &mut Live,
        defaults: &[acp::SessionConfigOption],
    ) -> Result<(), Error> {
        let thinking = self
            .request
            .settings
            .thinking_level
            .map(serde_json::to_value)
            .transpose()?;
        for (category, value) in [
            (
                acp::SessionConfigOptionCategory::Model,
                self.request.settings.model.as_deref(),
            ),
            (
                acp::SessionConfigOptionCategory::ThoughtLevel,
                thinking.as_ref().and_then(|value| value.as_str()),
            ),
        ] {
            let default = defaults
                .iter()
                .find(|option| option.category.as_ref() == Some(&category))
                .and_then(|option| match &option.kind {
                    acp::SessionConfigKind::Select(select) => {
                        Some(select.current_value.to_string())
                    }
                    _ => None,
                });
            let Some(value) = value.or(default.as_deref()) else {
                continue;
            };
            let option = live
                .options
                .iter()
                .find(|option| option.category.as_ref() == Some(&category))
                .ok_or(Error::Invalid(
                    "agent does not expose the requested setting",
                ))?;
            let acp::SessionConfigKind::Select(select) = &option.kind else {
                return Err(Error::Invalid("agent setting is not a selector"));
            };
            let valid = match &select.options {
                acp::SessionConfigSelectOptions::Ungrouped(options) => options
                    .iter()
                    .any(|option| option.value.to_string() == value),
                acp::SessionConfigSelectOptions::Grouped(groups) => groups.iter().any(|group| {
                    group
                        .options
                        .iter()
                        .any(|option| option.value.to_string() == value)
                }),
                _ => false,
            };
            if !valid {
                return Err(Error::Invalid(
                    "agent does not offer the requested setting value",
                ));
            }
            if select.current_value.to_string() == value {
                continue;
            }
            let input = acp::SetSessionConfigOptionRequest::new(
                live.session_id.clone(),
                option.id.clone(),
                acp::SessionConfigOptionValue::value_id(value.to_owned()),
            );
            let response: acp::SetSessionConfigOptionResponse = self
                .rpc(&mut live.connection, input, Duration::from_secs(30))
                .await?;
            live.options = response.config_options;
        }
        Ok(())
    }
}
