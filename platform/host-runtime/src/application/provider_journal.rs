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

use super::{NativeContext, Result};
use maka_event_log::root_store::ProviderJournal;

impl NativeContext {
    /// Original provider-only reconciliation authority, scoped by this actual
    /// native owner's deployment, namespace and actual package identity. Guests and
    /// ordinary request Contexts only receive the independent read-only recover.
    pub async fn provider_journal(&self) -> Result<ProviderJournal> {
        let persistence = self
            .persistence()
            .ok_or("provider reconciliation requires a persisted native owner")?;
        let journal = persistence
            .store()
            .provider_journal(
                persistence.source().clone(),
                self.activation().instance().clone(),
            )
            .await
            .map_err(|error| error.to_string())?;
        if journal.package() != self.package() {
            return Err("provider journal does not match the native owner's actual package".into());
        }
        Ok(journal)
    }
}
