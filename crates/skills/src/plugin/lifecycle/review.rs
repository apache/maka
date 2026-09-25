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

impl Skills {
    pub(in crate::plugin) async fn delete_review(
        &self,
        reference: &str,
        workspace_files: &ReadDirectory,
    ) -> Result<(String, Vec<String>), Error> {
        let _call = self.basis.owner.admit().map_err(|_| Error::Retired)?;
        let _serial = self.mutations.read().await;
        let (sources, preferences) = self.governance(workspace_files).await?;
        let item = crate::plugin::catalog::governance::items(&sources, preferences.as_ref())
            .into_iter()
            .find_map(|item| match item {
                CatalogItem::Skill(item) | CatalogItem::DiscoveryDiagnostic(item)
                    if item.reference == reference && item.manageable =>
                {
                    Some(item)
                }
                _ => None,
            })
            .ok_or_else(|| Error::Invalid("Skill directory is not manageable".into()))?;
        // Review is read-only, including for user libraries: discovery already owns that read capability.
        let (files, path) = if let Some(id) = item.reference.strip_prefix("workspace:legacy:") {
            (
                self.data
                    .read_only()
                    .await
                    .map_err(|e| Error::Source(e.to_string()))?,
                format!("skills/{id}"),
            )
        } else if let Some(id) = item.reference.strip_prefix("user:maka:") {
            (
                self.inputs
                    .open("user-skills")
                    .map_err(|e| Error::Source(e.to_string()))?
                    .ok_or(Error::Retired)?,
                format!(".maka/skills/{id}"),
            )
        } else if let Some(id) = item.reference.strip_prefix("user:agents:") {
            (
                self.inputs
                    .open("user-skills")
                    .map_err(|e| Error::Source(e.to_string()))?
                    .ok_or(Error::Retired)?,
                format!(".agents/skills/{id}"),
            )
        } else {
            return Err(Error::Invalid("Skill directory is not deletable".into()));
        };
        let tree = publication::Tree::read_view(&files, &path)
            .await
            .map_err(publication_error)?;
        Ok((tree.digest().map_err(publication_error)?, tree.paths()))
    }
}
