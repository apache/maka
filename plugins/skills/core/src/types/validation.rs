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

use serde::{Deserialize, Serialize};

/// Shared diagnostic vocabulary for Skill validation and client governance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillValidationCode {
    MissingLock,
    Modified,
    InvalidJson,
    IdMismatch,
    UnsupportedSchema,
    InvalidHash,
    WriteFailed,
    LockSymlink,
    MissingFrontmatter,
    MalformedFrontmatter,
    MissingName,
    InvalidName,
    NameTooLong,
    MissingDescription,
    InvalidDescription,
    DescriptionTooLong,
    InvalidAllowedTools,
    InvalidRequiredTools,
    InvalidRequiredCapabilities,
    InvalidLicense,
    InvalidCompatibility,
    CompatibilityTooLong,
    InvalidMetadata,
    InvalidCategory,
    DuplicateId,
    DuplicateName,
    BlockedPath,
    ReadFailed,
    ProjectionTruncated,
}
