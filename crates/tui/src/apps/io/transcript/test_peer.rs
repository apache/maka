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
use maka_protocol::plugin::{RemoteKind, RemoteResult};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

pub(in crate::apps::io) struct Peer {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    // Client disconnects when its notification consumer disappears.
    _notifications: Option<mpsc::Receiver<maka_client::Notification>>,
}

pub(super) fn mount() -> Mount {
    Mount {
        token: Uuid::new_v4(),
        owner: Uuid::new_v4(),
        document: Uuid::new_v4(),
        package: "package".into(),
        session: None,
        parent: Target {
            entry_id: "entry".into(),
            activation: Uuid::new_v4().to_string(),
            registration: Uuid::new_v4(),
        },
        resource: Resource {
            id: "activity".into(),
            read: "activity.read".into(),
            stream: "activity.stream".into(),
            route: Value::Null,
        },
        locale: "en".into(),
    }
}

impl Peer {
    pub async fn connect() -> (Client, Self) {
        const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let (local, remote) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = tokio::io::split(remote);
        let mut peer = Self {
            reader: BufReader::new(reader),
            writer,
            _notifications: None,
        };
        let connecting = tokio::spawn(Client::connect(
            local,
            ROOT,
            "epoch",
            maka_client::Operations,
        ));
        peer.read().await;
        peer.write(json!({"kind":"accepted","rootId":ROOT,"hostEpoch":"epoch","connectionId":"test",
            "selectedProtocol":maka_protocol::PROTOCOL_VERSION,"compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,
            "compositionId":maka_protocol::COMPOSITION_ID,"compositionRevision":"test","state":"ready"})).await;
        let (client, notices) = connecting.await.unwrap().unwrap();
        peer._notifications = Some(notices);
        (client, peer)
    }

    pub async fn read(&mut self) -> Value {
        let mut line = String::new();
        let count = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.reader.read_line(&mut line),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(count > 0);
        serde_json::from_str(&line).unwrap()
    }

    async fn write(&mut self, value: Value) {
        self.writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }

    pub async fn reply(&mut self, frame: &Value, result: RemoteResult) {
        self.write(json!({"requestId":frame["requestId"],"operation":frame["operation"],"ok":true,"result":result})).await;
    }

    pub async fn reject(&mut self, frame: &Value, error: maka_protocol::OperationError) {
        self.write(json!({"requestId":frame["requestId"],"operation":frame["operation"],"ok":false,"error":error})).await;
    }

    pub async fn opening(&mut self, mount: &Mount) -> (Uuid, Value) {
        for _ in 0..2 {
            let request = self.read().await;
            assert_eq!(request["input"]["kind"], "bind");
            assert_eq!(request["input"]["binding"]["packageId"], mount.package);
            let handler = if request["input"]["binding"]["method"] == mount.resource.read {
                RemoteKind::Method
            } else {
                assert_eq!(request["input"]["binding"]["method"], mount.resource.stream);
                RemoteKind::Stream
            };
            let target = Target {
                registration: Uuid::new_v4(),
                ..mount.parent.clone()
            };
            self.reply(&request, RemoteResult::Bound { target, handler })
                .await;
        }
        let document = mount.document;
        let open = self.read().await;
        assert_eq!(open["input"]["kind"], "open");
        assert_eq!(open["input"]["document"], document.to_string());
        assert_eq!(open["input"]["input"]["mount"], mount.token.to_string());
        (document, open)
    }
}

pub(super) async fn receive(receiver: &mut mpsc::Receiver<Delivery>) -> Delivery {
    tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap()
}
