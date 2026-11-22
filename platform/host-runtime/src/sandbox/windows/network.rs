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

use maka_network::{Policy, proxy::Proxy};
use maka_sandbox::Network;
use std::{
    collections::BTreeMap,
    io,
    net::{Ipv4Addr, SocketAddr},
    num::NonZeroU16,
    sync::{Arc, OnceLock, Weak},
};
use tokio::sync::Mutex;

struct Active {
    network: Network,
    route: Policy,
    proxy: Weak<Proxy>,
}
type Registry = BTreeMap<NonZeroU16, Active>;

/// WFP admits only this account to its reserved port. Account leases include the
/// network policy, so a denied or differently granted execution cannot share it.
/// The registry is only a listener cache; disk authority and Jobs govern reuse.
pub(super) async fn acquire(
    port: NonZeroU16,
    network: Network,
    route: Policy,
) -> io::Result<Arc<Proxy>> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    let mut registry = REGISTRY.get_or_init(Default::default).lock().await;
    registry.retain(|_, entry| entry.proxy.strong_count() != 0);
    if let Some(entry) = registry.get(&port)
        && let Some(proxy) = entry.proxy.upgrade()
    {
        if entry.network != network || entry.route != route {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "sandbox gateway still belongs to another execution policy",
            ));
        }
        return Ok(proxy);
    }
    let (_, proxy) = Proxy::start_at(
        network.clone(),
        route.clone(),
        SocketAddr::from((Ipv4Addr::LOCALHOST, port.get())),
    )
    .await?;
    let proxy = Arc::new(proxy);
    registry.insert(
        port,
        Active {
            network,
            route,
            proxy: Arc::downgrade(&proxy),
        },
    );
    Ok(proxy)
}
