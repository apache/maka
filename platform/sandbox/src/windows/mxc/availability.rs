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

use flatbuffers::FlatBufferBuilder;
use mxc_sdk::mxc_common::{models::ContainerPolicy, ui_policy::resolve_ui_restrictions};
use mxc_sdk::process_container_common::{
    PROCESS_SECURITY_ENVIRONMENT_FLAG_NONE, ProcessSecurityEnvironmentApi,
    SecurityEnvironmentStartupInfo, job_object::to_job_object_uilimit_mask,
};
use mxc_sdk::process_security_environment_spec::process_security_environment_layout::{
    EndpointPolicyT, FilterAction, NetworkPolicyT, ProcessSecurityEnvironmentT, SchemaVersionT,
    finish_process_security_environment_buffer,
};
use std::sync::OnceLock;

/// Probe creation and startup attributes, rather than API presence or an OS
/// version guess. This grants no paths or network and launches no process.
pub fn is_available() -> bool {
    static USABLE: OnceLock<bool> = OnceLock::new();
    *USABLE.get_or_init(|| {
        let policy = ContainerPolicy::default();
        let mut egress = EndpointPolicyT::default();
        egress.default_action = FilterAction::deny;
        let mut network = NetworkPolicyT::default();
        network.egress = Some(Box::new(egress));
        let mut specification = ProcessSecurityEnvironmentT::default();
        specification.version = SchemaVersionT { major: 1, minor: 0 };
        specification.disallow_win32k_system_calls = policy.ui.disable;
        specification.ui_restrictions = u64::from(to_job_object_uilimit_mask(
            &resolve_ui_restrictions(&policy.ui, &policy.base_process_ui),
        ));
        specification.network_policy = Some(Box::new(network));
        let mut builder = FlatBufferBuilder::new();
        let specification = specification.pack(&mut builder);
        finish_process_security_environment_buffer(&mut builder, specification);
        ProcessSecurityEnvironmentApi::load()
            .and_then(|api| {
                api.create(
                    builder.finished_data(),
                    PROCESS_SECURITY_ENVIRONMENT_FLAG_NONE,
                )
            })
            .and_then(|environment| {
                let startup =
                    SecurityEnvironmentStartupInfo::new(Default::default(), environment.raw(), &[]);
                environment.close();
                startup.map(drop)
            })
            .is_ok()
    })
}
