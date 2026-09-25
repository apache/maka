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

impl App {
    pub fn apps_transcript_mounts(&mut self) -> Vec<transport::Mount> {
        let crate::app::ConnectionState::Connected { root_id, epoch } = &self.connection else {
            self.apps.readers.mounts.clear();
            return vec![];
        };
        let (root, epoch) = (root_id.clone(), epoch.clone());
        let mut wanted = vec![];
        for (key, instance) in &self.apps.instances {
            if !self.app_visible(key)
                || instance.entry.as_ref().is_some_and(|entry| {
                    entry.descriptor.placement == maka_plugins::terminal_ui::Placement::Status
                })
            {
                continue;
            }
            let (Some(view), Some(entry)) = (&instance.view, &instance.entry) else {
                continue;
            };
            let observing = instance.live.as_ref() == Some(&entry.target)
                && !instance.blocked
                && instance.review.is_none()
                && !instance.execution.is_nil();
            let mut resources = vec![];
            resources_in(&view.root, "", &mut resources);
            for (path, resource) in resources {
                wanted.push((
                    (key.clone(), path),
                    key.route.clone(),
                    transport::Mount {
                        token: Uuid::nil(),
                        owner: instance.execution,
                        document: Uuid::nil(),
                        package: entry.package_id.clone(),
                        session: key.session.clone(),
                        parent: entry.target.clone(),
                        resource,
                        locale: self.apps.locale.clone(),
                    },
                    observing,
                ));
            }
        }
        self.apps.readers.mounts.retain(|identity, mount| {
            let Some((_, _, _, observing)) =
                wanted.iter().find(|(key, route, binding, observing)| {
                    key == identity
                        && route == &mount.route
                        && mount.root == root
                        && mount.epoch == epoch
                        && mount.binding.parent == binding.parent
                        && (!observing || mount.binding.owner == binding.owner)
                        && mount.binding.resource == binding.resource
                        && mount.binding.locale == binding.locale
                })
            else {
                return false;
            };
            if !observing {
                // Keep only the local cache. The runtime receives no mount,
                // closes its observation, and rejects every late delivery.
                mount.failed = true;
                mount.failure = Some(transport::Failure::Stopped);
                mount.pending = None;
                mount.paging = false;
                mount.cadence.flush();
            }
            true
        });
        for (identity, route, mut binding, observing) in wanted {
            if !observing {
                continue;
            }
            self.apps.readers.mounts.entry(identity).or_insert_with(|| {
                binding.token = Uuid::new_v4();
                Mounted {
                    binding,
                    root: root.clone(),
                    epoch: epoch.clone(),
                    route,
                    source: Default::default(),
                    view: Default::default(),
                    dirty: false,
                    good: false,
                    failed: false,
                    failure: None,
                    paging: false,
                    pending: None,
                    edge: None,
                    cadence: Default::default(),
                }
            });
        }
        self.apps
            .readers
            .mounts
            .values()
            .filter(|mount| !mount.failed)
            .map(|mount| mount.binding.clone())
            .collect()
    }
    pub fn apps_transcript_delivery(&mut self, delivery: transport::Delivery) -> bool {
        let Some(mount) = self
            .apps
            .readers
            .mounts
            .values_mut()
            .find(|mount| mount.binding.token == delivery.token)
        else {
            return false;
        };
        if mount.failed {
            return false;
        }
        let changed = match delivery.output {
            transport::Output::Ready { fence } => mount.source.ready(fence).map(|()| false),
            transport::Output::Page { direction, page } => {
                let done = page.continuation.is_none();
                let result = mount
                    .source
                    .page(direction, page)
                    .map(|result| result.changed || done);
                if done {
                    mount.paging = false;
                    mount.edge = Some(direction);
                    mount.cadence.flush();
                }
                result
            }
            transport::Output::Event(event) => {
                mount.cadence.arrived();
                let content = matches!(
                    &event,
                    wire::Event::Append { .. } | wire::Event::Replace { .. }
                );
                let result = mount.source.event(event, mount.view.following());
                if content && result.as_ref().is_ok_and(|changed| *changed) {
                    mount.view.new_output();
                }
                result
            }
            transport::Output::Failure(error) => {
                mount.failed = true;
                mount.failure = Some(error);
                if error == transport::Failure::Cleanup {
                    let owner = mount.binding.owner;
                    self.apps_observation_failed(owner);
                }
                return true;
            }
        };
        match changed {
            Ok(changed) => mount.dirty |= changed,
            Err(_) => mount.failed = true,
        }
        self.apps.readers.enforce_budget();
        true
    }
    pub fn apps_transcript_pages(&mut self, runner: &transport::Runner) {
        for mount in self.apps.readers.mounts.values_mut() {
            if mount.failed {
                mount.pending = None;
                continue;
            }
            if let Some((direction, cursor)) = mount.pending.take() {
                match runner.page(mount.binding.token, direction, cursor.clone()) {
                    Ok(()) => mount.paging = true,
                    Err(transport::Failure::Busy) => mount.pending = Some((direction, cursor)),
                    Err(_) => mount.failed = true,
                }
            }
        }
    }
    pub fn apps_transcript_failed(&mut self) {
        for mount in self.apps.readers.mounts.values_mut() {
            mount.failed = true;
        }
    }
    pub fn apps_transcript_notice(&mut self) -> Option<&'static str> {
        self.apps.readers.notice.take()
    }
    pub fn apps_transcript_copy(&mut self) -> Option<String> {
        self.apps.readers.copy.take()
    }
}

fn resources_in(node: &Node, parent: &str, out: &mut Vec<(String, wire::Resource)>) {
    let path = if parent.is_empty() {
        node.key().into()
    } else {
        format!("{parent}/{}", node.key())
    };
    if let Node::Transcript { resource, .. } = node {
        out.push((path.clone(), resource.clone()));
    }
    for child in node.children() {
        resources_in(child, &path, out);
    }
}
