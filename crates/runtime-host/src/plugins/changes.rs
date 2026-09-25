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

use super::Platform;
use maka_plugins::composition::Scope;

impl Platform {
    pub(crate) async fn publish_catalog_changes(
        self,
        changes: tokio::sync::broadcast::Sender<serde_json::Value>,
        sessions: std::sync::Arc<crate::server::CatalogFeed>,
        shutdown: tokio_util::sync::CancellationToken,
    ) {
        let mut catalog = self.catalog.subscribe();
        let mut platform = self.subscribe();
        let mut previous = None;
        let mut behaviors = None;
        let mut provider_revision = None;
        let mut terminal = None;
        let mut terminal_revision = 0u64;
        let mut previous_platform = None;
        let mut platform_revision = 0u64;
        loop {
            // Consume the notification before taking snapshots so a concurrent
            // publication stays unread and triggers another pass.
            let revision = *catalog.borrow_and_update();
            let snapshot = platform.borrow_and_update().clone();
            if previous_platform
                .as_ref()
                .is_some_and(|previous| !std::sync::Arc::ptr_eq(previous, &snapshot))
            {
                if platform_revision == 9_007_199_254_740_991 {
                    shutdown.cancel();
                    break;
                }
                platform_revision += 1;
                let _ = changes.send(serde_json::json!({"kind":"plugin.platform.changed","revision":platform_revision}));
            }
            previous_platform = Some(snapshot);
            // Shells list terminal views; any change to the set, a new
            // registration of one, or its descriptor makes them list again.
            let views = self.terminal_views();
            if terminal.as_ref().is_some_and(|previous| previous != &views) {
                terminal_revision += 1;
                let _ = changes.send(serde_json::json!({"kind":"plugin.terminal.changed","revision":terminal_revision}));
            }
            terminal = Some(views);
            // Managed native input depends on exact effective registrations,
            // including Session-scoped shadows and retirements.
            let mut current_behaviors: Vec<_> = self
                .catalog
                .all::<maka_plugins::session::SessionBehavior>()
                .into_iter()
                .map(|entry| entry.registration_id())
                .collect();
            current_behaviors.sort();
            if behaviors
                .as_ref()
                .is_some_and(|previous| previous != &current_behaviors)
                && sessions.publish_all().await.is_err()
            {
                shutdown.cancel();
                break;
            }
            behaviors = Some(current_behaviors);
            if provider_revision != Some(revision) {
                let _ = changes.send(serde_json::json!({"kind":"model.provider.catalog.changed","revision":revision}));
                provider_revision = Some(revision);
            }
            if let Ok(view) = self.clients.capture(&self) {
                let errors: Vec<_> = self
                    .snapshot()
                    .runtime
                    .entries
                    .iter()
                    .filter(|entry| entry.scope == Scope::DesktopUi)
                    .filter_map(|entry| {
                        entry
                            .error
                            .as_ref()
                            .map(|error| (entry.entry_id.clone(), error.clone()))
                    })
                    .collect();
                let current = (view.revision.clone(), errors);
                if previous
                    .as_ref()
                    .is_some_and(|previous| previous != &current)
                {
                    let _ = changes.send(serde_json::json!({"kind":"plugin.client.changed","revision":view.revision}));
                }
                previous = Some(current);
            }
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                result = catalog.changed() => { if result.is_err() { break; } },
                result = platform.changed() => { if result.is_err() { break; } },
            }
            // Coalesce candidate publication/retirement, not every registration.
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {},
            }
        }
        self.clients.clear();
    }
}

impl Platform {
    /// What a terminal directory listing depends on, for change detection.
    fn terminal_views(&self) -> Vec<(String, uuid::Uuid, String)> {
        let mut views: Vec<_> = self
            .catalog
            .snapshot::<maka_plugins::remote::Endpoint>(&Scope::Profile)
            .entries
            .into_iter()
            .filter_map(|(name, endpoint)| {
                let identity = endpoint.owner.identity().ok()?;
                if identity.scope != Scope::Profile || !endpoint.is_effective() {
                    return None;
                }
                let descriptor = endpoint.value.terminal_view()?;
                Some((
                    name,
                    endpoint.value.target(&identity).registration,
                    serde_json::to_string(descriptor).ok()?,
                ))
            })
            .collect();
        views.sort();
        views
    }
}
