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

use super::validate_path;
use crate::Error;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u8,
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub localizations:
        std::collections::BTreeMap<String, maka_plugin_core::package::PackageDescription>,
    pub application: Option<maka_plugin_core::package::CheckedDeclaration>,
}
impl Manifest {
    pub fn presentation(&self) -> maka_plugin_core::package::PackagePresentation {
        maka_plugin_core::package::PackagePresentation {
            display_name: self.display_name.clone(),
            description: self.description.clone(),
            localizations: self.localizations.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), Error> {
        maka_plugin_core::identifier(&self.id).map_err(|e| Error::Invalid(e.to_string()))?;
        if self.schema_version != 1 {
            return Err(Error::Invalid("unsupported manifest version".into()));
        }
        let application = self
            .application
            .as_ref()
            .ok_or_else(|| Error::Invalid("application declaration is missing".into()))?;
        if let Some(entry) = &application.host
            && let maka_plugin_core::package::Implementation::JavaScript { module, .. } =
                &entry.implementation
        {
            validate_path(module)?;
        }
        if let Some(ui) = &application.ui {
            validate_path(&ui.module)?;
        }
        if self.localizations.keys().any(|locale| {
            locale.is_empty()
                || !locale
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        }) {
            return Err(Error::Invalid("invalid package locale".into()));
        }
        Ok(())
    }
}
