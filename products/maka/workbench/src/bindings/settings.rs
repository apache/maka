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

use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_plugin_core::contract::{ResourceType, text_resource_type};
use serde_json::{Value, json};
use std::{ops::Range, sync::Arc};

pub(super) fn attachments(
    endpoint: &str,
    method: &str,
    input: &Value,
    secret: Option<String>,
) -> Result<Attachments, String> {
    let (required, error) = match (endpoint, method) {
        ("settings", "updateNetwork") => (
            match input.get("credential").and_then(Value::as_str) {
                Some("replace") => true,
                Some("keep" | "delete") => false,
                _ => return Err("settings network credential action is invalid".into()),
            },
            "settings.updateNetwork accepts a required secret only when replacing its credential",
        ),
        _ => (
            endpoint == "settings" && method == "saveCredential",
            "only settings.saveCredential accepts a required secret",
        ),
    };
    match (required, secret) {
        (true, Some(secret)) => Ok(Attachments::from([(
            "secret".into(),
            Arc::new(Text(secret)) as Arc<dyn ReadResource>,
        )])),
        (false, None) => Ok(Attachments::new()),
        _ => Err(error.into()),
    }
}

// Intentionally has no Debug implementation. The key is raw UTF-8 resource
// bytes, never part of the request's JSON input or durable operation context.
struct Text(String);
impl ReadResource for Text {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        text_resource_type()
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        self.0
            .get(range)
            .map(|text| text.as_bytes().to_vec())
            .ok_or_else(|| "secret resource range is not on UTF-8 boundaries".into())
    }
}
