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

use maka_protocol::{ProtocolError, Result, codec};
use serde_json::Value;

/// Unsolicited frames have no request ID; each has a typed consumer.
#[derive(Debug, Clone, PartialEq)]
pub enum Notification {
    Catalog(CatalogNotification),
    Observation(Box<maka_protocol::subscription::ObservationFrame>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CatalogNotification {
    pub kind: String,
    pub revision: Value,
    pub session_id: Option<String>,
}

pub(crate) fn decode(value: &Value) -> Result<Notification> {
    let row = codec::record(value, "Host notification")?;
    let kind = codec::string(&value["kind"], "notification kind", 128)?;
    if kind.starts_with("subscription.") {
        return maka_protocol::subscription::decode_observation_frame(value)
            .map(|frame| Notification::Observation(Box::new(frame)));
    }
    let session_id = match kind.as_str() {
        "configuration.changed"
        | "connection.catalog.changed"
        | "project.catalog.changed"
        | "model.provider.catalog.changed"
        | "plugin.client.changed"
        | "plugin.platform.changed"
        | "plugin.terminal.changed" => {
            codec::exact(row, &["kind", "revision"])?;
            None
        }
        "session.catalog.changed" => {
            codec::shaped(row, &["kind", "revision"], &["sessionId"])?;
            row.get("sessionId")
                .map(|id| codec::string(id, "sessionId", 128))
                .transpose()?
        }
        _ => {
            return Err(ProtocolError::invalid(format!(
                "Unsupported Host notification: {kind}"
            )));
        }
    };
    if kind == "plugin.client.changed" {
        let revision = codec::string(&value["revision"], "plugin revision", 71)?;
        let digest = revision.strip_prefix("sha256-").unwrap_or("");
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ProtocolError::invalid("Invalid plugin revision"));
        }
    } else {
        codec::count(&value["revision"], "catalog revision")?;
    }
    Ok(Notification::Catalog(CatalogNotification {
        kind,
        revision: value["revision"].clone(),
        session_id,
    }))
}
