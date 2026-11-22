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

//! Host-provided file publication carries immutable request resources.
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::ReadResource;
use std::{future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;
pub type FilesFuture<T> = Pin<Box<dyn Future<Output = Result<T, ToolError>> + Send + 'static>>;
/// One binding from the actual Host Session. This neither grants transfers nor
/// selects an output path, and is never serialized in a model command.
pub trait BrowserAssetFiles: Send + Sync {
    fn snapshot(&self, name: String, bytes: Vec<u8>) -> Result<Arc<dyn ReadResource>, ToolError>;
    fn begin(&self, cancellation: CancellationToken)
    -> FilesFuture<Box<dyn BrowserAssetDirectory>>;
}
pub trait BrowserAssetDirectory: Send {
    fn path(&self) -> &str;
    fn write(
        &mut self,
        name: String,
        resource: Arc<dyn ReadResource>,
        cancellation: CancellationToken,
    ) -> FilesFuture<String>;
    fn commit(&mut self, cancellation: CancellationToken) -> FilesFuture<()>;
    fn abort(&mut self) -> FilesFuture<()>;
}
