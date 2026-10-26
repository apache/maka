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

use super::ScanError;
use crate::SkillDocument;

#[derive(Debug, Clone)]
pub(super) struct BundledSource {
    pub id: &'static str,
    pub document: SkillDocument,
    pub content_sha256: String,
    pub(crate) resources: crate::resources::Embedded,
}
struct Bundled {
    id: &'static str,
    content: &'static str,
    files: &'static [(&'static str, &'static [u8])],
}
include!(concat!(env!("OUT_DIR"), "/bundled.rs"));

pub(super) fn bundled() -> Result<Vec<BundledSource>, ScanError> {
    static PREPARED: std::sync::OnceLock<Result<Vec<BundledSource>, ScanError>> =
        std::sync::OnceLock::new();
    PREPARED
        .get_or_init(|| {
            BUNDLED
                .iter()
                .map(|source| {
                    let Bundled { id, content, files } = source;
                    Ok(BundledSource {
                        id,
                        document: crate::parse(content).map_err(|_| ScanError::Unavailable)?,
                        content_sha256: maka_agent_facts::artifact::content_digest(
                            content.as_bytes(),
                        ),
                        resources: crate::resources::Embedded::new(files)?,
                    })
                })
                .collect::<Result<Vec<_>, ScanError>>()
        })
        .clone()
}

pub fn safe_source_id(id: &str) -> bool {
    !id.is_empty()
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
