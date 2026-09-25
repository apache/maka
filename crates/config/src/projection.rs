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
use crate::{ConfigError, Result};
use maka_runtime::configuration::*;
use serde_json::{Value, json};

/// Produces a 128-item / 128 KiB wire page; the cursor identifies
/// the next item, and only belongs to the revision that produced it.
pub fn project(
    snapshot: &ConnectionCatalogSnapshot,
    input: &ConnectionCatalogQueryInput,
    resolve: impl Fn(&ConnectionCatalogEntry, Option<&str>) -> Result<Vec<ModelCatalogEntry>>,
) -> Result<Value> {
    if let ConnectionCatalogQueryInput::Continue { revision, .. } = input {
        validation::revision(*revision, false).map_err(ConfigError::Invalid)?;
        if *revision != snapshot.revision {
            return Ok(
                json!({"kind":"revision_changed", "expectedRevision":revision,
                "actualRevision":snapshot.revision}),
            );
        }
    }
    let mut items = Vec::new();
    for (connection_index, row) in snapshot.connections.iter().enumerate() {
        let default = snapshot
            .default_target
            .as_ref()
            .filter(|target| target.connection_id == row.connection_id)
            .map(|target| target.model_id.as_str());
        let entries = resolve(row, default)?;
        for entry in &entries {
            entry.validate().map_err(ConfigError::Invalid)?;
        }
        let mut header = json!({"kind":"connection", "connectionIndex":connection_index,
            "connectionId":row.connection_id,"revision":row.revision,"slug":row.slug,
            "name":row.name,"provider":row.provider,"configuration":row.configuration,"enabled":row.enabled,
            "enabledModelIdCount":row.enabled_model_ids.len(),"modelCount":row.models.len(),
            "catalogEntryCount":entries.len()});
        for (key, value) in [
            ("modelSource", serde_json::to_value(row.model_source)?),
            ("lastTest", serde_json::to_value(&row.last_test)?),
            (
                "requestBodyOverlay",
                serde_json::to_value(&row.request_body_overlay)?,
            ),
        ] {
            if !value.is_null() {
                header[key] = value;
            }
        }
        items.push(header);
        for (item_index, id) in row.enabled_model_ids.iter().enumerate() {
            let item = json!({"kind":"enabled_model_id", "connectionIndex":connection_index,
                "itemIndex":item_index,"modelId":id});
            items.push(item);
        }
        for (item_index, model) in row.models.iter().enumerate() {
            let mut model = model.clone();
            if let Some(name) = &mut model.display_name {
                *name = crate::model_catalog::wire_limit(name, 512);
            }
            model.validate().map_err(ConfigError::Invalid)?;
            items.push(json!({"kind":"model","connectionIndex":connection_index,
                "itemIndex":item_index,"model":model}));
        }
        for (item_index, entry) in entries.into_iter().enumerate() {
            let profile = row.model_overrides.as_ref().and_then(|p| p.get(&entry.id));
            let mut item = json!({"kind":"catalog_entry","connectionIndex":connection_index,
                "itemIndex":item_index,"entry":entry});
            if let Some(profile) = profile {
                item["modelOverride"] = serde_json::to_value(profile)?;
            }
            items.push(item);
        }
    }
    let offset = match input {
        ConnectionCatalogQueryInput::Start => 0,
        ConnectionCatalogQueryInput::Continue { cursor, .. } => {
            let cursor = serde_json::to_value(cursor)?;
            items
                .iter()
                .position(|item| cursor_for(item) == cursor)
                .ok_or_else(|| ConfigError::Invalid("catalog cursor has no matching item".into()))?
        }
    };
    let page = |end: usize| {
        json!({"kind":"page","revision":snapshot.revision,
        "defaultTarget":snapshot.default_target,"connectionCount":snapshot.connections.len(),
        "items":&items[offset..end],"nextCursor":items.get(end).map(cursor_for)})
    };
    // Count each item once. Re-encoding every growing prefix blocks the Host's
    // connection task on large provider inventories, delaying unrelated control RPCs.
    let mut envelope = page(offset);
    envelope["nextCursor"] = Value::Null;
    let envelope_bytes = serde_json::to_vec(&envelope)?.len() - 4; // replace JSON null
    let mut item_bytes = 0;
    let mut end = offset;
    while end < items.len().min(offset + 128) {
        let next_item_bytes = serde_json::to_vec(&items[end])?.len() + usize::from(end > offset);
        let cursor_bytes = serde_json::to_vec(&items.get(end + 1).map(cursor_for))?.len();
        if envelope_bytes + item_bytes + next_item_bytes + cursor_bytes > 128 * 1024 {
            break;
        }
        item_bytes += next_item_bytes;
        end += 1;
    }
    if end == offset && end < items.len() {
        return Err(ConfigError::Invalid(
            "catalog item exceeds page byte limit".into(),
        ));
    }
    Ok(page(end))
}

fn cursor_for(item: &Value) -> Value {
    let mut cursor = json!({"part":item["kind"],"connectionIndex":item["connectionIndex"]});
    if let Some(index) = item.get("itemIndex") {
        cursor["itemIndex"] = index.clone();
    }
    cursor
}
