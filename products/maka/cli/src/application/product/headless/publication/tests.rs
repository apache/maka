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
use maka_host_runtime::application::transport::Grant;
use maka_plugin_core::composition::InstanceId;
use serde_json::json;
use uuid::Uuid;

fn endpoint(consumer: u128, import: &str, methods: &[&str], recovery: bool) -> HostEndpoint {
    HostEndpoint {
        consumer: InstanceId(vec![Uuid::from_u128(consumer)]),
        import: import.into(),
        grant: Grant {
            methods: methods.iter().map(|name| (*name).into()).collect(),
            recovery,
        },
    }
}

#[test]
fn rebase_updates_default_routes_without_restoring_or_expanding_grants() {
    let previous = BTreeMap::from([
        (
            "service".into(),
            endpoint(1, "old", &["read", "write"], true),
        ),
        ("retired".into(), endpoint(1, "retired", &["read"], true)),
        ("opted-out".into(), endpoint(1, "optional", &["read"], true)),
        ("redirected".into(), endpoint(1, "default", &["read"], true)),
    ]);
    let target = BTreeMap::from([
        (
            "service".into(),
            endpoint(2, "current", &["read", "write", "erase"], true),
        ),
        ("replacement".into(), endpoint(2, "new", &["read"], true)),
        ("opted-out".into(), endpoint(1, "optional", &["read"], true)),
        ("redirected".into(), endpoint(2, "default", &["read"], true)),
    ]);
    let mut selection: Selection = serde_json::from_value(json!({
        "kind":"public_host",
        "endpoints":{
            "service":endpoint(1, "old", &["read"], false),
            "retired":endpoint(1, "retired", &["read"], false),
            "redirected":endpoint(3, "private", &["read"], false),
            "user-api":endpoint(4, "custom", &["write"], false)
        },
        "productMethods":["retired"],
        "native":[{
            "origin":["00000000-0000-0000-0000-000000000001"],
            "consumer":["00000000-0000-0000-0000-000000000001"],
            "provider":["00000000-0000-0000-0000-000000000004"],
            "export":"custom",
            "methods":["write"],
            "recovery":false
        }]
    }))
    .unwrap();

    assert_eq!(
        rebase_endpoints(&mut selection, &previous, &target),
        [
            "/publication/endpoints/retired: remove obsolete product endpoint",
            "/publication/endpoints/service: follow current product binding",
        ]
    );
    selection.validate().unwrap();
    assert_eq!(
        serde_json::to_value(&selection).unwrap(),
        json!({
            "kind":"public_host",
            "endpoints":{
                "service":{
                    "consumer":["00000000-0000-0000-0000-000000000002"],
                    "import":"current","grant":{"methods":["read"],"recovery":false}
                },
                "redirected":{
                    "consumer":["00000000-0000-0000-0000-000000000003"],
                    "import":"private","grant":{"methods":["read"],"recovery":false}
                },
                "user-api":{
                    "consumer":["00000000-0000-0000-0000-000000000004"],
                    "import":"custom","grant":{"methods":["write"],"recovery":false}
                }
            },
            "native":[{
                "origin":["00000000-0000-0000-0000-000000000001"],
                "consumer":["00000000-0000-0000-0000-000000000001"],
                "provider":["00000000-0000-0000-0000-000000000004"],
                "export":"custom",
                "methods":["write"],
                "recovery":false
            }]
        })
    );
}

#[test]
fn a_redirected_endpoint_keeps_its_route_and_reports_its_unavailable_binding() {
    let previous = BTreeMap::from([("external".into(), endpoint(1, "default", &["read"], true))]);
    let mut selection = Selection::PublicHost {
        endpoints: BTreeMap::from([(
            "external".into(),
            endpoint(3, "private-export", &["read"], false),
        )]),
        native: vec![],
        product_methods: Default::default(),
    };
    rebase_endpoints(&mut selection, &previous, &BTreeMap::new());
    let plan = Plan::prepare(
        &Input {
            base: None,
            instances: BTreeMap::new(),
            ui: None,
        },
        &Default::default(),
        &Default::default(),
    )
    .unwrap();
    let error = refresh_from_plan(&mut selection, &plan)
        .unwrap_err()
        .to_string();
    assert!(error.contains("endpoint \"external\""), "{error}");
    assert!(error.contains("import \"private-export\""), "{error}");
    assert!(
        error.contains("00000000-0000-0000-0000-000000000003"),
        "{error}"
    );
}
