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

impl Driver<'_> {
    pub(super) async fn event(
        &mut self,
        connection: &mut Connection,
        event: Event,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<(), Error> {
        if !event.is_callback() {
            return self.observe(connection, event).await;
        }
        let Some(root) = self.session() else {
            event.reject()?;
            return Ok(());
        };
        let session = match &event {
            Event::V2Permission(input, _) if connection.children.contains(&input.session_id) => {
                input.session_id.0.as_ref()
            }
            _ => root,
        }
        .to_owned();
        // The callback borrows admitted capabilities, not Driver. Keep consuming
        // ordered observations while the Host form awaits the user's answer.
        let context = executor::Context {
            cancellation: self.context.cancellation.child_token(),
            output: self.context.output.clone(),
            call: self.context.call.clone(),
        };
        let handling = callback(event, &session, self.request, &context, self.host);
        tokio::pin!(handling);
        loop {
            tokio::select! {
                biased;
                result = &mut handling => return result,
                _ = super::wait_deadline(deadline) => {
                    context.cancellation.cancel();
                    handling.await?;
                    return Err(Error::Timeout);
                }
                event = connection.events.recv() => {
                    let result = match event {
                        Some(event) if event.is_callback() => event.reject_busy().map_err(Error::from),
                        Some(event) => self.observe(connection, event).await,
                        None => Err(Error::Invalid("ACP event stream ended")),
                    };
                    if let Err(error) = result {
                        context.cancellation.cancel();
                        handling.await?;
                        return Err(error);
                    }
                }
                result = &mut connection.run => {
                    context.cancellation.cancel();
                    // An already-committed Host offer must settle before drop.
                    handling.await?;
                    result?;
                    return Err(Error::Invalid("ACP connection ended"));
                }
            }
        }
    }

    async fn observe(&mut self, connection: &mut Connection, event: Event) -> Result<(), Error> {
        match event {
            Event::Stderr(_) => {}
            Event::Initialized(_) => return Err(Error::Invalid("duplicate ACP initialization")),
            Event::V1Update(update) => {
                if self.replay {
                    if Some(update.session_id.to_string()).as_deref() != self.session() {
                        return Err(Error::Invalid("replayed update belongs to another session"));
                    }
                } else {
                    self.projection
                        .as_mut()
                        .ok_or(Error::Invalid(
                            "session update before session establishment",
                        ))?
                        .update(*update, self.context.output.as_ref())
                        .await?;
                }
            }
            Event::V2Update(update) => {
                let projection = self.v2.as_mut().ok_or(Error::Invalid(
                    "session update before session establishment",
                ))?;
                if root_update(&projection.session_id, &mut connection.children, &update)? {
                    projection
                        .update(*update, self.context.output.as_ref(), self.replay)
                        .await?;
                }
            }
            _ => return Err(Error::Invalid("unexpected callback in ACP observation")),
        }
        Ok(())
    }
}

use sdk::v2::schema::{SessionId, SessionUpdate, UpdateSessionNotification};
use std::collections::HashSet;

// Child updates arrive on the same connection but do not drive the root turn.
fn root_update(
    root: &str,
    children: &mut HashSet<SessionId>,
    event: &UpdateSessionNotification,
) -> Result<bool, Error> {
    let is_root = event.session_id.0.as_ref() == root;
    if !is_root && !children.contains(&event.session_id) {
        return Err(Error::Invalid("ACP update belongs to another session"));
    }
    if let SessionUpdate::SubagentUpdate(child) = &event.update {
        children.insert(child.session_id.clone());
    }
    Ok(is_root)
}

async fn callback(
    event: Event,
    session: &str,
    request: &executor::Request,
    context: &executor::Context,
    host: &Ports,
) -> Result<(), Error> {
    let id = serde_json::Value::String(uuid::Uuid::new_v4().to_string());
    match event {
        Event::Read(input, reply) => reply.respond_with_result(
            callbacks::read_file(*input, session, context, host, &id)
                .await
                .map_err(callback_error),
        )?,
        Event::Write(input, reply) => reply.respond_with_result(
            callbacks::write_file(*input, session, context, host, &id)
                .await
                .map_err(callback_error),
        )?,
        Event::V1Permission(input, reply) => {
            let cancellation = reply.cancellation();
            reply.respond_with_result(
                permission(
                    cancellation,
                    context,
                    callbacks::permission_v1(*input, session, request, context, host, &id),
                )
                .await
                .map_err(callback_error),
            )?;
        }
        Event::V2Permission(input, reply) => {
            let cancellation = reply.cancellation();
            reply.respond_with_result(
                permission(
                    cancellation,
                    context,
                    callbacks::permission_v2(*input, session, request, context, host, &id),
                )
                .await
                .map_err(callback_error),
            )?;
        }
        _ => return Err(Error::Invalid("unexpected observation in ACP callback")),
    }
    Ok(())
}

fn callback_error(error: callbacks::CallbackError) -> sdk::Error {
    sdk::Error::new(error.code, error.message)
}

async fn permission<T>(
    cancellation: sdk::RequestCancellation,
    context: &executor::Context,
    work: impl std::future::Future<Output = Result<T, callbacks::CallbackError>>,
) -> Result<T, callbacks::CallbackError> {
    tokio::pin!(work);
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => { context.cancellation.cancel(); work.await }
        result = &mut work => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sdk::v2::schema::{IdleStateUpdate, StateUpdate, SubagentUpdate};

    #[test]
    fn only_announced_descendants_may_send_updates_outside_the_root_turn() {
        let mut children = HashSet::new();
        let mut route = |session, update| {
            root_update(
                "root",
                &mut children,
                &UpdateSessionNotification::new(session, update),
            )
        };
        let announce = |child| SessionUpdate::SubagentUpdate(SubagentUpdate::new(child));
        let idle = || SessionUpdate::StateUpdate(StateUpdate::Idle(IdleStateUpdate::new()));
        assert!(route("root", announce("child")).unwrap());
        assert!(!route("child", announce("grandchild")).unwrap());
        assert!(!route("grandchild", idle()).unwrap());
        assert!(route("stranger", idle()).is_err());
        assert!(route("root", idle()).unwrap());
    }
}
