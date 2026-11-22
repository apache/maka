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

//! A bridge build owns only the Windows desktop worker transport.
use maka_agent_facts::tools::ToolError;

#[derive(Default)]
pub struct Driver {
    pub(crate) audio_enabled: bool,
    pub(crate) windows: crate::desktop::worker::Worker,
}

impl Driver {
    pub fn with_audio(audio_enabled: bool) -> Self {
        Self {
            audio_enabled,
            windows: crate::desktop::worker::Worker::with_audio(audio_enabled),
        }
    }
    /// Host calls this after all Session resources retire.
    pub async fn close(&mut self) -> Result<(), ToolError> {
        self.windows.close().await
    }
}
