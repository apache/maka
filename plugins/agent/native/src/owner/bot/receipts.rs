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
use maka_event_log::root::{RootNamespaces, RootOwner};

#[tokio::test]
async fn read_receipts_survive_reopen_and_never_mark_later_messages_read() {
    let directory = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let path = directory.path().join("root");
    let root = Arc::new(
        RootStore::open(
            Arc::new(RootOwner::create(&path, &namespaces).unwrap()),
            maka_event_log::ROOT_MIGRATIONS,
        )
        .await
        .unwrap(),
    );
    let bot = Bot::new(root.clone(), "receipt-test/".into());
    bot.append(
        "first-bot",
        "turn",
        "one",
        "one",
        &["first".into(), "second".into()],
        1,
        None,
    )
    .await
    .unwrap();
    bot.mark_read("first-bot", 2).await.unwrap();
    bot.append(
        "first-bot",
        "turn",
        "two",
        "two",
        &["third".into()],
        2,
        None,
    )
    .await
    .unwrap();
    bot.mark_read("first-bot", 1).await.unwrap();
    assert_eq!(
        bot.read::<Head>(&read_key("first-bot"))
            .await
            .unwrap()
            .1
            .unwrap()
            .through,
        2
    );
    assert_eq!(
        bot.read::<Head>(&head_key("first-bot"))
            .await
            .unwrap()
            .1
            .unwrap()
            .through,
        3
    );
    bot.storage
        .batch(vec![
            Bot::mutation(former_key("first-bot"), None, &true).unwrap(),
        ])
        .await
        .unwrap();
    assert!(bot.is_or_was("first-bot").await.unwrap());
    assert!(!bot.is_or_was("replacement-bot").await.unwrap());
    bot.finish().await.unwrap();
    drop(bot);
    root.shutdown().await.unwrap();
    drop(root);

    let root = Arc::new(
        RootStore::open(
            Arc::new(RootOwner::open(&path, &namespaces).unwrap()),
            maka_event_log::ROOT_MIGRATIONS,
        )
        .await
        .unwrap(),
    );
    let bot = Bot::new(root.clone(), "receipt-test/".into());
    assert!(bot.is_or_was("first-bot").await.unwrap());
    assert_eq!(
        bot.read::<Head>(&read_key("first-bot"))
            .await
            .unwrap()
            .1
            .unwrap()
            .through,
        2
    );
    let (first, stale) = tokio::join!(bot.mark_read("first-bot", 3), bot.mark_read("first-bot", 2));
    first.unwrap();
    stale.unwrap();
    assert_eq!(
        bot.read::<Head>(&read_key("first-bot"))
            .await
            .unwrap()
            .1
            .unwrap()
            .through,
        3
    );
    assert!(
        bot.read::<Head>(&read_key("replacement-bot"))
            .await
            .unwrap()
            .1
            .is_none()
    );
    assert_eq!(
        bot.read::<BotMessage>(&message_key("first-bot", 3))
            .await
            .unwrap()
            .1
            .unwrap()
            .text,
        "third"
    );
    bot.finish().await.unwrap();
    drop(bot);
    root.shutdown().await.unwrap();
}
