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

mod catalog;
mod context;
mod discovery;
mod document;
mod fields;
mod invocation;
pub mod publication;
mod resources;
pub use resources::Resources;
mod types;
mod yaml;
pub use types::*;

pub use catalog::{Catalog, HostCapabilities, LoadedInstructions, Preference, Preferences};
pub use context::{SearchMatch, SearchResult, SkillMetadata};
pub use discovery::{
    DiscoveredSkill, DiscoveryDiagnostic, DiscoveryFailure, DiscoverySnapshot, LocationId,
    RejectedSkill, ScanError, SkillLocation, Source, prepare_bundled, safe_source_id, scan,
    scan_with_bundled,
};
pub use document::{InvalidDocument, SkillDocument, parse};
pub use fields::{Issue, IssueCode, Manifest, PartialManifest, Severity, SkillAttributes};
pub use invocation::{PreparedInvocation, inline_references};
