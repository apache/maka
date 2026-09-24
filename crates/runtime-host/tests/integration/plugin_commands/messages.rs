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

use maka_plugins::execution::{CommandError, Commands, Enqueue, MessageReceipt, MessageState};
use maka_runtime::{event::Invocation, message::Placement};

pub(super) struct Queued {
    pub steer: Enqueue,
    pub receipt: MessageReceipt,
    pub followup: Enqueue,
}

pub(super) async fn admit(commands: &dyn Commands, invocation: Invocation) -> Queued {
    let followup = Enqueue {
        operation_id: "queued-followup".into(),
        message_id: "optimistic-followup".into(),
        invocation: invocation.clone(),
        content: "Must not start another model request".into(),
        placement: Placement::NextTurn,
    };
    let receipt = commands.enqueue(followup.clone()).await.unwrap();
    assert_eq!(commands.enqueue(followup.clone()).await.unwrap(), receipt);
    assert!(matches!(
        commands
            .message(followup.operation_id.clone())
            .await
            .unwrap()
            .state,
        MessageState::Pending
    ));
    assert!(matches!(
        commands
            .retract(followup.operation_id.clone())
            .await
            .unwrap()
            .state,
        MessageState::Cancelled
    ));
    assert_eq!(commands.enqueue(followup.clone()).await.unwrap(), receipt);
    let mut stale = followup.clone();
    stale.operation_id = "stale-owner".into();
    stale.invocation.run_id = "not-the-observed-run".into();
    assert!(matches!(
        commands.enqueue(stale).await,
        Err(CommandError::Conflict)
    ));
    let mut foreign = followup.clone();
    foreign.invocation.session_id = "ungranted".into();
    assert!(matches!(
        commands.enqueue(foreign).await,
        Err(CommandError::Denied)
    ));
    let steer = Enqueue {
        operation_id: "queued-steering".into(),
        message_id: "optimistic-steering".into(),
        invocation,
        content: "Keep this accepted steering after plugin retirement".into(),
        placement: Placement::CurrentTurn,
    };
    let receipt = commands.enqueue(steer.clone()).await.unwrap();
    let mut different = steer.clone();
    different.content = "changed".into();
    assert!(matches!(
        commands.enqueue(different).await,
        Err(CommandError::Conflict)
    ));
    Queued {
        steer,
        receipt,
        followup,
    }
}
pub(super) async fn replay(commands: &dyn Commands, queued: &Queued) {
    assert_eq!(
        commands.enqueue(queued.steer.clone()).await.unwrap(),
        queued.receipt
    );
    assert!(matches!(
        commands
            .retract(queued.followup.operation_id.clone())
            .await
            .unwrap()
            .state,
        MessageState::Cancelled
    ));
    assert!(matches!(
        commands
            .read_message(maka_plugins::execution::SessionMessage {
                session_id: "ungranted".into(),
                message_id: queued.receipt.message_id.clone(),
                cursor: None,
            })
            .await,
        Err(CommandError::Denied)
    ));
    assert!(matches!(
        commands
            .read_message(maka_plugins::execution::SessionMessage {
                session_id: queued.receipt.invocation.session_id.clone(),
                message_id: queued.receipt.message_id.clone(),
                cursor: None,
            })
            .await
            .unwrap(),
        Some(MessageState::Delivered {
            exclusive: false,
            interactions,
            ..
        }) if interactions.is_empty()
    ));
    let observed = commands
        .retract(queued.steer.operation_id.clone())
        .await
        .unwrap();
    assert!(
        matches!(
            observed.state,
            MessageState::Delivered {
                exclusive: false,
                ..
            }
        ),
        "{observed:?}"
    );
}
