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

//! Reading belongs to exact contribution instances, even on shared surfaces.

use super::{App, Instance, Key, Message};
use crate::{navigation::Route, ui::Surface};
use std::collections::BTreeMap;

/// An actual built contribution boundary, in parent-before-child order.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Scope {
    pub key: Key,
    pub epoch: uuid::Uuid,
    pub path: String,
}

fn park<M: Clone>(
    instances: &mut BTreeMap<Key, Instance>,
    surface: &mut Surface<M>,
    scopes: &mut Vec<Scope>,
) {
    for scope in scopes.drain(..).rev() {
        if let Some(instance) = instances
            .get_mut(&scope.key)
            .filter(|instance| instance.reading_epoch == scope.epoch)
        {
            surface.park_region(&scope.path, &mut instance.surface);
        } else {
            // A retired owner cannot leave its state for the next contributor.
            surface.park_region(&scope.path, &mut Surface::<Message>::default());
        }
    }
    surface.leave();
}

/// Normal frames only compare derived ownership. A change requires rebuilding
/// the tree once after restoring split preferences, before its single render.
pub(super) fn sync<M: Clone>(
    instances: &mut BTreeMap<Key, Instance>,
    surface: &mut Surface<M>,
    previous: &mut Vec<Scope>,
    current: Vec<Scope>,
) -> bool {
    if *previous == current {
        return false;
    }
    park(instances, surface, previous);
    for scope in &current {
        if let Some(instance) = instances.get_mut(&scope.key) {
            surface.restore_region(&scope.path, &mut instance.surface);
        }
    }
    surface.retain_region_focus(current.iter().map(|scope| scope.path.as_str()));
    *previous = current;
    true
}

impl App {
    pub(crate) fn park_app_reading(&mut self) {
        match self.navigation.current() {
            Route::Session(_) => park(
                &mut self.apps.instances,
                &mut self.apps.inspector,
                &mut self.apps.inspector_scopes,
            ),
            Route::Settings => park(
                &mut self.apps.instances,
                &mut self.settings.surface,
                &mut self.apps.settings_scopes,
            ),
            Route::App(key) => {
                if let Some(instance) = self.apps.instances.get_mut(&key) {
                    let mut surface = std::mem::take(&mut instance.surface);
                    let mut scopes = std::mem::take(&mut instance.scopes);
                    park(&mut self.apps.instances, &mut surface, &mut scopes);
                    self.apps.instances.get_mut(&key).unwrap().surface = surface;
                }
            }
            _ => {}
        }
    }

    pub(crate) fn sync_settings_reading(&mut self, scopes: Vec<Scope>) -> bool {
        sync(
            &mut self.apps.instances,
            &mut self.settings.surface,
            &mut self.apps.settings_scopes,
            scopes,
        )
    }

    pub(super) fn sync_page_reading(&mut self, key: &Key, current: Vec<Scope>) -> bool {
        let Some(instance) = self.apps.instances.get_mut(key) else {
            return false;
        };
        let mut surface = std::mem::take(&mut instance.surface);
        let mut scopes = std::mem::take(&mut instance.scopes);
        let changed = sync(&mut self.apps.instances, &mut surface, &mut scopes, current);
        let instance = self.apps.instances.get_mut(key).unwrap();
        instance.surface = surface;
        instance.scopes = scopes;
        changed
    }
}
