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

//! Presenters written in Rust. A terminal app reads a route into a view and
//! applies submitted actions; [`method`] serves it as the Remote method its
//! descriptor names, decoding and validating both directions so an app
//! only speaks its domain.

use super::{
    Descriptor, Text,
    view::{Reply, Request, View},
};
use crate::remote::{Caller, Endpoint, Error, Handler, Method, Stream, StreamProvider};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

/// The reader's language, for the text a view says.
#[derive(Clone, Debug)]
pub struct Words {
    pub locale: String,
}
impl Words {
    pub fn new(locale: impl Into<String>) -> Self {
        Self {
            locale: locale.into(),
        }
    }
    /// Text in the reader's language, from the three Maka ships.
    pub fn t(&self, en: &str, zh_cn: &str, zh_tw: &str) -> String {
        Text::localized(en, zh_cn, zh_tw)
            .resolve(&self.locale)
            .to_owned()
    }
}

/// Who is reading, and in which language.
#[derive(Clone)]
pub struct Cx {
    pub words: Words,
    pub caller: Caller,
}
impl Cx {
    pub fn t(&self, en: &str, zh_cn: &str, zh_tw: &str) -> String {
        self.words.t(en, zh_cn, zh_tw)
    }
    pub fn locale(&self) -> &str {
        &self.words.locale
    }
    /// The session a session view was opened in.
    pub fn session(&self) -> Result<&str, Error> {
        self.caller
            .session_id
            .as_deref()
            .ok_or_else(|| Error::Invalid("Open this view from a session".into()))
    }
}

/// A submitted action, as the view that offered it saw the world.
pub struct Submission {
    pub route: Value,
    pub revision: String,
    pub action: String,
    pub fields: BTreeMap<String, Value>,
    pub grant: Option<crate::authorization::Id>,
}
impl Submission {
    pub fn text(&self, id: &str) -> Result<&str, Error> {
        self.fields
            .get(id)
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid(format!("Missing field {id}")))
    }
    pub fn toggle(&self, id: &str) -> Result<bool, Error> {
        self.fields
            .get(id)
            .and_then(Value::as_bool)
            .ok_or_else(|| Error::Invalid(format!("Missing field {id}")))
    }
}

pub trait App: Send + Sync + 'static {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>>;
    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>>;
    /// Finds what an idempotent submission became after a lost reply. Only
    /// apps that declare recovery routes on their actions are asked.
    fn recover(&self, _route: Value, _cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        Box::pin(async { Err(Error::Invalid("This view declares no recovery".into())) })
    }
}

struct Served<A>(Arc<A>);

impl<A: App> Method for Served<A> {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let app = self.0.clone();
        Box::pin(async move {
            let request: Request =
                serde_json::from_value(input).map_err(|error| Error::Invalid(error.to_string()))?;
            request
                .validate()
                .map_err(|error| Error::Invalid(error.to_string()))?;
            let cx = Cx {
                words: Words::new(request.locale()),
                caller,
            };
            let reply = match request {
                Request::Read { route, .. } => Reply::View {
                    view: app.read(route, cx).await?,
                },
                Request::Recover { route, .. } => app.recover(route, cx).await?,
                Request::Submit {
                    route,
                    revision,
                    action,
                    fields,
                    grant,
                    ..
                } => {
                    let submission = Submission {
                        route,
                        revision,
                        action,
                        fields,
                        grant,
                    };
                    app.submit(submission, cx).await?
                }
            };
            // An app that builds an invalid view fails here, in the Host,
            // never as a half-drawn page in a shell.
            reply
                .validate()
                .map_err(|error| Error::Provider(error.to_string()))?;
            serde_json::to_value(reply).map_err(|error| Error::Provider(error.to_string()))
        })
    }
}

/// An app as the endpoint its descriptor presents.
pub fn endpoint(app: impl App, descriptor: Descriptor) -> Result<Endpoint, crate::Error> {
    Endpoint::standalone(Handler::Method(method(app))).with_terminal_view(descriptor)
}

pub fn method(app: impl App) -> Arc<dyn Method> {
    Arc::new(Served(Arc::new(app)))
}

/// A changes stream for descriptors to name: one item each time the watched
/// revision moves, none at open (the shell has just read). `subscribe`
/// picks what a caller watches, so a session's stream can ignore others.
pub fn changes(
    subscribe: impl Fn(&Caller) -> tokio::sync::watch::Receiver<u64> + Send + Sync + 'static,
) -> Arc<dyn StreamProvider> {
    Arc::new(Changes(Box::new(subscribe)))
}

type Subscribe = Box<dyn Fn(&Caller) -> tokio::sync::watch::Receiver<u64> + Send + Sync>;
struct Changes(Subscribe);

impl StreamProvider for Changes {
    fn open(
        &self,
        input: Value,
        caller: Caller,
    ) -> BoxFuture<'static, Result<Box<dyn Stream>, Error>> {
        let mut revisions = (self.0)(&caller);
        revisions.mark_unchanged();
        let stop = caller.cancellation.child_token();
        Box::pin(async move {
            if !input.is_null() {
                return Err(Error::Invalid("Changes take no arguments".into()));
            }
            Ok(Box::new(Watching {
                revisions: tokio::sync::Mutex::new(revisions),
                stop,
            }) as Box<dyn Stream>)
        })
    }
}

struct Watching {
    revisions: tokio::sync::Mutex<tokio::sync::watch::Receiver<u64>>,
    stop: tokio_util::sync::CancellationToken,
}

impl Stream for Watching {
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>> {
        Box::pin(async move {
            let mut revisions = self.revisions.lock().await;
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => Ok(None),
                changed = revisions.changed() => {
                    changed.map_err(|_| Error::Retired)?;
                    Ok(Some(Value::from(*revisions.borrow_and_update())))
                }
            }
        })
    }
    fn cancel(&self) {
        self.stop.cancel();
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>> {
        self.stop.cancel();
        Box::pin(async { Ok(()) })
    }
}
