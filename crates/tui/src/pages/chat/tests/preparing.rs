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

fn rejection(code: OperationErrorCode, message: &str) -> RequestFailure {
    RequestFailure::Rejected(ClientError::Rejected(maka_protocol::OperationError {
        code,
        message: message.into(),
    }))
}

fn preparing() -> OpenError {
    rejection(OperationErrorCode::TranscriptPreparing, "正在准备").into()
}

#[tokio::test(start_paused = true)]
async fn preparation_wakes_the_scheduler_and_advances_until_ready() {
    let mut chat = Chat::default();
    chat.select(&Route::Session("a".into()));
    let mut request = chat.open_query().unwrap();
    for _ in 0..3 {
        assert_eq!(chat.opened(request, Err(preparing())), OpenEffect::None);
        assert!(chat.error.is_none());
        assert!(chat.snapshot.is_none());
        assert!(chat.subscription.is_none());
        assert!(chat.open_query().is_none());
        let wake = wait_for_open(chat.open_deadline());
        tokio::pin!(wake);
        assert!(futures_util::poll!(&mut wake).is_pending());
        tokio::time::advance(PREPARATION_INTERVAL - Duration::from_millis(1)).await;
        assert!(futures_util::poll!(&mut wake).is_pending());
        assert!(chat.open_query().is_none());
        tokio::time::advance(Duration::from_millis(1)).await;
        wake.await;
        request = chat.open_query().unwrap();
        assert!(chat.open_deadline().is_none());
        assert!(
            chat.open_query().is_none(),
            "only one open may be in flight"
        );
    }
    assert_eq!(
        chat.opened(request, Ok(opened())),
        OpenEffect::Ready("sub".into())
    );
    assert!(chat.snapshot.is_some());
    assert!(chat.error.is_none());
    assert!(chat.open_deadline().is_none());
    assert!(chat.open_query().is_none());
    let idle = wait_for_open(chat.open_deadline());
    tokio::pin!(idle);
    assert!(futures_util::poll!(&mut idle).is_pending());
}

#[tokio::test(start_paused = true)]
async fn only_the_typed_preparation_rejection_is_retried() {
    let errors = [
        rejection(
            OperationErrorCode::OperationUnavailable,
            "Transcript preparation is progressing",
        ),
        rejection(OperationErrorCode::NotFound, "gone"),
        rejection(OperationErrorCode::PersistenceFailed, "storage"),
        RequestFailure::Unknown(ClientError::Rejected(maka_protocol::OperationError {
            code: OperationErrorCode::TranscriptPreparing,
            message: "unknown outcome".into(),
        })),
        RequestFailure::Unknown(ClientError::Timeout),
        RequestFailure::NotDispatched(ClientError::Closed("closed".into())),
    ];
    for error in errors {
        let diagnostic = error.to_string();
        let mut chat = Chat::default();
        chat.select(&Route::Session("a".into()));
        let request = chat.open_query().unwrap();
        assert_eq!(chat.opened(request, Err(error.into())), OpenEffect::None);
        assert_eq!(chat.error.as_deref(), Some(diagnostic.as_str()));
        assert!(chat.open_deadline().is_none());
        tokio::time::advance(Duration::from_secs(3600)).await;
        assert!(chat.open_query().is_none());
    }
}

