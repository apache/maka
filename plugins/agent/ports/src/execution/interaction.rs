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

use crate::Error;
use maka_agent_facts::capability::FormField;
use maka_agent_facts::capability::FormRequester;
use maka_agent_facts::durable::ExecutionIdentity;
use maka_agent_facts::interaction::InteractionQuestion;
use maka_agent_facts::interaction::InteractionRequest;
use serde::{Deserialize, Serialize};

/// User input only. Permission decisions remain exclusively Host-owned.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Prompt {
    Question {
        questions: Vec<InteractionQuestion>,
    },
    Form {
        message: String,
        fields: Vec<FormField>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfferInteraction {
    pub operation_id: String,
    pub execution: ExecutionIdentity,
    pub prompt: Prompt,
}
impl OfferInteraction {
    /// Host supplies the authenticated package, never a plugin-selected requester.
    pub fn request(&self, package: &str) -> Result<InteractionRequest, Error> {
        crate::name(&self.operation_id)?;
        let request = match &self.prompt {
            Prompt::Question { questions } => InteractionRequest::Question {
                tool_use_id: self.operation_id.clone(),
                questions: questions.clone(),
            },
            Prompt::Form { message, fields } => InteractionRequest::Form {
                tool_use_id: self.operation_id.clone(),
                message: message.clone(),
                requester: FormRequester {
                    name: package.into(),
                    source: None,
                },
                fields: fields.clone(),
            },
        };
        request
            .validate()
            .map_err(|error| Error::Invalid(error.into()))?;
        Ok(request)
    }
}

/// Native-issued access to one admitted Run. Identity is only an observation;
/// implementations check current authority and the Stop frontier on publication.
/// Outcome commits remain permitted after termination for original late facts.
pub trait Interactions: Send + Sync {
    fn execution(&self) -> &ExecutionIdentity;
    fn changes(&self) -> Result<tokio::sync::watch::Receiver<()>, String>;
    fn read<'a>(
        &'a self,
        request_id: &'a str,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<Option<maka_agent_facts::interaction::InteractionRecord>, String>,
    >;
    /// Exact repetition returns the canonical record; conflicting requests fail.
    fn establish<'a>(
        &'a self,
        record: &'a maka_agent_facts::interaction::InteractionRecord,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<maka_agent_facts::interaction::InteractionRecord, String>,
    >;
    /// First-writer settlement returns the winner, never overwrites an answer.
    fn commit_outcome<'a>(
        &'a self,
        request_id: &'a str,
        outcome: maka_agent_facts::interaction::InteractionOutcome,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<maka_agent_facts::interaction::InteractionRecord, String>,
    >;
}
