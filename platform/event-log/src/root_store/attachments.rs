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

//! Paired resource custody across selected Sessions and workspace bindings.
use super::*;
use rusqlite::OptionalExtension;

impl RootStore {
    pub(super) async fn pin_session_pair(
        &self,
        session_id: &str,
        target_session: &str,
        work: Option<&SessionStore>,
    ) -> Result<(EventLog, EventLog), StoreError> {
        let work_custody = if let Some(target) = work {
            if !Arc::ptr_eq(&self.gates, &target.gates) {
                return Err(StoreError::InvalidTransition(
                    "foreign Root work custody".into(),
                ));
            }
            target.check_session(target_session)?;
            target.owner()?;
            Some(
                target
                    .work
                    .as_ref()
                    .ok_or_else(|| {
                        StoreError::InvalidTransition("Session has no active work".into())
                    })?
                    .custody()?,
            )
        } else {
            None
        };
        let source = self.session(session_id).await?.owner()?;
        let target = self.session(target_session).await?.owner()?;
        let sessions = Arc::new(
            self.gates
                .read([
                    gates::Key::Session(session_id.to_owned()),
                    gates::Key::Session(target_session.to_owned()),
                ])
                .await?,
        );
        let mut bindings = Vec::new();
        let mut target_binding = None;
        for (owner, session) in [
            (&source, session_id.to_owned()),
            (&target, target_session.to_owned()),
        ] {
            let is_target = session == target_session;
            let binding = owner
                .scoped(Arc::new((sessions.clone(), work_custody.clone())))
                .connection
                .read(move |connection| {
                    let configuration: Option<String> = connection
                        .query_row(
                            "SELECT configuration FROM session_control WHERE id=?",
                            rusqlite::params![session],
                            |row| row.get(0),
                        )
                        .optional()?;
                    crate::workspace_bindings::attached(&serde_json::from_str(
                        &configuration.ok_or(StoreError::SessionNotFound)?,
                    )?)
                })
                .await?;
            if is_target {
                target_binding = binding.as_ref().map(|binding| binding.id);
            }
            bindings.extend(binding.map(|binding| binding.id));
        }
        // The captured Work guard keeps this target attachment stable. A source
        // on the same binding is covered by that exact original binding guard.
        let bindings = self
            .gates
            .read(
                bindings
                    .into_iter()
                    .filter(|id| work_custody.is_none() || Some(*id) != target_binding)
                    .map(gates::Key::Binding),
            )
            .await?;
        let custody: crate::connection::custody::Custody =
            Arc::new((sessions, bindings, work_custody));
        self.require_open()?;
        Ok((source.scoped(custody.clone()), target.scoped(custody)))
    }
}
