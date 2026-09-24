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

use maka_client::Client;
use maka_protocol::{configuration::ConnectionCatalogQueryInput as Query, session::*};
use serde_json::Value;
use std::collections::HashSet;

pub(super) struct Model {
    pub id: String,
    pub name: String,
    pub target: SessionModelTarget,
    pub thinking: Vec<ThinkingLevel>,
}

pub(super) fn identity(connection: &str, model: &str) -> String {
    serde_json::to_string(&(connection, model)).expect("model identity")
}

#[derive(Default)]
struct Header {
    index: u64,
    id: String,
    slug: String,
    name: String,
    enabled: bool,
    models: HashSet<String>,
}

pub(super) async fn read(client: &Client) -> Result<Vec<Model>, crate::Error> {
    let mut query = Query::Start;
    let mut header = Header::default();
    let mut models = Vec::new();
    // Bound work and the ACP response; oversized catalogs fail without partial choices.
    for _ in 0..512 {
        let page = client.connection_catalog(query).await?;
        if page["kind"] == "revision_changed" {
            return Err("Model catalog changed; retry the configuration request".into());
        }
        append(&page, &mut header, &mut models)?;
        if models.len() > 2048 {
            return Err("Model catalog exceeds ACP's 2048 selectable model limit".into());
        }
        if page["nextCursor"].is_null() {
            return Ok(models);
        }
        query = Query::Continue {
            revision: page["revision"]
                .as_u64()
                .ok_or("Missing catalog revision")?,
            cursor: serde_json::from_value(page["nextCursor"].clone())?,
        };
    }
    Err("Model catalog exceeds ACP's 512 page scan limit".into())
}

fn append(page: &Value, header: &mut Header, models: &mut Vec<Model>) -> Result<(), crate::Error> {
    for item in page["items"].as_array().ok_or("Missing catalog items")? {
        let index = item["connectionIndex"]
            .as_u64()
            .ok_or("Missing connection index")?;
        match item["kind"].as_str() {
            Some("connection") => {
                *header = Header {
                    index,
                    id: string(item, "connectionId")?.into(),
                    slug: string(item, "slug")?.into(),
                    name: string(item, "name")?.into(),
                    enabled: item["enabled"] == true,
                    models: HashSet::new(),
                };
            }
            Some("enabled_model_id") if index == header.index => {
                header.models.insert(string(item, "modelId")?.into());
            }
            Some("catalog_entry") if index == header.index => {
                let entry = &item["entry"];
                let model = string(entry, "id")?;
                if header.enabled
                    && header.models.contains(model)
                    && entry["canUseAsChatDefault"] == true
                {
                    let name = entry["displayName"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(model);
                    models.push(Model {
                        id: identity(&header.id, model),
                        name: format!("{name} ({})", header.name),
                        target: SessionModelTarget::Explicit {
                            connection_id: header.id.clone(),
                            connection_slug: header.slug.clone(),
                            model: model.into(),
                        },
                        thinking: serde_json::from_value(entry["thinkingLevels"].clone())?,
                    });
                }
            }
            Some("enabled_model_id" | "catalog_entry") => {
                return Err("Catalog connection context changed".into());
            }
            _ => {}
        }
    }
    Ok(())
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, crate::Error> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing catalog {key}").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_choices_preserve_connection_across_pages_and_require_enabled_chat_models() {
        let mut header = Header::default();
        let mut models = Vec::new();
        append(&json!({"items":[{"kind":"connection","connectionIndex":0,"connectionId":"c","slug":"c","name":"C","enabled":true},
            {"kind":"enabled_model_id","connectionIndex":0,"modelId":"m"}]}), &mut header, &mut models).unwrap();
        append(&json!({"items":[{"kind":"catalog_entry","connectionIndex":0,"entry":{"id":"disabled","canUseAsChatDefault":true}},
            {"kind":"catalog_entry","connectionIndex":0,"entry":{"id":"m","canUseAsChatDefault":false}},
            {"kind":"catalog_entry","connectionIndex":0,"entry":{"id":"m","canUseAsChatDefault":true,"thinkingLevels":["low","high"]}}]}), &mut header, &mut models).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, identity("c", "m"));
        assert_eq!(
            models[0].thinking,
            [ThinkingLevel::Low, ThinkingLevel::High]
        );
        assert_ne!(identity("a/b", "c"), identity("a", "b/c"));
    }
}
