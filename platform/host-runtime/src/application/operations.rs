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

//! Explicitly composed, independently authorized original receipt queries.
use super::*;
use maka_plugin_core::operation::receipt_reader_contract;
use serde::Deserialize;

/// Available to persisted Host compositions; this does not activate a reader.
pub const RECEIPT_READER: &str = "maka.operations.receipts";

struct Reader;
impl Handler for Reader {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let result = async move {
            if method != "read" {
                return Err("unknown original receipt method".into());
            }
            let reference: RecoveryRef =
                serde_json::from_value(input).map_err(|e| e.to_string())?;
            reference.validate().map_err(|e| e.to_string())?;
            // Context preserves this owner, reader activation, private Scope and
            // actual SQL child resource. No current business binding is resolved.
            let observation = match context.recover(reference.clone()) {
                Ok(result) => result.await,
                Err(error) => Err(error),
            };
            receipt_value(receipt_reply(reference, observation))
        };
        Box::pin(async move {
            let result: std::result::Result<Value, String> = result.await;
            result.map(HandlerValue::Json).map_err(HandlerError::from)
        })
    }
}
impl NativeOwner for Reader {
    fn prepare_retirement(&self) -> Option<Box<dyn crate::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        // No activation-owned native resource. Request SQL remains in its
        // independent owner and is settled through Context's parent ticket.
        Box::pin(async { Ok(()) })
    }
}

pub(super) fn provide(native: &mut NativeRegistry) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Configuration {}
    native.insert(
        RECEIPT_READER.into(),
        Arc::new(|_, configuration| {
            Box::pin(async move {
                let exports = serde_json::from_value::<Configuration>(configuration)
                    .map_err(|e| e.to_string())
                    .map(|_| {
                        BTreeMap::from([(
                            "Receipts".into(),
                            Published {
                                contract: receipt_reader_contract(),
                                value: Arc::new(Reader) as Arc<dyn Handler>,
                            },
                        )])
                    });
                NativeActivation {
                    exports,
                    owner: Arc::new(Reader),
                }
            })
        }),
    )
}

pub(super) fn receipt_reply(
    reference: RecoveryRef,
    observation: Result<Option<OperationObservation>>,
) -> OperationReply {
    let receipt = match observation {
        Ok(Some(observation)) => Receipt::Recorded {
            outcome: observation.outcome,
            cleanup: observation.cleanup,
        },
        Ok(None) => Receipt::NotRecorded,
        Err(error) => Receipt::Unavailable {
            diagnostic: owner::diagnostic(&error),
        },
    };
    OperationReply { reference, receipt }
}

// Delivery failure must never replace the original journal's durable outcome.
pub(super) fn receipt_value(mut reply: OperationReply) -> Result<Value> {
    let value = serde_json::to_value(&reply).map_err(|e| e.to_string())?;
    if maka_plugin_core::json::exact_numbers(&value).is_ok() {
        return Ok(value);
    }
    reply.receipt = Receipt::Unavailable { diagnostic: "original receipt cannot be represented by this observer; read original journal through a compatible observer".into() };
    let value = serde_json::to_value(reply).map_err(|e| e.to_string())?;
    maka_plugin_core::json::exact_numbers(&value)?;
    Ok(value)
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        RECEIPT_READER,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [(
            "Receipts",
            maka_plugin_core::operation::receipt_reader_contract(),
        )],
    )
}
