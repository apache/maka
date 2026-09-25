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

mod behavior;
mod remote;
mod tools;

use super::owner::Owner;
use futures_util::future::BoxFuture;
use maka_plugins::{
    composition::Scope,
    contributions::Staged,
    kernel::{Plugin, PluginContext},
    session::SessionBehavior,
};
use serde_json::Value;
use std::sync::Arc;

pub const ID: &str = "maka.plan";
pub const PLANNING: &str = "default:plan";
pub const EXECUTION: &str = "maka.plan.execute";

pub struct Builtin;
impl Plugin for Builtin {
    fn supports_scope(&self, scope: &Scope) -> bool {
        *scope == Scope::Profile
    }
    fn validate(&self, _: &Scope, config: &Value) -> Result<(), maka_plugins::Error> {
        if config.is_null() || config.as_object().is_some_and(|value| value.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "Plan takes no instance configuration".into(),
            ))
        }
    }
    fn activate(
        &self,
        context: PluginContext,
        _: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        Box::pin(async move {
            let identity = context.lifecycle.identity().map_err(message)?;
            let owner = Owner::new(
                context
                    .host
                    .ok_or("Plan requires public Host capabilities")?,
                identity.entry_id,
            );
            let stop = context.lifecycle.stopping().map_err(message)?;
            context
                .lifecycle
                .spawn("Plan settlement", owner.clone().run(stop))
                .map_err(message)?;
            let mut staged = Staged::default();
            staged
                .insert(
                    "plan-work",
                    owner.clone() as Arc<dyn maka_plugins::background::BackgroundWork>,
                )
                .map_err(message)?;
            staged
                .insert(PLANNING, SessionBehavior(Arc::new(behavior::Planning)))
                .map_err(message)?;
            staged
                .insert(
                    EXECUTION,
                    SessionBehavior(Arc::new(behavior::Execute(owner.clone()))),
                )
                .map_err(message)?;
            tools::publish(owner.clone(), &mut staged)?;
            remote::publish(owner, &identity.package_id, &mut staged)?;
            Ok(staged)
        })
    }
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
