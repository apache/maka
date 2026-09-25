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
use crate::{
    app::Action,
    navigation::{Location, Route, state::Saved},
};
use serde_json::json;

fn saved(navigation: Option<Route>) -> crate::navigation::state::State {
    serde_json::from_value::<Saved>(
        json!({"focus":"navigation", "setting":null, "details":false, "navigation":navigation}),
    )
    .unwrap()
    .restore()
}

fn compare(app: &App, expected: Snapshot) {
    let actual = Snapshot::capture(app, app.checkpoint_root());
    let expected_bytes = super::super::super::store::encode(&expected).unwrap();
    let actual_bytes = super::super::super::store::encode(&actual).unwrap();
    assert_eq!(
        expected_bytes.len(),
        actual_bytes.len(),
        "candidate must count the committed Snapshot metadata"
    );
    assert_eq!(
        serde_json::to_value(expected).unwrap(),
        serde_json::to_value(actual).unwrap()
    );
}

#[test]
fn opening_session_counts_current_and_retained_sidebar_destinations_before_commit() {
    for retained in [false, true] {
        let mut app = crate::apps::tests::app();
        let target = Route::Session("new-session".into());
        if retained {
            app.page_states
                .push_back((Location::from(Route::Projects), saved(Some(target.clone()))));
            // Reopening also restores a previously closed session page's focus.
            app.page_states
                .push_back((Location::from(target.clone()), saved(Some(target.clone()))));
        }
        app.focus = Focus::Navigation;
        app.sidebar.focus_route(&target);
        assert!(!app.tabs.contains("new-session"));
        let before =
            super::super::super::store::encode(&Snapshot::capture(&app, app.checkpoint_root()))
                .unwrap();
        let mut navigation = app.navigation.clone();
        navigation.visit(target.clone());
        let candidate = Snapshot::candidate(&app, Some((&navigation, true, None)));
        assert_eq!(
            super::super::super::store::encode(&Snapshot::capture(&app, app.checkpoint_root()))
                .unwrap(),
            before,
            "preflight leaves every owner unchanged"
        );
        app.apply(Action::Visit(target));
        compare(&app, candidate);
    }
}

#[test]
fn applied_redirect_counts_the_preserved_sidebar_focus_at_its_new_address() {
    let mut app = crate::apps::tests::app();
    let source = crate::apps::tests::key();
    app.apps_action(crate::apps::tests::save());
    let submit = crate::apps::tests::next(&mut app).unwrap();
    app.focus = Focus::Navigation;
    app.sidebar.focus_route(&Route::Session("session".into()));
    let route = json!({"result":"new"});
    let mut target = app.navigation.location().clone();
    assert!(target.change_view(&source, route.clone()));
    let mut navigation = app.navigation.clone();
    assert!(navigation.replace(target));
    let before =
        super::super::super::store::encode(&Snapshot::capture(&app, app.checkpoint_root()))
            .unwrap();
    let candidate = Snapshot::candidate(&app, Some((&navigation, true, Some(app.focus))));
    assert_eq!(app.focus, Focus::Navigation);
    assert_eq!(
        super::super::super::store::encode(&Snapshot::capture(&app, app.checkpoint_root()))
            .unwrap(),
        before
    );
    app.apps_complete(
        submit,
        Ok(crate::apps::Output::Reply(
            maka_plugins::terminal_ui::view::Reply::Applied { route },
        )),
    );
    assert_eq!(app.focus, Focus::Navigation);
    compare(&app, candidate);
}
