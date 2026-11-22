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

use super::Package;
use crate::Error;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    schema_version: u8,
    digest: String,
    files: Vec<BundleFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleFile {
    path: String,
    content: String,
}

impl Package {
    pub fn from_bundle(bytes: &[u8]) -> Result<Self, Error> {
        let bundle: Bundle = serde_json::from_slice(bytes)
            .map_err(|error| Error::Invalid(format!("bundle: {error}")))?;
        if bundle.schema_version != 1 {
            return Err(Error::Invalid("unsupported bundle schema".into()));
        }
        let mut files = BTreeMap::new();
        for file in bundle.files {
            let bytes = STANDARD
                .decode(file.content)
                .map_err(|error| Error::Invalid(format!("invalid bundle base64: {error}")))?;
            if files.insert(file.path, bytes).is_some() {
                return Err(Error::Invalid(
                    "bundle contains duplicate file paths".into(),
                ));
            }
        }
        let package = Self::new(files)?;
        if package.digest() != bundle.digest {
            return Err(Error::Invalid("bundle package digest mismatch".into()));
        }
        Ok(package)
    }

    pub fn to_bundle(&self) -> Vec<u8> {
        let bundle = Bundle {
            schema_version: 1,
            digest: self.digest().into(),
            files: self
                .files()
                .iter()
                .map(|(path, bytes)| BundleFile {
                    path: path.clone(),
                    content: STANDARD.encode(bytes),
                })
                .collect(),
        };
        serde_json::to_vec(&bundle).expect("bundle contains only serializable strings")
    }
}
