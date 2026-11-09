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

//! Agent execution as an ordinary native application plugin. Product composition
//! chooses whether to activate it; installing this crate does not start a product.
/// Public wire types and generated contracts. 公开协议类型与生成契约。
use maka_agent_api::contract;
pub mod checkpoints;
mod diagnostics;
pub mod executor;
mod mcp;
mod model;
mod owner;
mod service;
mod source_path;
mod tools;
use maka_agent_api::{Configuration, EXPORT, IMPLEMENTATION, ModelSelection, configuration_schema};
use maka_host_runtime::application::{NativeActivation, NativeContext, NativeRegistry};
use maka_workspace_support as workspace;
use std::sync::Arc;

pub fn provide(
    registry: &mut NativeRegistry,
    catalog: Arc<maka_providers::catalog::Catalog>,
    state: maka_agent_state::Store,
    helper: std::path::PathBuf,
) -> Result<(), String> {
    provide_inner(registry, catalog, state, helper, None)
}

/// Supply the live embedding-side rate reader, sampled at the original request boundary.
pub fn provide_with_pricing(
    registry: &mut NativeRegistry,
    catalog: Arc<maka_providers::catalog::Catalog>,
    state: maka_agent_state::Store,
    helper: std::path::PathBuf,
    pricing: Arc<dyn maka_agent_engine::pricing::Pricing>,
) -> Result<(), String> {
    provide_inner(registry, catalog, state, helper, Some(pricing))
}

fn provide_inner(
    registry: &mut NativeRegistry,
    catalog: Arc<maka_providers::catalog::Catalog>,
    state: maka_agent_state::Store,
    helper: std::path::PathBuf,
    pricing: Option<Arc<dyn maka_agent_engine::pricing::Pricing>>,
) -> Result<(), String> {
    registry.insert(
        maka_agent_api::IMPLEMENTATION.into(),
        Arc::new(move |context, configuration| {
            let catalog = catalog.clone();
            let state = state.clone();
            let helper = helper.clone();
            let pricing = pricing.clone();
            Box::pin(async move {
                match owner::Owner::open(context, configuration, catalog, state, helper, pricing)
                    .await
                {
                    Ok(owner) => {
                        let service = Arc::new(service::Agent(owner));
                        NativeActivation {
                            exports: Ok(std::collections::BTreeMap::from([(
                                EXPORT.into(),
                                maka_plugin_core::runtime::Published {
                                    contract: contract(),
                                    value: service.clone()
                                        as Arc<dyn maka_host_runtime::application::Handler>,
                                },
                            )])),
                            owner: service,
                        }
                    }
                    Err(error) => error.activation(),
                }
            })
        }),
    )
}
