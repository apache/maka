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

use serde_json::{Value, json};

pub(crate) fn sample_two_arm_spec_json() -> Value {
    json!({
        "schemaVersion": "maka.eval.v1",
        "id": "tb21-deepseek-v4-flash-two-arm",
        "benchmark": {
            "id": "terminal-bench-2.1",
            "version": "d49e28f1e4ddd13d289e85a5f312a66750951932",
            "config": {
                "repository": "https://github.com/harbor-framework/terminal-bench-2-1"
            }
        },
        "executor": {
            "kind": "harbor",
            "config": {
                "frameworkVersion": "0.20.0",
                "pythonPathEnv": "MAKA_EVAL_HARBOR_PYTHON",
                "trialsRootEnv": "MAKA_EVAL_TRIALS_DIR",
                "environment": { "type": "docker", "delete": true }
            }
        },
        "execution": {
            "maxConcurrentTaskGroups": 2
        },
        "subjects": [
            {
                "id": "maka",
                "kind": "maka",
                "credentials": ["DEEPSEEK_API_KEY"],
                "config": {
                    "makaExecutable": "/opt/maka-agent/maka",
                    "runtimeHostsPath": "/tmp/maka-runtime-hosts",
                    "hostSettlementTimeoutMs": 120000,
                    "connectionSlug": "eval-gateway",
                    "baseUrl": "http://127.0.0.1:43120/v1",
                    "model": "deepseek-v4-flash",
                    "sandboxMode": "workspace-write"
                }
            },
            {
                "id": "external-cli",
                "kind": "external",
                "credentials": ["DEEPSEEK_API_KEY"],
                "config": {
                    "command": "/opt/maka-node-toolchain/bin/node",
                    "credentialEnvironment": {
                        "DEEPSEEK_API_KEY": "DEEPSEEK_API_KEY"
                    },
                    "args": [
                        "/opt/maka-agent/node_modules/@maka/eval/dist/harbor-external-subject.js",
                        "deepseek-harness",
                        "http://127.0.0.1:43120/v1",
                        "/",
                        "dsh",
                        "{{task.input}}"
                    ]
                }
            }
        ],
        "tasks": [
            {
                "id": "task-alpha",
                "input": "Fix alpha",
                "config": { "harbor": { "path": "tasks/task-alpha" } }
            },
            {
                "id": "task-beta",
                "input": "Fix beta",
                "config": { "harbor": { "path": "tasks/task-beta" } }
            }
        ],
        "repetitions": 1,
        "budget": {
            "timeoutMultiplier": 1,
            "maxSteps": 100
        },
        "verifier": {
            "reward": "reward"
        }
    })
}
