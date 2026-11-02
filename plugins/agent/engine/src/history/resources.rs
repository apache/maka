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

use maka_agent_facts::attachment::StorageRef;

/// Pure owned projection cannot mint inherited artifact authority.
pub(super) struct Resources<'a> {
    session: &'a str,
}
impl<'a> Resources<'a> {
    pub fn native(session: &'a str) -> Self {
        Self { session }
    }
    pub fn resolve<'b>(&'b self, reference: &'b StorageRef) -> Option<&'b StorageRef> {
        match reference {
            StorageRef::SessionFile { session_id, .. } if session_id != self.session => None,
            _ => Some(reference),
        }
    }
}
