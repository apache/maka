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
mod auto_context;
mod code_mode;
mod code_mode_lifetime;
mod code_mode_media;
mod context_compaction;
mod context_overflow;
mod context_stop;
mod continuation_recovery;
mod dynamic_tools;
mod image_projection;
mod long_task_perf;
mod pruning;
mod retry_recovery;
mod root_context_sources;
mod root_startup_recovery;
mod session_import;
mod stale_pruning;
mod tool_arguments;
mod tool_scheduling;

mod support {
    pub(crate) mod agent_loop;
    pub(crate) mod canonical;
    pub(crate) mod code_mode;
    pub(crate) mod code_mode_lifetime;
    pub(crate) mod context;
    pub(crate) mod http;
    pub(crate) mod image_projection;
    pub(crate) mod native;
}
