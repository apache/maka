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

use super::*;
use crate::{ComponentCall, ComponentOutput, Emission, Frame};
use serde::de::DeserializeOwned;
use serde_json::json;

/// Pure native editing protocol shared by presentation adapters. The renderer
/// remains the sole buffer, selection and composition owner.
pub trait Props: DeserializeOwned {
    fn command(&self) -> Option<&EditorCommand>;
    fn set_command(&mut self, command: Option<EditorCommand>);
}

pub fn reduce<P: Props>(call: ComponentCall<'_>) -> crate::Result<ComponentOutput<P>> {
    let (props, revision, observation, mut request, mut pending) = match call {
        ComponentCall::Mount { props } => (props, 0, serde_json::Value::Null, None, false),
        ComponentCall::Update { state, props } => (
            props,
            state["revision"].as_u64().expect("editor UI revision") + 1,
            state["observation"].clone(),
            Option::<EditorCommand>::deserialize(&state["request"])
                .expect("editor requested command"),
            state["pending"].as_bool().expect("editor pending command"),
        ),
        ComponentCall::Event {
            state,
            props,
            input,
            ..
        } => {
            let request = Option::<EditorCommand>::deserialize(&state["request"])
                .expect("editor requested command");
            let observation: EditorObservation =
                EditorObservation::deserialize(input).expect("validated editor observation");
            let settled = request
                .as_ref()
                .zip(observation.receipt.as_ref())
                .is_some_and(|(command, receipt)| {
                    command.owner == receipt.owner && command.sequence == receipt.sequence
                });
            let typed = P::deserialize(props).map_err(|e| crate::Error::Invalid(e.to_string()))?;
            let mut output = frame(
                typed,
                state["revision"].as_u64().expect("editor UI revision") + 1,
                input.clone(),
                request,
                state["pending"].as_bool().expect("editor pending command") && !settled,
            );
            output.events.push(Emission {
                name: "changed".into(),
                value: input.clone(),
            });
            return Ok(output);
        }
    };
    let typed: P = P::deserialize(props).map_err(|e| crate::Error::Invalid(e.to_string()))?;
    if let Some(command) = typed.command()
        && request.as_ref() != Some(command)
    {
        if request
            .as_ref()
            .is_some_and(|prior| command.owner == prior.owner && command.sequence <= prior.sequence)
        {
            return Err(crate::Error::Invalid(
                "editor command sequence must advance".into(),
            ));
        }
        request = Some(command.clone());
        pending = true;
    }
    Ok(frame(typed, revision, observation, request, pending))
}

fn frame<P: Props>(
    mut typed: P,
    revision: u64,
    observation: serde_json::Value,
    request: Option<EditorCommand>,
    pending: bool,
) -> ComponentOutput<P> {
    // Props propose monotonically advancing commands. Each native outcome stays
    // in its original publication FIFO; a delayed receipt does not block the
    // next command. None does not cancel the latest accepted request.
    typed.set_command(request.clone().filter(|_| pending));
    Frame {
            revision,
            state: json!({"revision":revision,"request":request,"pending":pending,"observation":observation}),
            surface: None,
            view: typed,
        }.output(Vec::new())
}
