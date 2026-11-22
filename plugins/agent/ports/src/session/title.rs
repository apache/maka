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

//! Host-owned automatic naming; policies cannot write Session metadata or run tools.
use std::sync::Arc;

/// The Host supplies only the first committed user text, never prepared instructions.
/// Generation is a separate auxiliary request using that opening's model.
/// The Host caps output at 2048 tokens and cancels it after 30 seconds.
pub trait Policy: Send + Sync {
    fn prepare(
        &self,
        text: &str,
        language: maka_agent_facts::language::Language,
    ) -> Option<crate::llm::Generate>;
}

pub struct SessionTitlePolicy(pub Arc<dyn Policy>);

/// One effective policy per Session, resolved through the composition overlay.
pub const NAME: &str = "session-title";
