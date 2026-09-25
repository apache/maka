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

mod agent_loop;
mod attachment_projection;
mod auto_context;
mod code_mode;
mod code_mode_lifetime;
mod code_mode_media;
mod context_compaction;
mod context_overflow;
mod context_stop;
mod dynamic_tools;
mod executor;
mod frozen_projection;
mod handoff;
mod handoff_compaction;
mod image_projection;
mod lifetime;
mod model_interruption;
mod plugin_composition;
mod pruning;
mod session_import;
mod stale_pruning;
mod startup_recovery;
mod startup_recovery_limits;

mod support {
    pub(crate) mod agent_loop;
    pub(crate) mod code_mode;
    pub(crate) mod code_mode_lifetime;
    pub(crate) mod context;
    pub(crate) mod http;
    pub(crate) mod image_projection;
    pub(crate) mod invocation;
    pub(crate) mod recovery;
}
