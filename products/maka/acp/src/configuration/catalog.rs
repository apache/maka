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

use crate::{Error, client::Client};
use maka_settings_native::contract::{DefaultModel, ModelChoice, ModelsPage};
use serde_json::json;

pub(super) struct Catalog {
    pub choices: Vec<ModelChoice>,
    pub default: DefaultModel,
}
pub(super) fn identity(choice: &ModelChoice) -> String {
    serde_json::to_string(&(&choice.selection.connection_id, &choice.selection.model_id))
        .expect("model identity")
}
pub(super) async fn read(client: &Client) -> Result<Catalog, Error> {
    let mut input = json!({"kind":"start"});
    let mut choices = Vec::new();
    let mut seen = std::collections::HashSet::new();
    loop {
        let ModelsPage::Ready {
            revision,
            choices: page,
            default_model,
            next,
        } = client.query("settings", "models", input).await?
        else {
            return Err("Model catalog changed; retry the configuration request".into());
        };
        choices.extend(page);
        let Some(cursor) = next else {
            return Ok(Catalog {
                choices,
                default: *default_model,
            });
        };
        if !seen.insert(serde_json::to_string(&cursor)?) {
            return Err("Model catalog cursor repeated".into());
        }
        input = json!({"kind":"continue", "revision":revision, "cursor":cursor});
    }
}
