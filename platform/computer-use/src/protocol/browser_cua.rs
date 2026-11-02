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

use serde::{Deserialize, Serialize};
use serde_json::Value;

// A supplied JSON null differs from an omitted optional mouse button.
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserCuaOperation {
    Move {
        x: Value,
        y: Value,
        keys: Option<Value>,
    },
    Click {
        x: Value,
        y: Value,
        #[serde(default, deserialize_with = "present_value")]
        button: Option<Value>,
        keys: Option<Value>,
    },
    DoubleClick {
        x: Value,
        y: Value,
        keys: Option<Value>,
    },
    Drag {
        path: Value,
        keys: Option<Value>,
    },
    Scroll {
        x: Value,
        y: Value,
        #[serde(rename = "scrollX")]
        scroll_x: Value,
        #[serde(rename = "scrollY")]
        scroll_y: Value,
        keys: Option<Value>,
    },
    Keypress {
        keys: Value,
    },
    DomKeypress {
        keys: Value,
    },
    Type {
        text: Value,
    },
    DomType {
        text: Value,
    },
    DomSnapshot,
    DomClick {
        node_id: String,
    },
    DomDoubleClick {
        node_id: String,
    },
    DomScroll {
        #[serde(default)]
        node_id: Option<String>,
        #[serde(rename = "scrollX")]
        scroll_x: Value,
        #[serde(rename = "scrollY")]
        scroll_y: Value,
    },
}
