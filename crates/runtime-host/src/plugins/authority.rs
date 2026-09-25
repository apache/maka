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

use super::{Error, PackageLoader, RequiredServices, invalid};
mod removal;
use maka_plugins::{
    composition::{Composition, Ledger, Operation},
    kernel::{Definition, Definitions, Plugin, PluginContext, Prepared},
    package::Package,
};
pub(super) use removal::without_package_layer;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(super) fn prepare(
    ledger: &Ledger,
    packages: &BTreeMap<String, Package>,
    builtins: &Definitions,
    builtin_layers: &BTreeMap<String, Vec<Operation>>,
    loader: &dyn PackageLoader,
    existing: &Definitions,
    existing_requirements: &RequiredServices,
) -> Result<(Composition, Prepared, RequiredServices), Error> {
    let mut definitions = builtins.clone();
    let mut requirements: BTreeMap<_, _> = builtins
        .iter()
        .map(|(id, definition)| (id.clone(), Some(definition.inject.clone())))
        .collect();
    let mut layers = builtin_layers.clone();
    for (id, package) in packages {
        if builtins.contains_key(id) {
            return Err(invalid("external packages cannot replace built-ins"));
        }
        let definition = match existing
            .get(id)
            .filter(|definition| definition.revision == package.digest())
        {
            Some(definition) => {
                requirements.insert(id.clone(), existing_requirements.get(id).cloned().flatten());
                definition.clone()
            }
            None => match loader.definition(package) {
                Ok(definition) => {
                    requirements.insert(id.clone(), Some(definition.inject.clone()));
                    definition
                }
                Err(error) => {
                    requirements.insert(id.clone(), None);
                    Arc::new(Definition {
                        id: id.clone(),
                        revision: package.digest().into(),
                        inject: Vec::new(),
                        dependencies: package
                            .manifest()
                            .dependencies
                            .iter()
                            .map(|dependency| dependency.id.clone())
                            .collect(),
                        plugin: Arc::new(Unavailable(error.to_string())),
                    })
                }
            },
        };
        if definition.id != *id || definition.revision != package.digest() {
            return Err(invalid(
                "package loader returned a different package identity",
            ));
        }
        definitions.insert(id.clone(), definition);
        layers.insert(id.clone(), package.composition()?);
    }
    let mut seen = BTreeSet::new();
    for id in &ledger.package_layers {
        if let Some(composition) = packages
            .get(id)
            .and_then(|package| package.manifest().composition.as_ref())
        {
            for dependency in &composition.structural_dependencies {
                if !seen.contains(dependency) {
                    return Err(invalid(
                        "structural dependencies must precede their dependent package layer",
                    ));
                }
            }
        }
        seen.insert(id.clone());
    }
    let desired = ledger.project(&layers)?;
    let prepared = Prepared::recover(&desired, definitions)?;
    Ok((desired, prepared, requirements))
}

/// A stored but incompatible package is a failed Entry, not a failed Host.
/// Static validation rejects new broken intent; recovery can keep healthy nodes.
pub(super) struct Unavailable(pub(super) String);
impl Plugin for Unavailable {
    fn supports_scope(&self, _: &maka_plugins::composition::Scope) -> bool {
        true
    }
    fn validate(
        &self,
        _: &maka_plugins::composition::Scope,
        _: &serde_json::Value,
    ) -> Result<(), maka_plugins::Error> {
        Err(maka_plugins::Error::Invalid(self.0.clone()))
    }
    fn activate(
        &self,
        _: PluginContext,
        _: serde_json::Value,
    ) -> futures_util::future::BoxFuture<'static, Result<maka_plugins::contributions::Staged, String>>
    {
        let error = self.0.clone();
        Box::pin(async move { Err(error) })
    }
}
