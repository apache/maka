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

use crate::application::Result;
use crate::application::{NativeActivation, NativeOwner, NativeRegistry};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use std::{collections::BTreeMap, sync::Arc};

/// Compiled availability only. A Host composition selects the instance and imports.
pub const GATEWAY: &str = "maka.application.gateway";

struct Gateway;
impl NativeOwner for Gateway {
    fn prepare_retirement(&self) -> Option<Box<dyn crate::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}
/// Register compiled gateway availability; the composition still selects it.
pub fn with_gateway(mut native: NativeRegistry) -> Result<NativeRegistry> {
    native.insert(
        GATEWAY.into(),
        Arc::new(|_, configuration| {
            Box::pin(async move {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Empty {}
                NativeActivation {
                    exports: serde_json::from_value::<Empty>(configuration)
                        .map(|_| BTreeMap::new())
                        .map_err(|e| e.to_string()),
                    owner: Arc::new(Gateway),
                }
            })
        }),
    )?;
    Ok(native)
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        GATEWAY,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [],
    )
}
