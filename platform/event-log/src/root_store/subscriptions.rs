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

//! Root observations share one canonical owner's notifications.
use super::*;

pub struct RootSubscription {
    receiver: tokio::sync::watch::Receiver<()>,
    stop: tokio_util::sync::CancellationToken,
}
impl RootSubscription {
    pub fn borrow_and_update(&mut self) {
        self.receiver.borrow_and_update();
    }
    pub async fn changed(&mut self) -> Result<(), StoreError> {
        tokio::select! {
            biased;
            ()=self.stop.cancelled()=>Err(StoreError::ConnectionClosed),
            result=self.receiver.changed()=>result.map_err(|_|StoreError::ConnectionClosed),
        }
    }
}
impl RootStore {
    pub fn subscribe_catalog_changes(&self) -> RootSubscription {
        RootSubscription {
            receiver: self.log.subscribe_catalog_changes(),
            stop: self.gates.cancellation(),
        }
    }
    pub fn subscribe_changes(&self) -> RootSubscription {
        self.subscribe_catalog_changes()
    }
    pub fn subscribe_control_changes(&self) -> RootSubscription {
        self.subscribe_catalog_changes()
    }
}
