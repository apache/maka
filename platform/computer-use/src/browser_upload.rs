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

//! Host-authorized immutable inputs for browser file uploads.

use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::ReadResource;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Requested uploads still require the original Host's current admission,
/// independent origin upload consent and sandbox-governed source-file reads.
/// The values describe the request; they are not a grant or document proof.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserUploadRequest {
    pub document: crate::BrowserDocument,
    pub source_origin: crate::BrowserAttachmentOrigin,
    pub files: Vec<String>,
}

/// Actual immutable Host input. A model descriptor cannot construct this value.
#[derive(Clone)]
pub struct BrowserUploadFile {
    pub name: String,
    pub resource: Arc<dyn ReadResource>,
}

/// The Host returns snapshots, never paths for another machine to dereference.
pub type BrowserUploadFuture = std::pin::Pin<
    Box<
        dyn std::future::Future<Output = Result<Vec<BrowserUploadFile>, ToolError>>
            + Send
            + 'static,
    >,
>;
