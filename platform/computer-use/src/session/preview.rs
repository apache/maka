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

impl Session {
    pub(super) fn publish_native_preview(
        &self,
        handle: &str,
        invocation: &crate::InvocationContext<'_>,
    ) {
        let Some(target) = self.targets.get(handle) else {
            return;
        };
        self.publish_window_preview(handle, &target.window, &target.process, invocation);
    }
    pub(super) fn publish_window_preview(
        &self,
        _key: &str,
        window: &WindowInfo,
        process: &str,
        invocation: &crate::InvocationContext<'_>,
    ) {
        let Some(pid) = window.pid else {
            return;
        };
        let binding = crate::ComputerAppBinding {
            pid,
            window_id: window.window_id,
            process_generation: process.to_owned(),
        };
        self.publish_binding_preview(binding, window.app_name.clone(), invocation);
    }
    pub(super) fn publish_binding_preview(
        &self,
        binding: crate::ComputerAppBinding,
        label: String,
        invocation: &crate::InvocationContext<'_>,
    ) {
        let Some(operation_id) = invocation.operation_id() else {
            return;
        };
        let subject = match invocation.app_target() {
            Some(approved) => crate::preview::PreviewSubject::Native {
                operation_id: operation_id.to_owned(),
                target: approved.clone(),
            },
            #[cfg(target_os = "linux")]
            None => crate::preview::PreviewSubject::NativeWindow {
                operation_id: operation_id.to_owned(),
                binding: binding.clone(),
            },
            #[cfg(not(target_os = "linux"))]
            None => return,
        };
        self.owner.preview().register(
            self.epoch,
            binding_key(&binding),
            crate::preview::PreviewKind::App,
            label,
            std::sync::Arc::new(crate::preview::native::NativeCapture {
                binding,
                subject,
                execution: invocation.execution_correlation().clone(),
            }),
        );
    }
}

pub(super) fn window_key(window: &WindowInfo, process: &str) -> String {
    format!(
        "native:{}:{}:{}",
        window.pid.unwrap_or_default(),
        process,
        window.window_id
    )
}

pub(super) fn binding_key(binding: &crate::ComputerAppBinding) -> String {
    format!(
        "native:{}:{}:{}",
        binding.pid, binding.process_generation, binding.window_id
    )
}
