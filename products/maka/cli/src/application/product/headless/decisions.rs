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

//! Upgrade the wiring of pre-baseline installations across the JEV replacement.
//! Business data stays in its original namespace; no legacy protocol is restored.
use super::{HostError, Input, Selection};
use maka_plugin_core::{
    composition::{InstanceId, Target},
    package::{PackageRef, PackageSelection},
    plan::Plan,
};
use std::collections::{BTreeMap, BTreeSet};

const OLD: &str = "maka.agent.workspace-jev";
const NEW: &str = "maka.agent.workspace-decisions-api";
const GATEWAY: &str = "maka.agent.gateway";

pub(super) fn source(
    input: &mut Input,
    replacements: &BTreeMap<String, PackageRef>,
) -> Result<(), HostError> {
    let Some(package) = replacements.get(NEW) else {
        return Ok(());
    };
    let mut providers = BTreeSet::new();
    for (alias, node) in &mut input.instances {
        let PackageSelection::Pinned { package: current } = &mut node.package else {
            continue;
        };
        if current.id == OLD {
            *current = package.clone();
            providers.insert(vec![alias.clone()]);
        } else if matches!(current.id.as_str(), GATEWAY | "maka.conversations")
            && replacements.contains_key(&current.id)
            && node.bindings.contains_key("jev")
        {
            if node.bindings.contains_key("decisions_api") {
                return Err(
                    format!("cannot migrate JEV: {alias} already binds decisions_api").into(),
                );
            }
            let binding = node.bindings.remove("jev").unwrap();
            node.bindings.insert("decisions_api".into(), binding);
        }
    }
    for node in input.instances.values_mut() {
        for binding in node.bindings.values_mut().flatten() {
            if let Target::Instance { path, export } = binding
                && export == "jev"
                && providers.contains(path)
            {
                *export = "decisions_api".into();
            }
        }
    }
    Ok(())
}

// Recomputed from the frozen source pair during recovery as well as preview.
// Existing grants move with their binding; absent grants remain absent.
pub(super) fn publication(
    selection: &mut Selection,
    previous: &Plan,
    target: &Plan,
) -> Result<Vec<String>, HostError> {
    let Selection::PublicHost {
        endpoints,
        native,
        product_methods,
    } = selection;
    let migrated_gateway = |id: &InstanceId| {
        previous
            .instances()
            .get(id)
            .is_some_and(|old| old.package.id == GATEWAY && old.bindings.contains_key("jev"))
            && target.instances().get(id).is_some_and(|next| {
                next.package.id == GATEWAY
                    && next.bindings.contains_key("decisions_api")
                    && !next.bindings.contains_key("jev")
            })
    };
    let mut changes = Vec::new();
    let rename = endpoints
        .get("jev")
        .is_some_and(|endpoint| endpoint.import == "jev" && migrated_gateway(&endpoint.consumer));
    if rename && endpoints.contains_key("decisions_api") {
        return Err("cannot migrate JEV: public endpoint decisions_api already exists".into());
    }
    for (name, endpoint) in endpoints.iter_mut() {
        if endpoint.import == "jev" && migrated_gateway(&endpoint.consumer) {
            endpoint.import = "decisions_api".into();
            changes.push(format!(
                "/publication/endpoints/{name}: migrate JEV binding"
            ));
        }
    }
    if rename {
        let endpoint = endpoints.remove("jev").unwrap();
        endpoints.insert("decisions_api".into(), endpoint);
        if product_methods.remove("jev") {
            product_methods.insert("decisions_api".into());
        }
    }
    for grant in native {
        if grant.export == "jev"
            && previous
                .instances()
                .get(&grant.provider)
                .is_some_and(|node| node.package.id == OLD)
            && target
                .instances()
                .get(&grant.provider)
                .is_some_and(|node| node.package.id == NEW)
        {
            grant.export = "decisions_api".into();
            changes.push("/publication/native: migrate JEV export".into());
        }
    }
    Ok(changes)
}
