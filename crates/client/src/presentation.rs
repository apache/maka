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
use maka_protocol::{Outcome, capability, oauth};
use serde_json::{Value, json};
use std::future::pending;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// One presentation service per connection. Keep its receiver alive for that
/// connection's lifetime, just like the main notification receiver. Dropping it
/// disconnects rather than leaving an advertised service without a consumer.
pub struct OAuthPresentationService {
    pub registration_id: String,
    requests: mpsc::Receiver<OAuthPresentation>,
}

impl OAuthPresentationService {
    pub async fn recv(&mut self) -> Option<OAuthPresentation> {
        while let Some(request) = self.requests.recv().await {
            if !request.is_cancelled() {
                return Some(request);
            }
        }
        None
    }
}

/// An admitted display request, never an instruction to run a shell or an
/// assertion that login succeeded. Do not persist the URL or short code.
pub struct OAuthPresentation {
    pub url: String,
    pub state_hint: Option<String>,
    cancelled: CancellationToken,
    presented: oneshot::Sender<()>,
}

impl OAuthPresentation {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.is_cancelled()
    }

    pub async fn cancelled(&self) {
        self.cancelled.cancelled().await;
    }

    /// Call only after the interface has actually shown the request. True means
    /// queued locally, not Host acknowledgement or successful authentication.
    /// Dropping the request without calling this reports presentation failure.
    pub fn acknowledge_presented(self) -> bool {
        !self.cancelled.is_cancelled() && self.presented.send(()).is_ok()
    }
}

impl Client {
    pub async fn publish_oauth_presentation(
        &self,
    ) -> Result<OAuthPresentationService, RequestFailure> {
        let registration_id = uuid::Uuid::new_v4().to_string();
        let (sender, requests) = mpsc::channel(1);
        self.request_presentation(
            json!({"registrationId":registration_id,"offers":[],"services":[{
                "serviceId":oauth::PRESENTATION_SERVICE_ID,
                "version":oauth::PRESENTATION_SERVICE_VERSION
            }]}),
            sender,
        )
        .await?;
        Ok(OAuthPresentationService {
            registration_id,
            requests,
        })
    }
}

struct Registration {
    id: String,
    sender: mpsc::Sender<OAuthPresentation>,
}

struct Invocation {
    id: String,
    cancelled: CancellationToken,
    stage: Stage,
}

enum Stage {
    Accepted {
        url: String,
        state_hint: Option<String>,
    },
    Presenting(oneshot::Receiver<()>),
    Finished,
}

/// Host admits at most one OAuth login per Root. No general tool execution or
/// unbounded invocation registry is needed for this presentation-only service.
#[derive(Default)]
pub(crate) struct Presentation {
    registration: Option<Registration>,
    invocation: Option<Invocation>,
}

impl Drop for Presentation {
    fn drop(&mut self) {
        if let Some(invocation) = &self.invocation {
            invocation.cancelled.cancel();
        }
    }
}

impl Presentation {
    pub fn prepare(
        &mut self,
        input: &Value,
        sender: mpsc::Sender<OAuthPresentation>,
    ) -> Result<String, ClientError> {
        if self.registration.is_some() {
            return Err(invalid("OAuth presentation already registered"));
        }
        let manifest = capability::decode_replace_input(input).map_err(invalid)?;
        let id = manifest.registration_id;
        self.registration = Some(Registration {
            id: id.clone(),
            sender,
        });
        Ok(id)
    }

    pub fn complete(&mut self, id: &str, outcome: &Outcome) -> Result<(), ClientError> {
        match outcome {
            Outcome::Success { result } => {
                let result = capability::decode_registration_result(result).map_err(invalid)?;
                if result.registration_id != id {
                    return Err(invalid("OAuth registration response changed identity"));
                }
            }
            Outcome::Failure { .. } => {
                if self.invocation.is_some() {
                    return Err(invalid("Rejected registration already invoked"));
                }
                if self
                    .registration
                    .as_ref()
                    .is_some_and(|registration| registration.id == id)
                {
                    self.registration = None;
                }
            }
        }
        Ok(())
    }

    pub fn consumer(&self) -> Option<mpsc::Sender<OAuthPresentation>> {
        self.registration
            .as_ref()
            .map(|registration| registration.sender.clone())
    }

    /// A control frame not yet handed to the writer belongs only to the
    /// still-live invocation that produced it. Cancellation never retargets it.
    pub fn current_control(&self, frame: &Value) -> bool {
        self.invocation.as_ref().is_some_and(|invocation| {
            frame.get("invocationId").and_then(Value::as_str) == Some(invocation.id.as_str())
                && !invocation.cancelled.is_cancelled()
        })
    }

    pub async fn completion(&mut self) -> Value {
        let Some(Invocation {
            id,
            stage: Stage::Presenting(receiver),
            ..
        }) = &mut self.invocation
        else {
            return pending().await;
        };
        let shown = receiver.await.is_ok();
        let value = if shown {
            json!({"kind":"client.capability.result","invocationId":id,
                "result":{"content":[],"structuredContent":{"kind":"presented"}}})
        } else {
            failed(id)
        };
        self.invocation.as_mut().expect("active presentation").stage = Stage::Finished;
        value
    }

