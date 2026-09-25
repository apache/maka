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

use super::{Registration, validate_callback};
use crate::plugins::javascript::{callbacks, invocation, presenter, remote};
use maka_js_runtime::plugin::Module;
use maka_plugins::{
    contributions::Staged,
    fiber::Context,
    remote::{Endpoint, Handler},
    terminal_ui::{
        presenter::{Observation as Member, ObservationRole},
        transcript::Resource,
    },
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(tag = "role", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::plugins::javascript) enum Observation {
    TranscriptRead { resource: Resource },
    TranscriptStream { resource: Resource },
}
impl Observation {
    fn validate(self, name: &str, stream: bool) -> Result<ObservationRole, String> {
        let (resource, read) = match self {
            Self::TranscriptRead { resource } => (resource, true),
            Self::TranscriptStream { resource } => (resource, false),
        };
        resource.validate().map_err(super::super::message)?;
        if read == stream
            || name
                != if read {
                    &resource.read
                } else {
                    &resource.stream
                }
        {
            return Err(
                "Transcript contribution role or method does not match its resource".into(),
            );
        }
        Ok(if read {
            ObservationRole::TranscriptRead(resource)
        } else {
            ObservationRole::TranscriptStream(resource)
        })
    }
}

pub(super) fn stage(
    registrations: &mut Vec<Registration>,
    module: &Module,
    calls: &Arc<invocation::Calls>,
    source: &remote::Source,
    lifecycle: &Context,
    staged: &mut Staged,
) -> Result<(), String> {
    let identity = lifecycle.identity().map_err(super::super::message)?;
    let mut endpoints = BTreeMap::new();
    let mut apps = Vec::new();
    for registration in std::mem::take(registrations) {
        let stream = matches!(&registration, Registration::RemoteStream { .. });
        match registration {
            Registration::RemoteMethod {
                name,
                callback,
                access,
                terminal_view,
                observation,
            }
            | Registration::RemoteStream {
                name,
                callback,
                access,
                terminal_view,
                observation,
            } => {
                validate_callback(callback)?;
                let handler = Arc::new(remote::Remote(Arc::new(callbacks::Callback {
                    module: module.clone(),
                    id: callback,
                    calls: calls.clone(),
                })));
                let handler = if stream {
                    Handler::Stream(handler)
                } else {
                    Handler::Method(handler)
                };
                let mut endpoint = Endpoint::new(source.package.digest().into(), handler);
                endpoint.access = access;
                endpoint.observation = observation
                    .map(|value| value.validate(&name, stream))
                    .transpose()?;
                if terminal_view.is_some() {
                    return Err(
                        "JavaScript terminal metadata requires ctx.tui.app with an isolated entry"
                            .into(),
                    );
                }
                if endpoints.insert(name, endpoint).is_some() {
                    return Err("duplicate Remote contribution".into());
                }
            }
            app @ Registration::TerminalApp { .. } => apps.push(app),
            other => registrations.push(other),
        }
    }
    let app_names: BTreeSet<_> = apps
        .iter()
        .map(|app| match app {
            Registration::TerminalApp { name, .. } => name.clone(),
            _ => unreachable!(),
        })
        .collect();
    if app_names.len() != apps.len() || app_names.iter().any(|name| endpoints.contains_key(name)) {
        return Err("duplicate terminal app contribution".into());
    }
    // Capture from the same publication first; existing contributions must still
    // be effective and owned by this exact activation. No deferred name lookup.
    let current = source.catalog.snapshot::<Endpoint>(&identity.scope);
    for app in apps {
        let Registration::TerminalApp {
            name,
            callback,
            entry,
            resources,
            access,
            terminal_view,
        } = app
        else {
            unreachable!()
        };
        validate_callback(callback)?;
        terminal_view.validate().map_err(super::super::message)?;
        let mut members = Vec::new();
        let mut methods = BTreeSet::new();
        let mut ids = BTreeSet::new();
        let mut capture = |method: &str, role: ObservationRole| -> Result<(), String> {
            if !methods.insert(method.to_owned()) || app_names.contains(method) {
                return Err("terminal observation methods must have one source role".into());
            }
            let key = maka_plugins::remote::key(&identity.package_id, method)
                .map_err(super::super::message)?;
            let endpoint = match endpoints.get(method) {
                Some(endpoint) => endpoint,
                None => {
                    let item = current
                        .entries
                        .get(&key)
                        .filter(|item| {
                            item.is_effective()
                                && item.owner.identity().is_ok_and(|owner| owner == identity)
                        })
                        .ok_or("terminal observation source is not effective in this activation")?;
                    &item.value
                }
            };
            let expected_stream = !matches!(role, ObservationRole::TranscriptRead(_));
            if matches!(endpoint.handler, Handler::Stream(_)) != expected_stream
                || endpoint.terminal_view().is_some()
                || match &role {
                    ObservationRole::ChangesStream => endpoint.observation.is_some(),
                    _ => endpoint.observation.as_ref() != Some(&role),
                }
            {
                return Err("terminal observation source kind or resource does not match".into());
            }
            members.push(Member {
                method: method.into(),
                target: endpoint.target(&identity),
                role,
            });
            Ok(())
        };
        if let Some(changes) = &terminal_view.changes {
            capture(changes, ObservationRole::ChangesStream)?;
        }
        for resource in resources {
            resource.validate().map_err(super::super::message)?;
            if !ids.insert(resource.id.clone()) {
                return Err("duplicate terminal resource identity".into());
            }
            capture(
                &resource.read,
                ObservationRole::TranscriptRead(resource.clone()),
            )?;
            capture(
                &resource.stream,
                ObservationRole::TranscriptStream(resource.clone()),
            )?;
        }
        let backend = Arc::new(remote::Remote(Arc::new(callbacks::Callback {
            module: module.clone(),
            id: callback,
            calls: calls.clone(),
        })));
        let factory = Arc::new(
            presenter::Factory::new(
                &source.package,
                &entry,
                source.presenter_limits.clone(),
                backend,
                lifecycle.stopping().map_err(super::super::message)?,
                members,
            )
            .map_err(super::super::message)?,
        );
        let mut endpoint = Endpoint::new(
            source.package.digest().into(),
            Handler::Method(Arc::new(presenter::Endpoint(factory))),
        );
        endpoint.access = access;
        endpoints.insert(
            name,
            endpoint
                .with_terminal_view(terminal_view)
                .map_err(super::super::message)?,
        );
    }
    for (name, endpoint) in endpoints {
        staged
            .insert(
                maka_plugins::remote::key(&identity.package_id, &name)
                    .map_err(super::super::message)?,
                endpoint,
            )
            .map_err(super::super::message)?;
    }
    Ok(())
}
