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

use super::*;
use crate::package::Packages;

/// A composition selected at deployment scope, without introducing an instance.
/// Additional roots remain in Input.instances; inherited roots are edited with overrides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RootComposition {
    pub package: PackageRef,
    #[serde(default)]
    pub parameters: BTreeMap<String, Value>,
    #[serde(default)]
    pub overrides: Vec<Override>,
    /// Absent inherits the template UI; null explicitly selects no UI.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub ui: Option<Option<UiTarget>>,
}

impl Input {
    /// Locate the owning override without flattening inherited source into local instances.
    pub fn override_mut(&mut self, path: &[String]) -> Result<&mut Override, Error> {
        validate_path(path)?;
        let (root, relative) = path.split_first().unwrap();
        let (patches, path) = if let Some(node) = self.instances.get_mut(root) {
            if relative.is_empty() {
                return Err(Error::Composition(
                    "direct root does not need an override".into(),
                ));
            }
            (&mut node.overrides, relative)
        } else {
            (
                &mut self
                    .base
                    .as_mut()
                    .ok_or_else(|| Error::Composition("root instance missing".into()))?
                    .overrides,
                path,
            )
        };
        let index = patches
            .iter()
            .position(|patch| patch.path == path)
            .unwrap_or_else(|| {
                patches.push(Override {
                    path: path.to_vec(),
                    ..Override::default()
                });
                patches.len() - 1
            });
        Ok(&mut patches[index])
    }

    /// Record exact configuration edits at their original source owner.
    pub fn configure(
        &mut self,
        path: &[String],
        fields: Vec<ConfigurationField>,
    ) -> Result<(), Error> {
        Override {
            path: path.to_vec(),
            configuration_fields: fields.clone(),
            ..Override::default()
        }
        .validate()?;
        if path.len() == 1 && self.instances.contains_key(&path[0]) {
            let node = self.instances.get_mut(&path[0]).unwrap();
            for field in fields {
                field.apply(&mut node.configuration)?;
            }
        } else {
            let patch = self.override_mut(path)?;
            for field in fields {
                if field.path.len() == 1 {
                    patch.configuration.remove(&field.path[0]);
                }
                ConfigurationField::insert(&mut patch.configuration_fields, field)?;
            }
            patch.validate()?;
        }
        Ok(())
    }

    /// Derived source for planning and source inspection. Never persist this
    /// instead of the baseline reference and its independent user overrides.
    pub fn materialize(&self, packages: &Packages) -> Result<Self, Error> {
        let Some(base) = &self.base else {
            return Ok(self.clone());
        };
        base.package.validate()?;
        let template = packages
            .get(&base.package)
            .and_then(|declaration| declaration.composition.as_ref())
            .ok_or_else(|| {
                Error::Composition("root baseline must select a composition package".into())
            })?;
        if !template.imports.is_empty() || !template.exports.is_empty() {
            return Err(Error::Composition(
                "root composition cannot declare imports or exports".into(),
            ));
        }
        let parameters = template.resolve_parameters(base.parameters.clone())?;
        validate_overrides(&base.overrides)?;
        for patch in &base.overrides {
            if !template.children.contains_key(&patch.path[0]) {
                return Err(Error::Composition(format!(
                    "override target disappeared: {:?}",
                    patch.path
                )));
            }
        }
        // A removed inherited root reintroduced under another alias with the
        // same UUID is a rename, not a different provider. New default bindings
        // must continue addressing that identity rather than its retired alias.
        let renames: BTreeMap<_, _> = base
            .overrides
            .iter()
            .filter(|patch| patch.path.len() == 1 && patch.remove)
            .filter_map(|patch| {
                let original = &template.children[&patch.path[0]];
                self.instances
                    .iter()
                    .find(|(_, node)| node.key == original.key)
                    .map(|(name, _)| (patch.path[0].clone(), name.clone()))
            })
            .collect();
        let mut instances = BTreeMap::new();
        for (name, original) in &template.children {
            if base
                .overrides
                .iter()
                .any(|patch| patch.path == [name.clone()] && patch.remove)
            {
                continue;
            }
            let mut node = original.clone();
            node.apply_overrides(name, &base.overrides, &parameters)?;
            node.configuration = Configuration {
                values: node.configuration.resolve(&parameters)?,
                ..Configuration::default()
            };
            node.parameters = Configuration {
                values: node.parameters.resolve(&parameters)?,
                ..Configuration::default()
            };
            if node.package == PackageSelection::Current {
                node.package = base.package.clone().into();
            }
            for targets in node.bindings.values_mut() {
                for target in targets {
                    if let Target::Instance { path, .. } = target {
                        if let Some(alias) = path.first().and_then(|root| renames.get(root)) {
                            path[0] = alias.clone();
                        }
                    }
                }
            }
            instances.insert(name.clone(), node);
        }
        for (name, node) in &self.instances {
            if template.children.contains_key(name)
                && !base
                    .overrides
                    .iter()
                    .any(|patch| patch.path == [name.clone()] && patch.remove)
            {
                return Err(Error::Composition(format!(
                    "explicit root shadows baseline child: {name}"
                )));
            }
            instances.insert(name.clone(), node.clone());
        }
        validate_nodes(&instances)?;
        let mut inherited_ui = base.ui.clone().unwrap_or_else(|| template.ui.clone());
        if let Some(ui) = &mut inherited_ui {
            if let Some(alias) = ui.path.first().and_then(|root| renames.get(root)) {
                ui.path[0] = alias.clone();
            }
        }
        Ok(Self {
            base: None,
            instances,
            ui: self.ui.clone().or(inherited_ui),
        })
    }
}
