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
use std::{fs, path::Path, process::Command};

fn read(directory: &Path, name: &str) -> Value {
    serde_json::from_slice(&fs::read(directory.join(format!("{name}.json"))).unwrap()).unwrap()
}

fn compose(configuration: &Path, output: &Path, isolated: &Path) {
    let result = Command::new(crate::maka_executable())
        .args(["application", "compose", "--configuration"])
        .arg(configuration)
        .arg("--output")
        .arg(output)
        .env("PATH", isolated)
        .env("NODE_PATH", "")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn agent_composition_preserves_bindings_authority_and_installation_identities_without_node() {
    let directory = tempfile::tempdir().unwrap();
    let configuration = directory.path().join("configuration.json");
    let output = directory.path().join("host-source");
    let agent = json!({
        "workspaceRoots":[{"label":"Project","path":"/private/product-workspace"}],
        "permissions":{"access":"workspace_write","requestPermissions":true},
        "tools":[
            {"name":"ReadPlugins","description":"Read enabled UI plugins","target":{"kind":"import","name":"ui"},"method":"readUi","result":"json","confirmation":"preapproved"},
            {"name":"Execute","description":"Run a command","target":{"kind":"import","name":"processes"},"method":"execute","result":"json","confirmation":"preapproved"}
        ],
    });
    fs::write(&configuration, serde_json::to_vec(&json!({
        "locale":"en",
        "agent":agent,
        "processes":{"filesystem":{"default":"read","rules":[],"denyGlobs":[]},"network":"denied","helper":null},
    })).unwrap()).unwrap();
    compose(&configuration, &output, directory.path());
    let installation = read(&output, "installation");
    let keys = &installation["keys"];
    uuid::Uuid::parse_str(installation["hostDeployment"].as_str().unwrap()).unwrap();
    let host = read(&output, "host");
    assert_eq!(host["ui"], json!({"path":["workbench-ui"],"id":"root"}));
    let ui = &host["instances"]["workbench-ui"];
    assert_eq!(ui["key"], keys["workbench-ui"]);
    assert_eq!(
        ui["package"],
        json!({"source":"pinned","package":read(&output,"packages")["workbench"]})
    );
    assert_eq!(ui["usePackage"], "ui");
    assert_eq!(ui["bindings"], json!({}));
    assert_eq!(
        ui["configuration"]["values"]["session"],
        json!({"path":["conversations-ui"],"id":"session"})
    );
    let conversation = &host["instances"]["conversations-ui"];
    assert_eq!(
        conversation["configuration"]["values"]["composer"],
        json!({"path":["composer-ui"],"id":"composer"})
    );
    assert_eq!(
        conversation["bindings"]["agent"],
        json!([{"kind":"instance","path":["agent"],"export":"agent"}])
    );
    let workbench =
        maka_packages::Package::read_from(&output.join("packages/workbench.maka-plugin")).unwrap();
    assert_eq!(
        serde_json::to_value(workbench.manifest()).unwrap()["application"]["ui"]["contributions"]["root"],
        json!({"kind":"root"})
    );
    assert!(!output.join("ui.json").exists());
    assert!(!output.join("management-host.json").exists());
    assert_eq!(
        host["instances"]["agent"]["bindings"]["processes"],
        json!([{"kind":"instance","path":["workspace-processes"],"export":"processes"}])
    );
    assert_eq!(
        host["instances"]["gateway"]["bindings"]["terminal"],
        json!([{"kind":"instance","path":["workspace-processes"],"export":"terminal"}])
    );
    let processes = &host["instances"]["workspace-processes"]["configuration"]["values"];
    assert_eq!(processes["sessionOwner"], json!([keys["agent"]]));
    assert_eq!(processes["filesystem"]["default"], "read");
    assert_eq!(processes["network"], "denied");
    let endpoints = read(&output, "endpoints");
    for name in ["agent", "terminal"] {
        assert_eq!(endpoints[name]["consumer"], json!([keys["gateway"]]));
        assert_eq!(endpoints[name]["import"], name);
    }
    let grants = read(&output, "native-grants");
    assert!(grants.as_array().unwrap().is_empty());
    assert_eq!(
        host["instances"]["agent"]["bindings"]["ui"],
        json!([{"kind":"instance","path":["host-deployment-manager"],"export":"Management"}])
    );
    fs::write(&configuration, serde_json::to_vec(&installation).unwrap()).unwrap();
    let repeated = directory.path().join("same-installation");
    compose(&configuration, &repeated, directory.path());
    for name in ["host", "endpoints", "native-grants", "installation"] {
        assert_eq!(read(&repeated, name), read(&output, name), "{name}");
    }
}
