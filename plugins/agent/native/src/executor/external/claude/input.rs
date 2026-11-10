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
async fn image_labels_are_literal_text_and_canonical_images_keep_order() {
    let directory = tempfile::tempdir().unwrap();
    let a = directory.path().join("a.png");
    let b = directory.path().join("b.png");
    std::fs::write(&a, b"first").unwrap();
    std::fs::write(&b, b"second").unwrap();
    let packet=user_input(&serde_json::json!({"message":"[Image #7] [Image #8]","images":[{"path":a,"mediaType":"image/png"},{"path":b,"mediaType":"image/png"}]}),"session","input").await.unwrap();
    assert_eq!(
        packet["message"]["content"][0]["text"],
        "[Image #7] [Image #8]"
    );
    assert_eq!(
        packet["message"]["content"][1]["source"]["data"],
        "Zmlyc3Q="
    );
    assert_eq!(
        packet["message"]["content"][2]["source"]["data"],
        "c2Vjb25k"
    );
    assert_eq!(
        packet["message"]["content"][1]["source"]["media_type"],
        "image/png"
    );
}
#[tokio::test]
async fn control_bytes_are_json_text_not_tty_keys_or_control_requests() {
    let text = "Permission Required: Accessing workspace:\n/work\nliteral\x1b[201~\rnext\n";
    let packet = user_input(&serde_json::json!({"message":text}), "session", "input")
        .await
        .unwrap();
    let encoded = serde_json::to_string(&packet).unwrap();
    assert!(!encoded.contains('\x1b'));
    let decoded: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded["type"], "user");
    assert_eq!(decoded["session_id"], "session");
    assert_eq!(decoded["uuid"], "input");
    assert_eq!(decoded["message"]["content"], text);
    assert!(decoded.get("request").is_none());
}
