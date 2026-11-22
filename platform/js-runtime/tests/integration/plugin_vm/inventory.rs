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

#[tokio::test]
async fn complete_module_source_and_callback_paths_keep_original_custody() {
    let vm = Vm::pure(Limits::default()).unwrap();
    let data = format!("MODULE START{}END", "x".repeat(8 * 1024 * 1024));
    let segment = "namespace".repeat(16);
    let mut namespace = vec!["root".to_owned()];
    namespace.extend((0..33).map(|index| format!("{segment}{index}")));
    let methods = (0..65)
        .map(|index| format!("method{index}{}", "x".repeat(128)))
        .collect::<Vec<_>>();
    let source = format!(
        "const data={}; export const root={{}}; let leaf=root; for(const name of {}) leaf=leaf[name]={{}}; for(const [index,name] of {}.entries()) leaf[name]=()=>[index,data.length,data.slice(-3)];",
        serde_json::to_string(&data).unwrap(),
        serde_json::to_string(&namespace[1..]).unwrap(),
        serde_json::to_string(&methods).unwrap()
    );
    let module = vm.load("complete.mjs".into(), source).unwrap();
    let mut path = namespace.clone();
    path.push(methods[0].clone());
    let direct = module.call(path, vec![]).await;
    let captured = module.capture(namespace, methods.clone()).await;
    let result = match &captured {
        Ok(callbacks) => Some(callbacks.call(&methods[64], vec![]).await),
        Err(_) => None,
    };
    module.close().await.unwrap();
    vm.shutdown().await;
    assert_eq!(direct.unwrap(), json!([0, data.len(), "END"]));
    assert_eq!(
        result
            .expect("complete callback metadata must capture")
            .unwrap(),
        json!([64, data.len(), "END"])
    );
}
