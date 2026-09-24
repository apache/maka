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

use crate::{Client, ClientError, RequestFailure};
use maka_protocol::{Operation, turn::*};

/// A single queued start whose receipt can outlive the caller's response deadline.
/// Keep and poll the same `settle` future after a timeout; never submit a replacement start.
#[must_use = "Retain and settle the receipt to observe the queued turn's outcome"]
pub struct PendingTurn {
    client: Client,
    input: TurnStartInput,
    receipt: crate::connection::PendingRequest,
}

impl PendingTurn {
    /// Wait without a reply timeout. A Host disconnect remains an unknown outcome.
    /// To impose a response deadline without losing a late receipt, pin this
    /// future and pass `&mut` to `tokio::time::timeout`, then await it again.
    pub async fn settle(self) -> Result<TurnStartResult, RequestFailure> {
        let output = self.receipt.settle().await?;
        self.client.start_receipt(&self.input, &output)
    }
}

impl Client {
    pub async fn query_resume(
        &self,
        input: TurnResumeQueryInput,
    ) -> Result<TurnResumePlan, RequestFailure> {
        let value = self
            .request(
                Operation::TurnResumeQuery,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        if let Ok(plan) = decode_turn_resume_plan(&value)
            && assert_resume_query_output_for_input(&input, &plan).is_ok()
        {
            return Ok(plan);
        }
        self.disconnect();
        Err(RequestFailure::Unknown(ClientError::Protocol(
            "Resume query changed source identity".into(),
        )))
    }

    /// Start with a caller-persisted Turn identity; an unknown reply is never retried here.
    pub async fn start_resume(
        &self,
        input: TurnResumeStartInput,
    ) -> Result<TurnResumeStartResult, RequestFailure> {
        let value = self
            .request(
                Operation::TurnResumeStart,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        if let Ok(result) = decode_turn_resume_start_result(&value)
            && assert_resume_start_output_for_input(&input, &result).is_ok()
        {
            return Ok(result);
        }
        self.disconnect();
        Err(RequestFailure::Unknown(ClientError::Protocol(
            "Resume start changed Turn identity".into(),
        )))
    }

    /// Start once with the caller's stable identity; unknown outcomes are not retried.
    pub async fn start_turn(
        &self,
        input: TurnStartInput,
    ) -> Result<TurnStartResult, RequestFailure> {
        let output = self
            .request(
                Operation::TurnStart,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        self.start_receipt(&input, &output)
    }

    /// Enqueue one start within the normal admission deadline, retaining its
    /// receipt until the caller settles it or drops the returned handle.
    pub async fn start_turn_pending(
        &self,
        input: TurnStartInput,
    ) -> Result<PendingTurn, RequestFailure> {
        let receipt = self
            .request_pending(
                Operation::TurnStart,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        Ok(PendingTurn {
            client: self.clone(),
            input,
            receipt,
        })
    }

    fn start_receipt(
        &self,
        input: &TurnStartInput,
        output: &serde_json::Value,
    ) -> Result<TurnStartResult, RequestFailure> {
        if let Ok(output) = decode_turn_start_result(output)
            && assert_start_output_for_input(input, &output).is_ok()
        {
            return Ok(output);
        }
        self.disconnect();
        Err(RequestFailure::Unknown(ClientError::Protocol(
            "Start receipt does not match the requested Turn".into(),
        )))
    }

    /// Submit a frozen batch once. Unknown outcomes require an explicit query;
    /// this method never retries or allocates another Turn identity.
    pub async fn start_turn_batch(
        &self,
        input: TurnBatchStartInput,
    ) -> Result<TurnStartResult, RequestFailure> {
        let output = self
            .request(
                Operation::TurnBatchStart,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        if let Ok(output) = decode_turn_start_result(&output)
            && assert_batch_start_output_for_input(&input, &output).is_ok()
        {
            return Ok(output);
        }
        self.disconnect();
        Err(RequestFailure::Unknown(ClientError::Protocol(
            "Batch receipt does not match the requested Turn".into(),
        )))
    }

    /// NotFound is not proof of non-delivery and must not trigger automatic replay.
    pub async fn query_turn(&self, input: TurnQueryInput) -> Result<TurnSnapshot, RequestFailure> {
        let output = self
            .request(
                Operation::TurnQuery,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        if let Ok(output) = decode_turn_snapshot(&output)
            && output.session_id == input.session_id
            && output.turn_id == input.turn_id
        {
            return Ok(output);
        }
        self.disconnect();
        Err(RequestFailure::Unknown(ClientError::Protocol(
            "Turn query returned another Turn".into(),
        )))
    }
}