#[tokio::test(start_paused = true)]
async fn leaving_reentry_and_old_results_keep_the_new_owner_unchanged() {
    let mut chat = Chat::default();
    chat.select(&Route::Session("a".into()));
    let old = chat.open_query().unwrap();
    chat.opened(old.clone(), Err(preparing()));
    chat.select(&Route::Settings);
    assert!(chat.open_deadline().is_none());
    assert!(chat.open_query().is_none());
    chat.select(&Route::Session("a".into()));
    let current = chat.open_query().unwrap();
    for result in [
        Err(preparing()),
        Err(OpenError::Failed("old failure".into())),
        Ok(opened()),
    ] {
        let expected = if result.is_ok() {
            OpenEffect::Close("sub".into())
        } else {
            OpenEffect::None
        };
        assert_eq!(chat.opened(old.clone(), result), expected);
        assert_eq!(chat.opening, Some(current.generation));
        assert!(chat.error.is_none());
        assert!(chat.snapshot.is_none());
        assert!(chat.open_deadline().is_none());
        assert!(chat.open_query().is_none());
    }
    chat.opened(current, Err(preparing()));
    let deadline = chat.open_deadline();
    chat.opened(old.clone(), Err(preparing()));
    assert_eq!(chat.open_deadline(), deadline);
    wait_for_open(deadline).await;
    let current = chat.open_query().unwrap();
    let mut new = opened();
    new.snapshot.subscription_id = "new-sub".into();
    assert_eq!(
        chat.opened(current, Ok(new)),
        OpenEffect::Ready("new-sub".into())
    );
    assert_eq!(
        chat.opened(old.clone(), Ok(opened())),
        OpenEffect::Close("sub".into())
    );
    assert_eq!(chat.opened(old, Err(preparing())), OpenEffect::None);
    assert_eq!(chat.subscription.as_deref(), Some("new-sub"));
    assert!(chat.open_deadline().is_none());
}

#[tokio::test(start_paused = true)]
async fn an_inflight_old_preparation_releases_only_its_own_slot() {
    let mut chat = Chat::default();
    chat.select(&Route::Session("a".into()));
    let old = chat.open_query().unwrap();
    chat.select(&Route::Session("b".into()));
    assert!(chat.open_query().is_none());
    chat.opened(old, Err(preparing()));
    assert!(chat.open_deadline().is_none());
    assert!(chat.error.is_none());
    assert_eq!(chat.open_query().unwrap().session, "b");
}

#[tokio::test(start_paused = true)]
async fn retirement_disconnect_and_reset_cancel_scheduled_preparation() {
    for cancel in [Chat::retire, Chat::reset, |chat: &mut Chat| {
        chat.disconnect("offline".into())
    }] {
        let mut chat = Chat::default();
        chat.select(&Route::Session("a".into()));
        let old = chat.open_query().unwrap();
        chat.opened(old.clone(), Err(preparing()));
        cancel(&mut chat);
        assert!(chat.open_deadline().is_none());
        let error = chat.error.clone();
        assert_eq!(chat.opened(old.clone(), Err(preparing())), OpenEffect::None);
        assert_eq!(
            chat.opened(old, Ok(opened())),
            OpenEffect::Close("sub".into())
        );
        assert_eq!(chat.error, error);
        tokio::time::advance(PREPARATION_INTERVAL).await;
        assert!(chat.open_deadline().is_none());
        assert!(chat.open_query().is_none());
        assert!(chat.subscription.is_none());
    }
}

#[tokio::test(start_paused = true)]
async fn preparing_keeps_loading_visible_and_composer_and_shell_responsive() {
    use crate::app::{Action, App, ConnectionState, Focus};
    use crossterm::event::Event;
    let mut app = App::new(
        "/unused".into(),
        I18n::new(
            crate::LocalePreference::Explicit(crate::Locale::En),
            crate::Locale::En,
        ),
    );
    app.connection = ConnectionState::Connected {
        root_id: "root".into(),
        epoch: "epoch".into(),
    };
    app.apply(Action::Visit(Route::Session("a".into())));
    app.chat.select(&app.navigation.current());
    let request = app.chat.open_query().unwrap();
    app.chat.opened(request, Err(preparing()));
    app.focus = Focus::Composer;
    tokio::select! {
        biased;
        () = wait_for_open(app.chat.open_deadline()) => panic!("retry must yield to local input"),
        () = std::future::ready(()) => {
            assert!(app.input(Event::Paste("local 中文🦀".into())).1.is_none());
        }
    }
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 30)).unwrap();
    terminal
        .draw(|frame| crate::view::draw(frame, &mut app))
        .unwrap();
    let screen = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(screen.contains(&app.i18n.text("chat-loading")));
    assert!(!screen.contains(&app.i18n.text("chat-failed")));
    assert_eq!(app.drafts["a"].text(), "local 中文🦀");
    app.apply(Action::Palette);
    assert!(app.palette.is_some());
    assert!(app.chat.open_query().is_none());
}