    pub fn frame(&mut self, value: &Value) -> Result<Option<Value>, ClientError> {
        use capability::HostFrame;
        let frame = capability::decode_host_frame(value).map_err(invalid)?;
        match frame {
            HostFrame::ServiceCall {
                invocation_id,
                registration_id,
                service_id,
                version,
                method,
                input,
            } => {
                let registration = self
                    .registration
                    .as_ref()
                    .ok_or_else(|| invalid("Unregistered presentation call"))?;
                if registration.id != registration_id || self.invocation.is_some() {
                    return Err(invalid(
                        "Unexpected presentation registration or concurrent invocation",
                    ));
                }
                let request = (service_id == oauth::PRESENTATION_SERVICE_ID
                    && version == oauth::PRESENTATION_SERVICE_VERSION)
                    .then(|| oauth::decode_presentation(&method, &Value::Object(input)).ok())
                    .flatten();
                let request = request.and_then(
                    |oauth::PresentationRequest::OpenExternal { url, state_hint }| {
                        trusted_url(&url).map(|url| (url, state_hint))
                    },
                );
                let accepted = request.is_some();
                self.invocation = Some(Invocation {
                    id: invocation_id.clone(),
                    cancelled: CancellationToken::new(),
                    stage: request.map_or(Stage::Finished, |(url, state_hint)| Stage::Accepted {
                        url,
                        state_hint,
                    }),
                });
                Ok(Some(if accepted {
                    json!({"kind":"client.capability.accepted","invocationId":invocation_id,"admissionEvidence":{"kind":"none"}})
                } else {
                    json!({"kind":"client.capability.rejected","invocationId":invocation_id,"message":"Unsupported OAuth presentation"})
                }))
            }
            HostFrame::Admitted { invocation_id } => {
                let invocation = self.invocation_mut(&invocation_id)?;
                let Stage::Accepted { url, state_hint } =
                    std::mem::replace(&mut invocation.stage, Stage::Finished)
                else {
                    return Err(invalid("OAuth presentation admitted out of order"));
                };
                let (presented, receiver) = oneshot::channel();
                let request = OAuthPresentation {
                    url,
                    state_hint,
                    cancelled: invocation.cancelled.clone(),
                    presented,
                };
                invocation.stage = Stage::Presenting(receiver);
                let registration = self
                    .registration
                    .as_ref()
                    .ok_or_else(|| invalid("Released presentation registration"))?;
                if registration.sender.try_send(request).is_err() {
                    self.invocation.as_mut().expect("active presentation").stage = Stage::Finished;
                    return Ok(Some(failed(&invocation_id)));
                }
                Ok(None)
            }
            HostFrame::Cancel { invocation_id } => {
                let invocation = self.invocation_mut(&invocation_id)?;
                invocation.cancelled.cancel();
                invocation.stage = Stage::Finished;
                Ok(None)
            }
            HostFrame::Release { invocation_id } => {
                self.invocation_mut(&invocation_id)?.cancelled.cancel();
                self.invocation = None;
                Ok(None)
            }
            HostFrame::RegistrationRelease { registration_id } => {
                if !self
                    .registration
                    .as_ref()
                    .is_some_and(|registration| registration.id == registration_id)
                {
                    return Err(invalid("Unexpected presentation registration release"));
                }
                if let Some(invocation) = self.invocation.take() {
                    invocation.cancelled.cancel();
                }
                self.registration = None;
                Ok(None)
            }
            _ => Err(invalid("Unpublished client capability invoked")),
        }
    }

    fn invocation_mut(&mut self, id: &str) -> Result<&mut Invocation, ClientError> {
        self.invocation
            .as_mut()
            .filter(|invocation| invocation.id == id)
            .ok_or_else(|| invalid("Unexpected OAuth presentation invocation"))
    }
}

fn invalid(message: impl std::fmt::Display) -> ClientError {
    ClientError::Protocol(message.to_string())
}

fn failed(id: &str) -> Value {
    json!({"kind":"client.capability.failed","invocationId":id,"message":"OAuth presentation unavailable"})
}

fn trusted_url(value: &str) -> Option<String> {
    // Reject controls before parsing: URL parsers otherwise normalize some of
    // them away. Presentation does not implicitly open this URL in a browser.
    if value.chars().any(char::is_control) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_and_release_retire_only_their_staged_invocation_controls() {
        for retirement in [
            json!({"kind":"client.capability.cancel","invocationId":"original"}),
            json!({"kind":"client.capability.release","invocationId":"original"}),
            json!({"kind":"client.capability.registration_release","registrationId":"registration"}),
        ] {
            let mut presentation = Presentation::default();
            let (sender, _receiver) = mpsc::channel(1);
            presentation.prepare(&json!({"registrationId":"registration","offers":[],"services":[{
                "serviceId":oauth::PRESENTATION_SERVICE_ID,"version":oauth::PRESENTATION_SERVICE_VERSION
            }]}), sender).unwrap();
            let accepted = presentation.frame(&json!({"kind":"client.capability.service_call",
                "registrationId":"registration","invocationId":"original",
                "serviceId":oauth::PRESENTATION_SERVICE_ID,"version":oauth::PRESENTATION_SERVICE_VERSION,
                "method":"open_external","input":{"url":"https://login.example/device"}
            })).unwrap().unwrap();
            assert!(presentation.current_control(&accepted));
            assert!(!presentation.current_control(&json!({"invocationId":"another"})));
            assert!(presentation.frame(&retirement).unwrap().is_none());
            assert!(!presentation.current_control(&accepted));
        }
    }
}
