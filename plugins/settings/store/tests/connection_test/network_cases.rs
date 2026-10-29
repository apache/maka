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
use maka_agent_facts::configuration::onboarding::*;
use maka_agent_facts::configuration::policy::Personalization;
use maka_config::onboarding::OnboardingPreparation;

#[tokio::test]
async fn native_effects_share_network_policy_snapshot_without_superseding_cosmetic_edits() {
    let fixture = Fixture::new().await;
    fixture.key().await;
    let ready = fixture.prepare(None).await;
    fixture
        .store
        .set_personalization(
            0,
            Personalization {
                display_name: "Unrelated edit".into(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        ready
            .complete(failed(ConnectionEffectFailureClass::Auth))
            .await
            .unwrap(),
        ConnectionTestRunResult::Committed { .. }
    ));
    let test = fixture.prepare(None).await;
    let ModelFetchPreparation::Ready(fetch) = fixture
        .store
        .prepare_model_fetch(&fixture.id)
        .await
        .unwrap()
    else {
        panic!("prepared discovery")
    };
    let onboarding = async || {
        let row = fixture.store.catalog().await.unwrap().connections.remove(0);
        maka_agent_facts::oauth::Target::Existing {
            expected: ConnectionCredentialTarget {
                connection_id: row.connection_id,
                revision: row.revision,
                slug: row.slug,
                provider: row.provider,
                configuration: row.configuration.clone(),
            },
            configuration: row.configuration,
        }
    };
    let OnboardingPreparation::Ready(save) = fixture
        .store
        .prepare_onboarding(onboarding().await)
        .await
        .unwrap()
    else {
        panic!("prepared onboarding")
    };
    let mut before = fixture.store.catalog().await.unwrap();
    let mut policy = fixture.store.runtime_policy().await.unwrap();
    policy.revision += 1;
    policy.policy.network_proxy.enabled = true;
    policy.policy.network_proxy.host = "127.0.0.1".into();
    policy.policy.network_proxy.port = 7890;
    policy.policy.network_proxy.auth_enabled = true;
    policy.policy.network_proxy.username = "user".into();
    policy.validate().unwrap();
    fixture
        .store
        .set_network_proxy(policy.revision - 1, policy.policy.network_proxy.clone())
        .await
        .unwrap();
    before.revision += 1;
    before.connections[0].revision += 1;
    before.connections[0].last_test = None;
    assert_eq!(
        test.complete(failed(ConnectionEffectFailureClass::Auth))
            .await
            .unwrap(),
        ConnectionTestRunResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::NetworkProxy]
        }
    );
    assert_eq!(
        fetch
            .complete(vec![ModelInfo::new("new-model")], 123)
            .await
            .unwrap(),
        ConnectionModelFetchResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::NetworkProxy]
        }
    );
    assert_eq!(
        save.complete(vec![ModelInfo::new("new-model")], vec![], 123)
            .await
            .unwrap(),
        OnboardingSaveResult::Rejected {
            reason: OnboardingRejection::Superseded
        }
    );
    assert_eq!(fixture.store.catalog().await.unwrap(), before);
    let locator = CredentialLocator::NetworkProxy {
        kind: PasswordKind::Password,
    };
    let CredentialMutationResult::Committed { status, .. } = fixture
        .store
        .set_credential(
            SetCredentialInput {
                locator: locator.clone(),
                secret: "first".into(),
                expected: None,
                expected_connection: None,
            },
            1,
        )
        .await
        .unwrap()
    else {
        panic!("proxy credential");
    };
    let test = fixture.prepare(None).await;
    let ModelFetchPreparation::Ready(fetch) = fixture
        .store
        .prepare_model_fetch(&fixture.id)
        .await
        .unwrap()
    else {
        panic!("proxy discovery");
    };
    let OnboardingPreparation::Ready(save) = fixture
        .store
        .prepare_onboarding(onboarding().await)
        .await
        .unwrap()
    else {
        panic!("proxy onboarding");
    };
    assert_eq!(
        test.network_configuration().password.as_deref(),
        Some("first")
    );
    let CredentialState::Configured {
        credential_id,
        revision,
        ..
    } = status.state
    else {
        panic!("proxy credential status");
    };
    fixture
        .store
        .set_credential(
            SetCredentialInput {
                locator,
                secret: "second".into(),
                expected: Some(CredentialIdentityBasis {
                    credential_id,
                    revision,
                }),
                expected_connection: None,
            },
            2,
        )
        .await
        .unwrap();
    assert_eq!(
        test.network_configuration().password.as_deref(),
        Some("first")
    );
    assert_eq!(
        fixture
            .store
            .network_configuration()
            .await
            .unwrap()
            .password
            .as_deref(),
        Some("second")
    );
    assert_eq!(
        test.complete(failed(ConnectionEffectFailureClass::Auth))
            .await
            .unwrap(),
        ConnectionTestRunResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::NetworkProxy]
        }
    );
    assert_eq!(
        fetch
            .complete(vec![ModelInfo::new("new-model")], 124)
            .await
            .unwrap(),
        ConnectionModelFetchResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::NetworkProxy]
        }
    );
    assert_eq!(
        save.complete(vec![ModelInfo::new("new-model")], vec![], 124)
            .await
            .unwrap(),
        OnboardingSaveResult::Rejected {
            reason: OnboardingRejection::Superseded
        }
    );
    assert_eq!(fixture.store.catalog().await.unwrap(), before);
}
