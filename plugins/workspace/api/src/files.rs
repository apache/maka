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

use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub const IMPLEMENTATION: &str = "maka.workspace.files";
pub const EXPORT: &str = "files";

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WorkspaceFileResult")]
pub enum FileResult {
    Completed {
        value: Value,
    },
    /// A known completed failure. Uncertain external effects use the original receipt.
    Failed {
        message: String,
    },
}
pub fn method(name: &str) -> Option<(&'static str, bool)> {
    use maka_fs_tools::*;
    Some(match name {
        "readText" | "readImage" => (READ_NAME, false),
        "glob" => (GLOB_NAME, false),
        "grep" => (GREP_NAME, false),
        "write" => (WRITE_NAME, true),
        "edit" => (EDIT_NAME, true),
        "applyPatch" => (PATCH_NAME, true),
        _ => return None,
    })
}
pub fn contract() -> Contract {
    let mut methods: BTreeMap<String, Method> = [
        ("readText", maka_fs_tools::read_schema()),
        ("readImage", maka_fs_tools::read_schema()),
        ("glob", maka_fs_tools::glob_schema()),
        ("grep", maka_fs_tools::grep_schema()),
        ("write", maka_fs_tools::write_schema()),
        ("edit", maka_fs_tools::edit_schema()),
        ("applyPatch", maka_fs_tools::patch_schema()),
    ]
    .into_iter()
    .map(|(name, input)| {
        (
            name.into(),
            Method {
                progress: None,
                mode: if name == "readImage" {
                    MethodMode::Subscription
                } else if method(name).expect("known method").1 {
                    MethodMode::Mutation
                } else {
                    MethodMode::Query
                },
                input: input.into(),
                output: if name == "readImage" {
                    schemars::schema_for!(maka_agent_api::contract::ImageFrame).into()
                } else {
                    schemars::schema_for!(FileResult).into()
                },
                resources: BTreeMap::new(),
            },
        )
    })
    .collect();
    methods.insert(
        "publishChange".into(),
        Method {
            progress: None,
            mode: MethodMode::Mutation,
            input: schemars::schema_for!(maka_fs_tools::publication::PublishChange).into(),
            output: schemars::schema_for!(maka_fs_tools::publication::PublicationResult).into(),
            resources: BTreeMap::from([(
                "content".into(),
                maka_plugin_core::contract::binary_resource_type().optional(),
            )]),
        },
    );
    Contract {
        name: "maka.workspace.Files".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service { methods },
    }
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [(EXPORT, contract())],
    )
}
