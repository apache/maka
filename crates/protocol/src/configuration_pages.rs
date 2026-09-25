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
//! Catalog output boundary using the shared public configuration types.
use crate::codec::{count, exact, record, shaped, string};
use crate::{ProtocolError, Result};
use maka_runtime::configuration::{
    ConnectionCatalogEntry, ConnectionTarget, ModelCatalogEntry, ModelOverride, validation as v,
};
use serde_json::{Value, json};

// Stored inventory + independent overrides + enabled IDs + fallback + default.
pub const MAX_CATALOG_ENTRIES: u64 = 4627;
fn invalid() -> ProtocolError {
    ProtocolError::invalid("Invalid connection catalog page")
}
fn domain(result: std::result::Result<(), String>) -> Result<()> {
    result.map_err(ProtocolError::invalid)
}
fn bounded(value: &Value, max: u64) -> Result<u64> {
    let n = count(value, "catalog count")?;
    if n > max {
        return Err(invalid());
    }
    Ok(n)
}
fn position(value: &Value, cursor: bool) -> Result<(u64, u8, u64)> {
    let kind = value[if cursor { "part" } else { "kind" }]
        .as_str()
        .unwrap_or("");
    let (rank, max) = match kind {
        "connection" => (0, 1),
        "enabled_model_id" => (1, 512),
        "model" => (2, 2048),
        "catalog_entry" => (3, MAX_CATALOG_ENTRIES),
        _ => return Err(invalid()),
    };
    if cursor {
        let keys: &[&str] = if rank == 0 {
            &["part", "connectionIndex"]
        } else {
            &["part", "connectionIndex", "itemIndex"]
        };
        exact(record(value, "catalog cursor")?, keys)?;
    }
    Ok((
        bounded(&value["connectionIndex"], 1023)?,
        rank,
        if rank == 0 {
            0
        } else {
            bounded(&value["itemIndex"], max - 1)?
        },
    ))
}

pub fn decode_catalog_query_result(value: &Value) -> Result<Value> {
    let object = record(value, "catalog result")?;
    if value["kind"] == "revision_changed" {
        exact(object, &["kind", "expectedRevision", "actualRevision"])?;
        return Ok(json!({"kind":"revision_changed",
            "expectedRevision":count(&value["expectedRevision"], "revision")?,
            "actualRevision":count(&value["actualRevision"], "revision")?}));
    }
    exact(
        object,
        &[
            "kind",
            "revision",
            "defaultTarget",
            "connectionCount",
            "items",
            "nextCursor",
        ],
    )?;
    if value["kind"] != "page" {
        return Err(invalid());
    }
    let mut page = value.clone();
    page["revision"] = json!(count(&value["revision"], "revision")?);
    let connections = bounded(&value["connectionCount"], 1024)?;
    page["connectionCount"] = json!(connections);
    if !value["defaultTarget"].is_null() {
        let target: ConnectionTarget =
            serde_json::from_value(value["defaultTarget"].clone()).map_err(|_| invalid())?;
        domain(v::target(&target))?;
    }
    let items = value["items"]
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or_else(invalid)?;
    if items.is_empty()
        && (connections != 0 || !value["defaultTarget"].is_null() || !value["nextCursor"].is_null())
    {
        return Err(invalid());
    }
    let mut previous = None;
    let mut decoded = Vec::new();
    for item in items {
        let p = position(item, false)?;
        if p.0 >= connections || previous.is_some_and(|prev| prev >= p) {
            return Err(invalid());
        }
        previous = Some(p);
        decoded.push(decode_item(item)?);
    }
    page["items"] = Value::Array(decoded);
    if !value["nextCursor"].is_null() {
        let p = position(&value["nextCursor"], true)?;
        if p.0 >= connections || previous.is_none_or(|prev| prev >= p) {
            return Err(invalid());
        }
    }
    if serde_json::to_vec(&page).map_err(|_| invalid())?.len() > 128 * 1024 {
        return Err(invalid());
    }
    Ok(page)
}

fn decode_item(value: &Value) -> Result<Value> {
    let o = record(value, "catalog item")?;
    match value["kind"].as_str().unwrap_or("") {
        "connection" => return header(value),
        "enabled_model_id" => {
            exact(o, &["kind", "connectionIndex", "itemIndex", "modelId"])?;
            string(&value["modelId"], "model id", 512)?;
        }
        "model" => {
            exact(o, &["kind", "connectionIndex", "itemIndex", "model"])?;
            domain(v::connection_model(&value["model"]))?;
        }
        "catalog_entry" => {
            shaped(
                o,
                &["kind", "connectionIndex", "itemIndex", "entry"],
                &["modelOverride"],
            )?;
            let entry: ModelCatalogEntry =
                serde_json::from_value(value["entry"].clone()).map_err(|_| invalid())?;
            domain(entry.validate())?;
            if let Some(profile) = o.get("modelOverride") {
                let profile: ModelOverride =
                    serde_json::from_value(profile.clone()).map_err(|_| invalid())?;
                domain(v::model_override(&entry.id, &profile))?;
            }
        }
        _ => return Err(invalid()),
    }
    Ok(value.clone())
}

fn header(value: &Value) -> Result<Value> {
    let required = [
        "kind",
        "connectionIndex",
        "connectionId",
        "revision",
        "slug",
        "name",
        "provider",
        "configuration",
        "enabled",
        "enabledModelIdCount",
        "modelCount",
        "catalogEntryCount",
    ];
    let optional = ["modelSource", "lastTest", "requestBodyOverlay"];
    let o = record(value, "connection header")?;
    shaped(o, &required, &optional)?;
    let models = bounded(&value["modelCount"], 2048)?;
    bounded(&value["enabledModelIdCount"], 512)?;
    bounded(&value["catalogEntryCount"], MAX_CATALOG_ENTRIES)?;
    if models != 0 && !o.contains_key("modelSource") {
        return Err(invalid());
    }
    let mut row = value.clone();
    let row_object = row.as_object_mut().unwrap();
    for key in [
        "kind",
        "connectionIndex",
        "enabledModelIdCount",
        "modelCount",
        "catalogEntryCount",
    ] {
        row_object.remove(key);
    }
    row["revision"] = json!(count(&value["revision"], "connection revision")?);
    row["enabledModelIds"] = json!([]);
    row["models"] = json!([]);
    if o.contains_key("modelSource") {
        row["modelsFetchedAt"] = json!(0);
    }
    let mut output = value.clone();
    if let Some(overlay) = o.get("requestBodyOverlay") {
        domain(v::overlay(overlay))?;
        if overlay.as_object().is_some_and(|v| v.is_empty()) {
            row.as_object_mut().unwrap().remove("requestBodyOverlay");
            output.as_object_mut().unwrap().remove("requestBodyOverlay");
        }
    }
    let entry: ConnectionCatalogEntry = serde_json::from_value(row).map_err(|_| invalid())?;
    domain(v::catalog_entry(&entry))?;
    Ok(output)
}
