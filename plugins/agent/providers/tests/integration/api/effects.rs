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
use futures_util::future::BoxFuture;
use maka_agent_ports::model::Connect;
use maka_agent_ports::model::Error as ModelError;
use maka_agent_ports::model::Socket;
use maka_agent_ports::model::Transport;
use maka_agent_ports::provider::Context;

use maka_capabilities::http;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Exchange;
impl Transport for Exchange {
    fn identity(&self) -> u64 {
        1
    }
    fn request(
        &self,
        _: http::Request,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
        Box::pin(async { panic!("API key validation must not issue an exchange") })
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
        Box::pin(async { panic!("API key validation must not connect a socket") })
    }
}

#[tokio::test]
async fn compiled_definition_authenticates_without_legacy_registration_or_secret_diagnostics() {
    use maka_agent_ports::provider::authentication::Authenticate;
    let definition = ApiProviders::definition("openai-compatible", snapshot()).unwrap();
    let transport = Arc::new(Exchange);
    let context = Context {
        transport: transport.clone(),
        cancellation: CancellationToken::new(),
        interaction: None,
    };
    let connection = Connection {
        id: "native-account".into(),
        revision: 1,
        configuration: json!({"baseUrl":"https://native.test/v1"}),
    };
    let key = "synthetic-private-native-key";
    let result = definition
        .authenticate(
            Authenticate {
                connection: connection.clone(),
                method: "api-key".into(),
                input: json!({"apiKey":format!(" {key} ")}),
            },
            context.clone(),
        )
        .await
        .unwrap();
    assert_eq!(result.secret, key);
    assert_eq!(result.refresh_at, None);
    for (method, input, configuration, error_kind) in [
        (
            "unknown",
            json!({"apiKey":key}),
            connection.configuration.clone(),
            "invalid",
        ),
        (
            "api-key",
            json!({"apiKey":key,"unknown":key}),
            connection.configuration.clone(),
            "invalid",
        ),
        (
            "api-key",
            json!({"apiKey":format!("{key}\n{key}")}),
            connection.configuration.clone(),
            "invalid",
        ),
        (
            "api-key",
            json!({"apiKey":key}),
            json!({"unknown":key}),
            "invalid_configuration",
        ),
    ] {
        let error = match definition
            .authenticate(
                Authenticate {
                    connection: Connection {
                        configuration,
                        ..connection.clone()
                    },
                    method: method.into(),
                    input,
                },
                context.clone(),
            )
            .await
        {
            Ok(_) => panic!("invalid authentication admitted"),
            Err(error) => error,
        };
        assert_eq!(serde_json::to_value(&error).unwrap()["kind"], error_kind);
        assert!(!error.to_string().contains(key));
        assert!(!serde_json::to_string(&error).unwrap().contains(key));
    }
}
