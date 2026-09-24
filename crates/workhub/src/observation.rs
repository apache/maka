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
    Error,
    assignment::{Assignment, Assignments, Delivery},
};
use maka_plugins::execution::{MessageState, SessionMessage};
use maka_runtime::event::Invocation;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub operation_id: String,
    pub source: Invocation,
    pub delivery: Option<Delivery>,
    pub retired: bool,
    pub control: Option<String>,
    pub result: Option<crate::results::Return>,
    pub observation: Observation,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Observation {
    Unaccepted,
    Current { state: MessageState },
    Unavailable { reason: String },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub entries: Vec<Summary>,
    pub next_after: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub operation_id: String,
    pub title: String,
    pub source: Invocation,
    pub delivery: Option<Delivery>,
    pub retired: bool,
    pub control: Option<String>,
}
impl Assignments {
    pub async fn list(&self, after: Option<String>) -> Result<Page, Error> {
        let (assignments, next_after) = self
            .repository
            .scan::<Assignment>("assignments/", after)
            .await?;
        Ok(Page {
            entries: assignments
                .into_iter()
                .map(|assignment| Summary {
                    title: match &assignment.request.target {
                        crate::assignment::Target::Create { request } => request.name.clone(),
                        crate::assignment::Target::Existing { .. } => {
                            assignment.request.content.text.chars().take(160).collect()
                        }
                    },
                    operation_id: assignment.request.operation_id,
                    source: assignment.request.source,
                    delivery: assignment.delivery,
                    retired: assignment.retired,
                    control: assignment.control,
                })
                .collect(),
            next_after,
        })
    }

    pub async fn query(
        &self,
        operation: &str,
        cursor: Option<maka_plugins::execution::AnswerCursor>,
    ) -> Result<Option<View>, Error> {
        let Some((_, assignment)) = self
            .repository
            .read::<Assignment>(&crate::assignment::key(operation)?)
            .await?
        else {
            return Ok(None);
        };
        let observation = match &assignment.delivery {
            None => Observation::Unaccepted,
            Some(delivery) => match self.observe(&assignment, delivery, cursor).await {
                Ok(state) => Observation::Current { state },
                Err(error) => Observation::Unavailable {
                    reason: error.to_string(),
                },
            },
        };
        Ok(Some(View {
            operation_id: assignment.request.operation_id,
            source: assignment.request.source,
            delivery: assignment.delivery,
            retired: assignment.retired,
            control: assignment.control,
            result: assignment.result,
            observation,
        }))
    }
    pub(super) async fn observe(
        &self,
        assignment: &Assignment,
        delivery: &Delivery,
        cursor: Option<maka_plugins::execution::AnswerCursor>,
    ) -> Result<MessageState, Error> {
        let (invocation, message_id) = match delivery {
            Delivery::Submitted { receipt } => (&receipt.invocation, &receipt.message_id),
            Delivery::Queued { receipt } => (&receipt.invocation, &receipt.message_id),
        };
        self.commands(assignment)
            .await?
            .read_message(SessionMessage {
                session_id: invocation.session_id.clone(),
                message_id: message_id.clone(),
                cursor,
            })
            .await?
            .ok_or(Error::Execution(
                maka_plugins::execution::CommandError::NotFound,
            ))
    }
}
