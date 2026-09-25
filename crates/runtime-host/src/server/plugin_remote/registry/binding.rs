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

use super::{failure, page};
use maka_plugins::{
    remote::{ClientIdentity, Error, Target},
    terminal_ui::{
        presenter::{Factory, Observation, ObservationRole},
        transcript,
    },
};
use maka_protocol::{
    OperationError, OperationErrorCode,
    plugin::{RemoteBinding, RemoteKind},
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Identity {
    target: Target,
    package: String,
    method: String,
    session: Option<String>,
    client: Option<ClientIdentity>,
    stream: bool,
}
impl Identity {
    pub fn new(binding: &RemoteBinding, target: &Target, kind: RemoteKind) -> Self {
        Self {
            target: target.clone(),
            package: binding.package_id().into(),
            method: binding.method().into(),
            session: binding.session_id().map(str::to_owned),
            client: match binding {
                RemoteBinding::Client { client, .. } => Some(client.clone()),
                RemoteBinding::Package { .. } => None,
            },
            stream: matches!(kind, RemoteKind::Stream),
        }
    }
    fn same_scope(&self, other: &Self) -> bool {
        self.package == other.package
            && self.session == other.session
            && self.client == other.client
            && self.target.entry_id == other.target.entry_id
            && self.target.activation == other.target.activation
    }
}

impl Identity {
    fn check(
        &self,
        binding: &RemoteBinding,
        target: &Target,
        kind: RemoteKind,
        input: &Value,
        members: &[Observation],
    ) -> Result<bool, OperationError> {
        let candidate = Identity::new(binding, target, kind);
        if self == &candidate {
            return Ok(true);
        }
        if self.same_scope(&candidate)
            && let Some(member) = members
                .iter()
                .find(|member| member.method == binding.method() && member.target == *target)
        {
            validate_input(&member.role, kind, input)?;
            return Ok(false);
        }
        Err(conflict())
    }
}

#[derive(Clone)]
pub(super) struct Binding {
    pub identity: Identity,
    pub page: Arc<page::Handle>,
    pub _factory: Arc<dyn Factory>,
    pub observations: Arc<[Observation]>,
}
impl Binding {
    pub fn check(
        &self,
        binding: &RemoteBinding,
        target: &Target,
        kind: RemoteKind,
        input: &Value,
    ) -> Result<bool, OperationError> {
        self.identity
            .check(binding, target, kind, input, &self.observations)
    }

    pub fn cancel(&self) {
        self.page.cancel();
    }
}
pub(super) fn capture(
    factory: &dyn Factory,
    target: &Target,
) -> Result<Arc<[Observation]>, OperationError> {
    let members = factory.observations();
    for (index, member) in members.iter().enumerate() {
        maka_plugins::identifier(&member.method)
            .map_err(|error| failure(Error::Invalid(error.to_string())))?;
        if member.target.entry_id != target.entry_id
            || member.target.activation != target.activation
            || members[..index]
                .iter()
                .any(|previous| previous.method == member.method)
            || member.target == *target
        {
            return Err(conflict());
        }
        let (resource, method) = match &member.role {
            ObservationRole::ChangesStream => continue,
            ObservationRole::TranscriptRead(resource) => (resource, &resource.read),
            ObservationRole::TranscriptStream(resource) => (resource, &resource.stream),
        };
        resource
            .validate()
            .map_err(|error| failure(Error::Invalid(error.to_string())))?;
        if method != &member.method {
            return Err(conflict());
        }
    }
    Ok(members.to_vec().into())
}
fn validate_input(
    role: &ObservationRole,
    kind: RemoteKind,
    input: &Value,
) -> Result<(), OperationError> {
    let invalid = |error: String| failure(Error::Invalid(error));
    match (role, kind) {
        (ObservationRole::ChangesStream, RemoteKind::Stream) if input.is_null() => Ok(()),
        (ObservationRole::TranscriptRead(resource), RemoteKind::Method) => {
            let read: transcript::Read = serde_json::from_value(input.clone())
                .map_err(|error| invalid(error.to_string()))?;
            read.validate()
                .map_err(|error| invalid(error.to_string()))?;
            if read.resource != resource.id {
                return Err(conflict());
            }
            Ok(())
        }
        (ObservationRole::TranscriptStream(resource), RemoteKind::Stream) => {
            let open: transcript::Open = serde_json::from_value(input.clone())
                .map_err(|error| invalid(error.to_string()))?;
            open.validate()
                .map_err(|error| invalid(error.to_string()))?;
            if open.resource != resource.id {
                return Err(conflict());
            }
            Ok(())
        }
        _ => Err(invalid(
            "Remote request does not match its terminal observation role".into(),
        )),
    }
}
pub(super) fn conflict() -> OperationError {
    OperationError {
        code: OperationErrorCode::OperationConflict,
        message: "Remote document belongs to another terminal page binding".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn members_preserve_package_session_client_and_exact_registration() {
        let client = ClientIdentity {
            entry_id: "frontend".into(),
            extension_id: "example.pages".into(),
            activation: Uuid::new_v4().to_string(),
            content_digest: "a".repeat(64),
            client_digest: "b".repeat(64),
        };
        let root = RemoteBinding::Client {
            client: client.clone(),
            method: "page".into(),
            session_id: Some("session".into()),
        };
        let target = Target {
            entry_id: "backend".into(),
            activation: Uuid::new_v4().to_string(),
            registration: Uuid::new_v4(),
        };
        let identity = Identity::new(&root, &target, RemoteKind::Method);
        let mut source = target.clone();
        source.registration = Uuid::new_v4();
        let members = [Observation {
            method: "changed".into(),
            target: source.clone(),
            role: ObservationRole::ChangesStream,
        }];
        let binding = RemoteBinding::Client {
            client: client.clone(),
            method: "changed".into(),
            session_id: Some("session".into()),
        };
        let check = |binding: &RemoteBinding, target: &Target| {
            identity.check(binding, target, RemoteKind::Stream, &Value::Null, &members)
        };
        assert!(!check(&binding, &source).unwrap());
        assert!(
            identity
                .check(&root, &target, RemoteKind::Method, &Value::Null, &members)
                .unwrap()
        );
        for field in ["entry", "activation", "registration"] {
            let mut changed = source.clone();
            match field {
                "entry" => changed.entry_id.push('x'),
                "activation" => changed.activation.push('x'),
                _ => changed.registration = Uuid::new_v4(),
            }
            assert!(check(&binding, &changed).is_err());
        }
        for field in [
            "entryId",
            "extensionId",
            "activation",
            "contentDigest",
            "clientDigest",
            "method",
            "sessionId",
        ] {
            let mut changed = serde_json::to_value(&binding).unwrap();
            if matches!(field, "method" | "sessionId") {
                changed[field] = Value::String("different".into());
            } else {
                changed["client"][field] = Value::String("different".into());
            }
            assert!(
                check(&serde_json::from_value(changed).unwrap(), &source).is_err(),
                "{field}"
            );
        }
        let package = RemoteBinding::Package {
            package_id: "example.pages".into(),
            method: "changed".into(),
            session_id: Some("session".into()),
        };
        assert!(check(&package, &source).is_err());
        let another_request = Identity::new(&root, &target, RemoteKind::Method);
        assert!(
            identity == another_request,
            "concurrent calls share an exact reservation identity"
        );
        assert!(identity != Identity::new(&root, &target, RemoteKind::Stream));
    }
}
