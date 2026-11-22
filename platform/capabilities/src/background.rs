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

/// A live plugin's recoverable work prevents idle expiry, not explicit shutdown
/// or executable handoff. Implementations read a cheap, nonblocking projection;
/// durable plans and accepted Host executions retain their existing owners.
pub trait BackgroundWork: Send + Sync {
    fn is_pending(&self) -> bool;

    /// Notify the owner after system resume. Must be nonblocking; recovery and
    /// duplicate notifications are handled by the existing work owner.
    fn wake(&self) {}
}
