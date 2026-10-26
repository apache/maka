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

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    Error,
    composition::Template,
    contract::{Availability, Contract, Export, Import, Interface},
};

/// Author-provided copy for plugin discovery; never an authority declaration.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageDescription {
    pub display_name: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackagePresentation {
    pub display_name: String,
    pub description: String,
    #[serde(default)]
    pub localizations: BTreeMap<String, PackageDescription>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PackageRef {
    pub id: String,
    pub revision: String,
}

impl PackageRef {
    pub fn validate(&self) -> Result<(), Error> {
        crate::name(&self.id)?;
        if !crate::content_hash(&self.revision) {
            return Err(Error::Declaration(
                "package revision must pin immutable bytes".into(),
            ));
        }
        Ok(())
    }
}

/// Templates can select an entry in their own immutable package without a
/// self-referential content hash. Deployment roots must select a pinned revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
pub enum PackageSelection {
    Pinned { package: PackageRef },
    Current,
}

impl From<PackageRef> for PackageSelection {
    fn from(package: PackageRef) -> Self {
        Self::Pinned { package }
    }
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum EntryTarget {
    Host,
    Tui,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "PackageDeclaration")]
pub struct Declaration {
    #[serde(default)]
    pub entries: BTreeMap<EntryTarget, EntryDeclaration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition: Option<Template>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryDeclaration {
    pub implementation: Implementation,
    /// Nominal ABI of this JavaScript entry's component scenes. Native recipes
    /// are checked through their compiled implementation availability instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<SceneLanguage>,
    pub configuration: crate::Schema,
    #[serde(default)]
    pub imports: BTreeMap<String, Import>,
    #[serde(default)]
    pub exports: BTreeMap<String, Export>,
}

/// Presenter-owned language identity. The kernel does not interpret its syntax.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SceneLanguage {
    pub name: String,
    pub version: u32,
}
impl SceneLanguage {
    pub fn validate(&self) -> Result<(), Error> {
        crate::name(&self.name)?;
        if self.version == 0 {
            return Err(Error::Declaration(
                "scene language version must be nonzero".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Implementation {
    #[serde(rename = "javascript")]
    JavaScript {
        module: String,
        realm: Realm,
    },
    Native {
        implementation: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Realm {
    Shared,
    Dedicated,
}

impl EntryDeclaration {
    pub fn validate(&self) -> Result<(), Error> {
        match &self.implementation {
            Implementation::JavaScript { module, .. } if module.is_empty() => {
                return Err(Error::Declaration("JavaScript module is missing".into()));
            }
            Implementation::Native { implementation } => crate::name(implementation)?,
            _ => {}
        }
        let needs_scene = matches!(self.implementation, Implementation::JavaScript { .. })
            && self
                .exports
                .values()
                .any(|export| matches!(export.contract.interface, Interface::Component { .. }));
        match (&self.scene, needs_scene) {
            (Some(language), true) => language.validate()?,
            (None, true) => {
                return Err(Error::Declaration(
                    "JavaScript components require a scene language".into(),
                ));
            }
            (Some(_), false) => {
                return Err(Error::Declaration(
                    "scene language requires JavaScript component exports".into(),
                ));
            }
            (None, false) => {}
        }
        crate::schema(&self.configuration)?;
        validate_imports(&self.imports)?;
        for (name, export) in &self.exports {
            crate::name(name)?;
            export.contract.validate()?;
        }
        Ok(())
    }

    /// Check the entire activation batch before publishing any actual exports.
    pub fn check_exports<T>(
        &self,
        actual: &BTreeMap<String, T>,
        contract: impl Fn(&T) -> &Contract,
    ) -> Result<(), Error> {
        for (name, value) in actual {
            if !self
                .exports
                .get(name)
                .is_some_and(|declared| declared.contract.accepts(contract(value)))
            {
                return Err(Error::Contract(format!(
                    "undeclared or changed export: {name}"
                )));
            }
        }
        for (name, export) in &self.exports {
            if export.availability == Availability::Required && !actual.contains_key(name) {
                return Err(Error::Contract(format!("missing required export: {name}")));
            }
        }
        Ok(())
    }
}

pub(crate) fn validate_imports(imports: &BTreeMap<String, Import>) -> Result<(), Error> {
    for (name, import) in imports {
        crate::name(name)?;
        import.contract.validate()?;
        import.cardinality.validate()?;
    }
    Ok(())
}

impl Declaration {
    pub fn validate(&self) -> Result<(), Error> {
        if self.entries.is_empty() && self.composition.is_none() {
            return Err(Error::Declaration(
                "package has no entries or composition".into(),
            ));
        }
        for (target, entry) in &self.entries {
            entry.validate()?;
            if *target == EntryTarget::Host && entry.scene.is_some() {
                return Err(Error::Declaration(
                    "Host entry cannot require a scene language".into(),
                ));
            }
        }
        if let Some(template) = &self.composition {
            template.validate()?;
        }
        Ok(())
    }
}

/// Immutable declaration checked once at its input boundary.
/// Cloning shares the checked value; editing requires a separate raw declaration.
#[derive(Clone, Debug, PartialEq)]
pub struct CheckedDeclaration(std::sync::Arc<Declaration>);

impl CheckedDeclaration {
    pub fn new(declaration: Declaration) -> Result<Self, Error> {
        declaration.validate()?;
        Ok(Self(std::sync::Arc::new(declaration)))
    }

    pub fn declaration(&self) -> &Declaration {
        &self.0
    }
}
impl std::ops::Deref for CheckedDeclaration {
    type Target = Declaration;
    fn deref(&self) -> &Declaration {
        self.declaration()
    }
}
impl Serialize for CheckedDeclaration {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.declaration().serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for CheckedDeclaration {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(Declaration::deserialize(deserializer)?).map_err(|error| {
            serde::de::Error::custom(format!("invalid application declaration: {error}"))
        })
    }
}
impl JsonSchema for CheckedDeclaration {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        Declaration::schema_name()
    }
    fn schema_id() -> std::borrow::Cow<'static, str> {
        Declaration::schema_id()
    }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        Declaration::json_schema(generator)
    }
}

/// Immutable declarations indexed by their exact package revision.
#[derive(Clone, Default)]
pub struct Packages(BTreeMap<PackageRef, CheckedDeclaration>);

impl Packages {
    pub fn insert(&mut self, package: PackageRef, declaration: Declaration) -> Result<(), Error> {
        self.insert_checked(package, CheckedDeclaration::new(declaration)?)
    }

    pub fn insert_checked(
        &mut self,
        package: PackageRef,
        declaration: CheckedDeclaration,
    ) -> Result<(), Error> {
        package.validate()?;
        if self
            .0
            .get(&package)
            .is_some_and(|current| current != &declaration)
        {
            return Err(Error::Declaration(
                "package revision was reused with different declarations".into(),
            ));
        }
        self.0.insert(package, declaration);
        Ok(())
    }

    pub fn get(&self, package: &PackageRef) -> Option<&Declaration> {
        self.0.get(package).map(CheckedDeclaration::declaration)
    }
}

/// Compiled provider facts shared by native registration and package authoring.
/// These facts describe availability; only a committed composition grants access.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDefinition {
    pub implementation: String,
    pub configuration: crate::Schema,
    pub exports: BTreeMap<String, Contract>,
}
impl NativeDefinition {
    pub fn new<const N: usize>(
        implementation: &str,
        configuration: Value,
        exports: [(&str, Contract); N],
    ) -> Self {
        Self {
            implementation: implementation.into(),
            configuration: configuration.into(),
            exports: exports
                .into_iter()
                .map(|(name, contract)| (name.into(), contract))
                .collect(),
        }
    }
}
