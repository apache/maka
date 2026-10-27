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

use futures_util::future::BoxFuture;
use maka_host_runtime::application::{
    NativeActivation, NativeOwner, NativeRegistry, NativeRetirement,
};
use maka_plugin_core::deployment::DeploymentRef;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::watch;

pub(super) const IMPLEMENTATION: &str = "test.nsh.observed-gateway";
pub(super) type Publications = watch::Sender<Option<DeploymentRef>>;

pub struct GatewayActivations(watch::Receiver<Option<DeploymentRef>>);

impl GatewayActivations {
    pub(super) fn new() -> (Publications, Self) {
        let (published, observed) = watch::channel(None);
        (published, Self(observed))
    }

    // Observe publication, not SQL commit or initializer entry. The enclosing
    // real-Host test's deadline still bounds an initializer that never succeeds.
    pub async fn wait_for(&mut self, expected: &DeploymentRef) -> Result<(), String> {
        loop {
            {
                let observed = self.0.borrow_and_update();
                if let Some(actual) = observed.as_ref() {
                    if actual == expected {
                        return Ok(());
                    }
                    if actual.state_domain != expected.state_domain
                        || actual.deployment != expected.deployment
                        || actual.revision > expected.revision
                    {
                        return Err(format!(
                            "gateway activated unexpected source {actual:?}, waiting for {expected:?}"
                        ));
                    }
                }
            }
            self.0.changed().await.map_err(|_| {
                format!("gateway activation observation closed before {expected:?}")
            })?;
        }
    }
}

struct ObservedGateway {
    source: DeploymentRef,
    published: Publications,
}

impl NativeOwner for ObservedGateway {
    fn activated(&self) {
        self.published.send_replace(Some(self.source.clone()));
    }
    fn prepare_retirement(&self) -> Option<Box<dyn NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

pub(super) fn provide(native: &mut NativeRegistry, published: Publications) {
    native
        .insert(
            IMPLEMENTATION.into(),
            Arc::new(move |context, configuration| {
                let source = context.persistence().unwrap().source().clone();
                let published = published.clone();
                Box::pin(async move { initialize(source, published, configuration) })
            }),
        )
        .unwrap();
}

fn initialize(
    source: DeploymentRef,
    published: Publications,
    configuration: Value,
) -> NativeActivation {
    // Match the ordinary gateway's empty config, exports and ownership; keep
    // no NativeContext or RootStore lease here. Initialization is not activation.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    NativeActivation {
        exports: serde_json::from_value::<Empty>(configuration)
            .map(|_| BTreeMap::new())
            .map_err(|error| error.to_string()),
        owner: Arc::new(ObservedGateway { source, published }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    use std::task::Poll;
    use uuid::Uuid;

    fn source(revision: u64) -> DeploymentRef {
        DeploymentRef {
            state_domain: "0".repeat(64),
            deployment: Uuid::from_u128(1),
            revision,
        }
    }

    #[tokio::test]
    async fn waits_for_the_exact_published_gateway_not_its_initializer_or_old_source() {
        let (published, mut observed) = GatewayActivations::new();
        let old = initialize(source(1), published.clone(), serde_json::json!({}));
        old.owner.activated();
        let current = initialize(source(2), published, serde_json::json!({}));
        assert!(current.exports.as_ref().unwrap().is_empty());
        let expected = source(2);
        let mut waiting = Box::pin(observed.wait_for(&expected));
        assert!(poll!(&mut waiting).is_pending());
        current.owner.activated();
        assert!(matches!(poll!(&mut waiting), Poll::Ready(Ok(()))));
    }

    #[tokio::test]
    async fn rejects_wrong_gateway_identity_and_closed_observation_without_waiting() {
        let expected = source(2);
        for unexpected in [
            DeploymentRef {
                state_domain: "1".repeat(64),
                ..expected.clone()
            },
            DeploymentRef {
                deployment: Uuid::from_u128(2),
                ..expected.clone()
            },
            source(3),
        ] {
            let (published, mut observed) = GatewayActivations::new();
            let owner = ObservedGateway {
                source: unexpected,
                published,
            };
            owner.activated();
            let mut waiting = Box::pin(observed.wait_for(&expected));
            assert!(
                matches!(poll!(&mut waiting), Poll::Ready(Err(error)) if error.contains("unexpected source"))
            );
            drop(owner);
        }
        let (published, mut observed) = GatewayActivations::new();
        let mut waiting = Box::pin(observed.wait_for(&expected));
        assert!(poll!(&mut waiting).is_pending());
        drop(published);
        assert!(matches!(poll!(&mut waiting), Poll::Ready(Err(_))));
    }
}
