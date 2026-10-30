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

use crate::{
    SessionStore, StoreError,
    native_approvals::{
        ClaimedNativeApproval, NativeApprovalCheckpoint, ParkResult, ParkedActivationReceipt,
    },
};
use maka_agent_facts::{
    event::{Invocation, StoredEvent},
    native_approval::{ActivationCheckpoint, DispatchReceipt, NativeApprovalPending},
    tools::ToolCallContext,
};
impl SessionStore {
    pub async fn park_native_approvals(
        &self,
        c: ActivationCheckpoint,
        p: Vec<NativeApprovalPending>,
    ) -> Result<ParkResult, StoreError> {
        self.check_session(&c.invocation.session_id)?;
        self.scoped().await?.park_native_approvals(c, p).await
    }
    pub async fn confirm_native_approval_park(
        &self,
        c: &ActivationCheckpoint,
        p: &[NativeApprovalPending],
    ) -> Result<Option<ParkedActivationReceipt>, StoreError> {
        self.check_session(&c.invocation.session_id)?;
        self.scoped()
            .await?
            .confirm_native_approval_park(c, p)
            .await
    }
    pub async fn native_approval_checkpoint(
        &self,
        s: &str,
    ) -> Result<Option<NativeApprovalCheckpoint>, StoreError> {
        self.check_session(s)?;
        self.scoped().await?.native_approval_checkpoint(s).await
    }
    pub async fn claim_native_approvals(
        &self,
        r: &ParkedActivationReceipt,
        c: &str,
        e: &str,
    ) -> Result<Vec<ClaimedNativeApproval>, StoreError> {
        self.check_session(&r.invocation().session_id)?;
        self.scoped().await?.claim_native_approvals(r, c, e).await
    }
    pub async fn start_native_approval(
        &self,
        r: &ParkedActivationReceipt,
        o: &str,
        c: &str,
        s: &str,
    ) -> Result<bool, StoreError> {
        self.check_session(&r.invocation().session_id)?;
        self.scoped().await?.start_native_approval(r, o, c, s).await
    }
    pub async fn native_approvals_settled(
        &self,
        r: &ParkedActivationReceipt,
    ) -> Result<bool, StoreError> {
        self.check_session(&r.invocation().session_id)?;
        self.scoped().await?.native_approvals_settled(r).await
    }
    pub async fn repark_native_approvals(
        &self,
        r: &ParkedActivationReceipt,
        c: ActivationCheckpoint,
        pending: Vec<NativeApprovalPending>,
    ) -> Result<ParkResult, StoreError> {
        self.check_session(&c.invocation.session_id)?;
        self.scoped()
            .await?
            .repark_native_approvals(r, c, pending)
            .await
    }
    pub async fn stop_native_approvals(&self, i: &Invocation, n: u64) -> Result<bool, StoreError> {
        self.check_session(&i.session_id)?;
        self.scoped().await?.stop_native_approvals(i, n).await
    }
    pub async fn native_approval_dispatch(
        &self,
        p: &NativeApprovalPending,
    ) -> Result<StoredEvent, StoreError> {
        self.check_session(&p.invocation.session_id)?;
        self.scoped().await?.native_approval_dispatch(p).await
    }
    pub async fn tool_dispatch_receipt(
        &self,
        c: &ToolCallContext,
        n: &str,
        i: &serde_json::Value,
    ) -> Result<DispatchReceipt, StoreError> {
        self.check_session(&c.invocation.session_id)?;
        self.scoped().await?.tool_dispatch_receipt(c, n, i).await
    }
}

impl SessionStore {
    pub async fn release_native_approval_claim(
        &self,
        receipt: &ParkedActivationReceipt,
        operation: &str,
        claim: &str,
        host_epoch: &str,
    ) -> Result<bool, StoreError> {
        self.check_session(&receipt.invocation().session_id)?;
        self.scoped()
            .await?
            .release_native_approval_claim(receipt, operation, claim, host_epoch)
            .await
    }
}
