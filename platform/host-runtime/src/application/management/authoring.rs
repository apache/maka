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

//! Text authoring uses the same loader, revision checks and commit as native captures.
use super::*;
use maka_plugin_core::deployment::management::{
    DeploymentSourceReplace, PackageSourceChunk, PackageSourceInstall, PackageSourceRead,
};
impl Manager {
    pub(super) async fn install_source(&self, input: Value) -> Result<Value> {
        let request: PackageSourceInstall =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        let package = match Package::new(
            request
                .files
                .into_iter()
                .map(|(path, text)| (path, text.into_bytes()))
                .collect(),
        ) {
            Ok(package) => package,
            Err(error) => {
                return rejected_diagnostic(ManagementRejection::InvalidBundle, error.to_string());
            }
        };
        self.install_package(request.expected_revision, package, metadata)
            .await
    }
    pub(super) async fn replace_source(&self, input: Value) -> Result<Value> {
        let request: DeploymentSourceReplace =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        self.replace_document(
            request.expected_revision,
            request.document,
            metadata,
            Vec::new(),
        )
        .await
    }
    pub(super) async fn read_package(&self, input: Value) -> Result<Value> {
        let request: PackageSourceRead =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _read = self.writes.lock().await;
        let loaded = self.source_at(Some(request.source)).await?;
        let package = loaded
            .packages()
            .iter()
            .find(|p| p.application_ref() == request.package)
            .ok_or("package is not installed in this source")?;
        let paths = package.files().keys().cloned().collect();
        let (text, next) = if let Some(path) = request.path {
            let text = std::str::from_utf8(package.file(&path).ok_or("package file unavailable")?)
                .map_err(|_| "package file is not UTF-8")?;
            if request.offset > text.len() || !text.is_char_boundary(request.offset) {
                return Err("invalid package byte offset".into());
            }
            let mut end = request.offset.saturating_add(16384).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1
            }
            (
                Some(text[request.offset..end].to_owned()),
                (end < text.len()).then_some(end),
            )
        } else {
            (None, None)
        };
        serde_json::to_value(PackageSourceChunk { paths, text, next }).map_err(|e| e.to_string())
    }
}
