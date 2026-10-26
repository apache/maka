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

use super::{RootStore, SessionStore};
use crate::StoreError;
use maka_agent_facts::{event::Invocation, tools::ExecutionCustody};
use std::sync::Arc;

struct SelectedExecution(SessionStore);
impl ExecutionCustody for SelectedExecution {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
impl SessionStore {
    /// Carry the original selected execution through dependency boundaries.
    /// This token grants no authority after its execution owner finishes.
    pub fn execution_custody(&self) -> Result<Arc<dyn ExecutionCustody>, StoreError> {
        self.owner()?;
        if !self.execution.as_ref().is_some_and(|pins| pins.active()) {
            return Err(StoreError::InvalidTransition(
                "Session has no active execution".into(),
            ));
        }
        Ok(Arc::new(SelectedExecution(self.clone())))
    }
}
impl RootStore {
    /// Fork physical child work from the same original admission. The child
    /// retains those guards independently until its own confirmed cleanup.
    pub fn fork_execution(
        &self,
        custody: &dyn ExecutionCustody,
        invocation: &Invocation,
    ) -> Result<super::SessionExecutionLease, StoreError> {
        self.session_for_execution(custody, invocation)?
            .fork_execution()
    }

    /// Recover the actual selected handle without reacquiring any binding gate.
    pub fn session_for_execution(
        &self,
        custody: &dyn ExecutionCustody,
        invocation: &Invocation,
    ) -> Result<SessionStore, StoreError> {
        let selected = custody
            .as_any()
            .downcast_ref::<SelectedExecution>()
            .ok_or_else(|| StoreError::InvalidTransition("foreign execution custody".into()))?;
        let store = &selected.0;
        if !Arc::ptr_eq(&self.gates, &store.gates) {
            return Err(StoreError::InvalidTransition(
                "foreign Root execution custody".into(),
            ));
        }
        store.check_session(&invocation.session_id)?;
        store.owner()?;
        Ok(store.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::{RootNamespaces, RootOwner};
    use futures_util::poll;
    use maka_agent_facts::{
        tools::ToolJournal,
        workspace::{BindingStamp, PermissionBasis},
    };
    use serde_json::{Value, json};
    use std::time::Duration;

    #[tokio::test]
    async fn journal_carries_original_binding_pin_past_queued_writer_and_rejects_foreign_or_finished_tokens()
     {
        let directory = tempfile::tempdir().unwrap();
        let root = RootStore::open(Arc::new(
            RootOwner::create(
                &directory.path().join("root"),
                &RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        ))
        .await
        .unwrap();
        let reference = root
            .attach_workspace("owner", &json!({"path":"/tmp/tool-custody"}))
            .await
            .unwrap();
        let session = root
            .create_session(
                "session",
                "session",
                &json!({"workspace":reference,"boundary_revision":0}),
                1,
            )
            .await
            .unwrap();
        assert!(session.execution_custody().is_err());
        let scope = session
            .execution_scope(Some(PermissionBasis {
                binding: BindingStamp {
                    id: reference.id,
                    permission_epoch: 0,
                },
                boundary_revision: 0,
            }))
            .await
            .unwrap();
        let selected = Arc::new(scope.store());
        let lease = scope.accept();
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let journal = ToolJournal::new(selected, invocation.clone());
        let context = journal.context("tool".into());
        let custody = context.execution.as_ref().unwrap();
        let mut writer = Box::pin(
            root.gates
                .write([super::super::gates::Key::Binding(reference.id)]),
        );
        assert!(poll!(&mut writer).is_pending());
        let recovered = root
            .session_for_execution(custody.as_ref(), &context.invocation)
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), recovered.get::<Value>())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .id,
            "session"
        );
        let mut foreign = invocation.clone();
        foreign.session_id = "foreign".into();
        assert!(
            root.session_for_execution(custody.as_ref(), &foreign)
                .is_err()
        );
        struct Forged;
        impl ExecutionCustody for Forged {
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }
        }
        assert!(root.session_for_execution(&Forged, &invocation).is_err());
        let other_directory = tempfile::tempdir().unwrap();
        let other = RootStore::open(Arc::new(
            RootOwner::create(
                &other_directory.path().join("root"),
                &RootNamespaces {
                    ownership: other_directory.path().join("owners"),
                    control: other_directory.path().join("control"),
                },
            )
            .unwrap(),
        ))
        .await
        .unwrap();
        assert!(
            other
                .session_for_execution(custody.as_ref(), &invocation)
                .is_err()
        );
        other.close().await.unwrap();
        let child = root.fork_execution(custody.as_ref(), &invocation).unwrap();
        let child_store = child.store();
        lease.finish();
        assert!(
            root.session_for_execution(custody.as_ref(), &invocation)
                .is_err()
        );
        assert!(recovered.get::<Value>().await.is_err());
        assert!(poll!(&mut writer).is_pending());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), child_store.get::<Value>())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .id,
            "session"
        );
        let child_token = child_store.execution_custody().unwrap();
        assert!(
            root.session_for_execution(child_token.as_ref(), &invocation)
                .is_ok()
        );
        child.finish();
        assert!(
            root.session_for_execution(child_token.as_ref(), &invocation)
                .is_err()
        );
        drop(
            tokio::time::timeout(Duration::from_secs(2), writer)
                .await
                .unwrap()
                .unwrap(),
        );
        root.close().await.unwrap();
    }
}
