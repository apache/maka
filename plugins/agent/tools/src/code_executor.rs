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

use maka_agent_facts::{execution::CodeLanguage, tools::ToolExecutor};
use maka_code_runtime::{CellAbort, CellContext, CellLimits, PreparedCell};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Code Mode policy selects one concrete interpreter for each accepted Run.
/// Construction is cheap: neither backend starts a VM or child process here.
#[derive(Clone)]
pub struct CodeExecutor {
    javascript: maka_js_runtime::CodeExecutor,
    python: maka_python_runtime::CodeExecutor,
    language: CodeLanguage,
}
impl CodeExecutor {
    pub fn new(limits: CellLimits) -> Result<Self, CellAbort> {
        Ok(Self {
            javascript: maka_js_runtime::CodeExecutor::new(limits.clone())?,
            python: maka_python_runtime::CodeExecutor::new(limits)?,
            language: CodeLanguage::default(),
        })
    }
    pub fn with_language(mut self, language: CodeLanguage) -> Self {
        self.language = language;
        self
    }
    /// Explicit packaged worker location for an embedding or integration fixture.
    pub fn with_python_worker(mut self, path: PathBuf) -> Result<Self, CellAbort> {
        self.python = maka_python_runtime::CodeExecutor::with_worker(self.limits().clone(), path)?;
        Ok(self)
    }
    pub fn language(&self) -> CodeLanguage {
        self.language
    }
    pub fn limits(&self) -> &CellLimits {
        self.javascript.limits()
    }
    pub fn tool_identifier(&self, name: &str) -> String {
        match self.language {
            CodeLanguage::JavaScript => maka_js_runtime::tool_identifier(name),
            CodeLanguage::Python => maka_python_runtime::tool_identifier(name),
        }
    }
    /// Observe both original runtime owners, independent of current language.
    /// Subscribe before reconciling; changes only request a fresh VM observation.
    pub fn physical_changes(
        &self,
    ) -> (
        tokio::sync::watch::Receiver<()>,
        tokio::sync::watch::Receiver<()>,
    ) {
        (
            self.javascript.physical_changes(),
            self.python.physical_changes(),
        )
    }

    pub async fn observe_binding(
        &self,
        binding: &maka_code_runtime::VmBinding,
    ) -> maka_code_runtime::RuntimeVmObservation {
        match binding.runtime.as_str() {
            maka_code_runtime::JAVASCRIPT_VM => self.javascript.observe_binding(binding).await,
            maka_code_runtime::PYTHON_VM => self.python.observe_binding(binding).await,
            _ => maka_code_runtime::RuntimeVmObservation::Unobservable {
                diagnostic: "unsupported VM binding contract".into(),
            },
        }
    }
    pub fn release_binding(&self, binding: &maka_code_runtime::VmBinding) -> bool {
        match binding.runtime.as_str() {
            maka_code_runtime::JAVASCRIPT_VM => self.javascript.release_binding(binding),
            maka_code_runtime::PYTHON_VM => self.python.release_binding(binding),
            _ => false,
        }
    }
    pub async fn prepare_module(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
    ) -> Result<PreparedCell, CellAbort> {
        match self.language {
            CodeLanguage::JavaScript => {
                self.javascript
                    .prepare_module(source, tools, cancellation, context)
                    .await
            }
            CodeLanguage::Python => {
                self.python
                    .prepare_module(source, tools, cancellation, context)
                    .await
            }
        }
    }
}
