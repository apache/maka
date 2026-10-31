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

//! Public Session smoke for automatic ChatGPT browser discovery and handoff.
//! Running it inventories tabs, ends the turn and restores the original host.

use maka_agent_facts::language::Language;
use maka_computer_use::{
    Driver, InvocationContext, Session,
    protocol::{BrowserOptions, Command, InventoryOptions},
};
use std::{process::ExitCode, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

fn main() -> ExitCode {
    if let Some(exit) = maka_computer_use::extension_browser_host::bootstrap() {
        return exit;
    }
    if let Some(exit) = maka_computer_use::cursor::bootstrap() {
        return exit;
    }
    if let Some(exit) = maka_computer_use::desktop::bootstrap() {
        return exit;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    match runtime.block_on(run()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("browser handoff smoke: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = Session::new(driver.clone());
    let mut peer = Session::new(driver.clone());
    let peer_invocation = InvocationContext::new("handoff-peer", "inventory");
    let invocation = InvocationContext::new("handoff-example", "inventory");
    let cancellation = CancellationToken::new();
    let result = async {
        let before = session
            .invoke(
                Command::ListBrowsers {
                    options: InventoryOptions::default(),
                },
                &invocation,
                &cancellation,
                Language::En,
            )
            .await
            .map_err(|error| error.to_string())?;
        println!(
            "before: {} browser entries",
            before.as_array().map_or(0, Vec::len)
        );
        let browser = session
            .invoke(
                Command::GetBrowser {
                    options: BrowserOptions {
                        id: Some("chatgpt".into()),
                        url: None,
                        extension_instance_id: None,
                    },
                },
                &invocation,
                &cancellation,
                Language::En,
            )
            .await
            .map_err(|error| error.to_string())?;
        let id = browser["id"].as_str().ok_or("browser lacks ID")?.to_owned();
        let tabs = session
            .invoke(
                Command::BrowserUserOpenTabs {
                    browser_id: id.clone(),
                },
                &invocation,
                &cancellation,
                Language::En,
            )
            .await
            .map_err(|error| error.to_string())?;
        println!(
            "connected: {} user tabs",
            tabs.as_array().map_or(0, Vec::len)
        );
        peer.invoke(
            Command::BrowserUserOpenTabs {
                browser_id: id.clone(),
            },
            &peer_invocation,
            &cancellation,
            Language::En,
        )
        .await
        .map_err(|error| error.to_string())?;
        session
            .invoke(
                Command::BrowserRelease {
                    browser_id: id.clone(),
                },
                &invocation,
                &cancellation,
                Language::En,
            )
            .await
            .map_err(|error| error.to_string())?;
        let resumed = session
            .invoke(
                Command::GetBrowser {
                    options: BrowserOptions {
                        id: Some("chatgpt".into()),
                        url: None,
                        extension_instance_id: None,
                    },
                },
                &invocation,
                &cancellation,
                Language::En,
            )
            .await
            .map_err(|error| error.to_string())?;
        assert_eq!(
            resumed["metadata"]["generation"], browser["metadata"]["generation"],
            "the peer still owns this generation"
        );
        println!("explicit release and reacquire shared the peer's live generation");
        session
            .finish_turn("handoff-example", "inventory", Language::En)
            .await
            .map_err(|error| error.to_string())?;
        let retained = peer
            .invoke(
                Command::BrowserUserOpenTabs { browser_id: id },
                &peer_invocation,
                &cancellation,
                Language::En,
            )
            .await
            .map_err(|error| error.to_string())?;
        println!(
            "peer still connected after first turn: {} user tabs",
            retained.as_array().map_or(0, Vec::len)
        );
        peer.finish_turn("handoff-peer", "inventory", Language::En)
            .await
            .map_err(|error| error.to_string())?;
        let resumed = session
            .invoke(
                Command::GetBrowser {
                    options: BrowserOptions {
                        id: Some("chatgpt".into()),
                        url: None,
                        extension_instance_id: None,
                    },
                },
                &invocation,
                &cancellation,
                Language::En,
            )
            .await
            .map_err(|error| error.to_string())?;
        assert_ne!(
            resumed["metadata"]["generation"], browser["metadata"]["generation"],
            "returned host must start a fresh generation"
        );
        session
            .finish_turn("handoff-example", "inventory", Language::En)
            .await
            .map_err(|error| error.to_string())?;
        println!("reacquired fresh generation and returned it");
        println!("both turns finished; handoff lease returned");
        Ok(())
    }
    .await;
    let closed = session.close().await.map_err(|error| error.to_string());
    let peer_closed = peer.close().await.map_err(|error| error.to_string());
    let retired = driver
        .lock()
        .await
        .close()
        .await
        .map_err(|error| error.to_string());
    result.and(closed).and(peer_closed).and(retired)
}
