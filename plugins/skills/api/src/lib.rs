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

//! Skill library and publication receipt wire contracts.
pub mod contract;
pub use contract::{configuration_schema, contract};
pub const IMPLEMENTATION: &str = "maka.skills.library";
pub const EXPORT: &str = "skills";

pub fn model_input_schema(method: &str) -> Option<serde_json::Value> {
    match method {
        "search" => Some(schemars::schema_for!(contract::ModelSearch).into()),
        "load" => Some(schemars::schema_for!(contract::ModelLoad).into()),
        _ => None,
    }
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        configuration_schema(),
        [(EXPORT, contract())],
    )
}

/// Skill-owned presentation; tool aliases and UI code do not determine meaning.
pub fn model_title(
    method: &str,
    input: &serde_json::Value,
) -> Option<maka_agent_facts::display::Text> {
    use maka_agent_facts::display::Text;
    let (en, zh, tw, detail) = match method {
        "search" => (
            "Search skills",
            "搜索技能",
            "搜尋技能",
            input["query"].as_str(),
        ),
        "load" if input["resource"].is_object() => (
            "Read skill resource",
            "读取技能资源",
            "讀取技能資源",
            input["name"].as_str(),
        ),
        "load" => ("Read skill", "读取技能", "讀取技能", input["name"].as_str()),
        _ => return None,
    };
    let resource = input["resource"]["path"].as_str();
    let detail = match (detail, resource) {
        (Some(name), Some(path)) => format!("{name} / {path}"),
        (name, _) => name.unwrap_or_default().to_owned(),
    };
    let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut detail: String = detail
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    if detail.len() > 180 {
        detail.truncate(detail.floor_char_boundary(180));
        detail.push('…');
    }
    let title = |verb: &str| {
        if detail.is_empty() {
            verb.to_owned()
        } else {
            format!("{verb} · {detail}")
        }
    };
    Some(Text::localized(&title(en), &title(zh), &title(tw)))
}
