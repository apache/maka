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
#[cfg(test)]
mod refresh;
#[cfg(test)]
mod tests;

impl App {
    pub(super) fn move_collection(&mut self, key: Key, path: String) -> Option<Action> {
        let movement = self
            .apps
            .instances
            .get(&key)?
            .collections
            .get(&path)
            .take_move()?;
        let command = Message::Instance(key.clone(), Command::View(Intent::Move(path.clone())));
        if !self.apps_enabled(&command) {
            return None;
        }
        let instance = self.apps.instances.get(&key)?;
        let binding = instance
            .view
            .as_ref()?
            .movement(&path, &movement.item, &movement.group, &movement.before)
            .ok()?
            .clone();
        let changes = [
            (binding.item_field, Value::String(movement.item)),
            (binding.group_field, Value::String(movement.group)),
            (binding.before_field, Value::String(movement.before)),
        ];
        let before = instance.drafts.clone();
        // Stage and admit the aggregate synchronously. A failed later field
        // restores the original draft before another input/request can observe it.
        for (field, value) in changes {
            if !self.admit_field(&key, &field, &value) {
                self.apps.instances.get_mut(&key)?.drafts = before;
                return None;
            }
            self.apps
                .instances
                .get_mut(&key)?
                .drafts
                .insert(field, value);
        }
        self.apps_action(Message::Instance(
            key,
            Command::View(Intent::Submit(binding.action)),
        ))
    }
}
