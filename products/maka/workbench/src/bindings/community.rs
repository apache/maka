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

use nsh_core::prelude::*;
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone, JsObject)]
pub struct Repository {
    pub name: String,
    pub description: String,
    pub installable: bool,
    pub category: String,
    pub title: String,
}

#[derive(Clone, JsObject)]
pub struct Page {
    pub repositories: Vec<Repository>,
    pub more: bool,
}

#[derive(Deserialize)]
struct Response {
    items: Vec<Item>,
    total_count: usize,
}
#[derive(Deserialize)]
struct Item {
    full_name: String,
    description: Option<String>,
    topics: Vec<String>,
}

pub async fn search(text: String, page: u32, locale: String) -> Result<Page, String> {
    const SIZE: u32 = 25;
    if !(1..=1000 / SIZE).contains(&page) {
        return Err("Invalid GitHub search page".into());
    }
    // Keep the topic and archive filters under the application's control.
    let keywords: String = text
        .chars()
        .take(120)
        .map(|c| {
            if c.is_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                ' '
            }
        })
        .collect();
    let query = format!("topic:maka-plugin archived:false fork:true {keywords}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Maka-community-discovery")
        .build()
        .map_err(|e| e.to_string())?;
    let mut url =
        url::Url::parse("https://api.github.com/search/repositories").expect("GitHub API URL");
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("page", &page.to_string())
        .append_pair("per_page", &SIZE.to_string())
        .append_pair("sort", "stars")
        .append_pair("order", "desc");
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if matches!(response.status().as_u16(), 403 | 429) {
        return Err("GitHub rate limit reached. Try again later.".into());
    }
    let body = response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let result: Response = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let more =
        result.items.len() == SIZE as usize && (page * SIZE) < result.total_count.min(1000) as u32;
    let mut tasks = tokio::task::JoinSet::new();
    for (index, item) in result.items.into_iter().enumerate() {
        if !item.topics.iter().any(|t| t == "maka-plugin") {
            continue;
        }
        let client = client.clone();
        let locale = locale.clone();
        tasks.spawn(async move {
            let manifest = manifest(&client, &item.full_name).await;
            let field = |key: &str| {
                manifest["localizations"][&locale][key]
                    .as_str()
                    .or_else(|| manifest[key].as_str())
                    .filter(|text| !text.trim().is_empty())
            };
            (
                index,
                Repository {
                    category: category(&manifest).into(),
                    title: field("displayName").unwrap_or_default().into(),
                    installable: item.topics.iter().any(|t| t == "maka-ui-plugin"),
                    name: item.full_name,
                    description: field("description")
                        .map(str::to_owned)
                        .or(item.description)
                        .unwrap_or_default(),
                },
            )
        });
    }
    let mut rows = Vec::new();
    while let Some(row) = tasks.join_next().await {
        rows.push(row.map_err(|e| e.to_string())?);
    }
    rows.sort_by_key(|(index, _)| *index);
    Ok(Page {
        more,
        repositories: rows.into_iter().map(|(_, repo)| repo).collect(),
    })
}

fn category(manifest: &serde_json::Value) -> &'static str {
    let Some(app) = manifest["application"].as_object() else {
        return "unknown";
    };
    if app
        .get("ui")
        .and_then(|ui| ui.pointer("/contributions"))
        .and_then(|value| value.as_object())
        .is_some_and(|items| {
            items.values().any(|item| {
                item["kind"] == "view" && item["contract"] == "maka.quick-launcher.tool"
            })
        })
    {
        return "quick";
    }
    if ["ui", "host", "composition"]
        .iter()
        .any(|key| app.contains_key(*key))
    {
        return "other";
    }
    "unknown"
}

async fn manifest(client: &reqwest::Client, repo: &str) -> serde_json::Value {
    let url = format!("https://raw.githubusercontent.com/{repo}/HEAD/maka.extension.json");
    let Ok(mut response) = client.get(url).send().await else {
        return serde_json::Value::Null;
    };
    let mut bytes = Vec::new();
    if response.status().is_success() {
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= 1024 * 1024 => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return serde_json::Value::Null,
            }
        }
    }
    serde_json::from_slice(&bytes).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::category;
    use serde_json::json;

    #[test]
    fn marketplace_categories_follow_declared_contributions() {
        let mixed = json!({"application":{"ui":{"contributions":{
            "preferences":{"kind":"settings"},
            "capture":{"kind":"view","contract":"maka.quick-launcher.tool"}
        }}}});
        assert_eq!(category(&mixed), "quick");
        assert_eq!(category(&json!({"application":{"host":{}}})), "other");
        assert_eq!(
            category(&json!({"application":{"ui":{"contributions":{
                "tool":{"kind":"view","contract":"example.other"}
            }}}})),
            "other"
        );
        assert_eq!(category(&serde_json::Value::Null), "unknown");
    }
}
