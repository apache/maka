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

//! Factories compiled into the Maka product; composition decides activation.
pub mod catalog;

use maka_host_runtime::application::NativeRegistry;
use std::sync::Arc;
pub fn provide(
    registry: &mut NativeRegistry,
    catalog: Arc<catalog::Catalog>,
) -> Result<(), String> {
    maka_agent_native::provide(registry, catalog.clone())?;
    maka_acp_native::provide(registry)?;
    maka_files_native::provide(registry)?;
    maka_computer_native::provide(registry)?;
    maka_processes_native::provide(registry)?;
    maka_skills_native::provide(registry)?;
    maka_interactions_native::questions::provide(registry)?;
    maka_interactions_native::forms::provide(registry)?;
    maka_web::provide(registry)?;
    maka_jev_native::provide(registry)?;
    maka_agent_native::workhub::provide(registry, catalog.clone())?;
    maka_settings_native::provide(registry, catalog)?;
    Ok(())
}
