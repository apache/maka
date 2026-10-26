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

//! Captured rendering resources. Artifact payloads remain in their immutable store.
use crate::attachment::StorageRef;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaManifest {
    pub aliases: Vec<ResourceAlias>,
    pub media: Vec<MediaBinding>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResourceAlias {
    pub source: StorageRef,
    pub resolved: Option<StorageRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum MediaBinding {
    /// Canonical and inherited artifacts are immutable and deletion-protected.
    Available { reference: StorageRef },
    /// Never re-probe a failed capture while replaying this prepared group.
    Unavailable { reason: String },
}
