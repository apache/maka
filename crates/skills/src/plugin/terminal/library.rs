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

//! File lifecycle is a separate HostPaths contribution; ordinary preferences stay available.
use super::{ID, Skills, invalid};
use crate::api::*;
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method, key},
    terminal_ui::{
        self, Context, Descriptor, Text,
        app::{App, Cx, Submission, Words},
        view::{Reply, Request, View},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

mod authorization;
mod copy;
mod read;
mod submit;
mod view;
use copy::Copy;

const WINDOW: usize = 8;
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Page {
    cursor: Option<Cursor>,
    offset: usize,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    revision: String,
    cursor: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Source {
    Bundled,
    Managed,
}
impl Source {
    fn catalog(&self) -> CatalogView {
        match self {
            Self::Bundled => CatalogView::Bundled,
            Self::Managed => CatalogView::ManagedSources,
        }
    }
    fn install(&self) -> InstallSource {
        match self {
            Self::Bundled => InstallSource::Bundled,
            Self::Managed => InstallSource::Managed,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Route {
    Installed {
        #[serde(default)]
        page: Page,
    },
    Sources {
        source: Source,
        #[serde(default)]
        page: Page,
    },
    Source {
        source: Source,
        id: String,
        #[serde(default)]
        page: Page,
    },
    Skill {
        reference: String,
    },
    Import,
    Preview {
        reference: String,
    },
    Delete {
        reference: String,
    },
    Resume,
}
impl Default for Route {
    fn default() -> Self {
        Self::Installed {
            page: Page::default(),
        }
    }
}
impl Route {
    fn decode(value: Value) -> Result<Self, Error> {
        let route = if value.is_null() {
            Self::default()
        } else {
            serde_json::from_value(value).map_err(invalid)?
        };
        if let Self::Installed { page } | Self::Sources { page, .. } | Self::Source { page, .. } =
            &route
            && (page.offset >= MAX_ITEMS || !page.offset.is_multiple_of(WINDOW))
        {
            return Err(invalid("Invalid Skills page offset"));
        }
        Ok(route)
    }
    fn value(&self) -> Value {
        serde_json::to_value(self).expect("Skill route")
    }
    fn user_files(&self) -> bool {
        matches!(self, Self::Import | Self::Resume)
            || matches!(self, Self::Delete { reference } if reference.starts_with("user:"))
    }
}
#[derive(Clone)]
struct Stamp {
    revision: String,
    operation: uuid::Uuid,
    reviewed: Review,
}
#[derive(Clone)]
enum Review {
    None,
    Tree(String),
    Update { current: String, source: String },
}
impl Stamp {
    fn new(revision: String) -> Self {
        Self {
            revision,
            operation: uuid::Uuid::new_v4(),
            reviewed: Review::None,
        }
    }
    // The public revision is bounded to 256 bytes: retain three SHA-256 values
    // and a UUID without duplicating their textual prefixes or JSON field names.
    fn encode(&self) -> String {
        let reviewed = match &self.reviewed {
            Review::None => String::new(),
            Review::Tree(hash) => hash[7..].into(),
            Review::Update { current, source } => format!("{}{}", &current[7..], &source[7..]),
        };
        format!(
            "{}:{}:{reviewed}",
            &self.revision[7..],
            self.operation.simple()
        )
    }
    fn decode(value: &str) -> Result<Self, Error> {
        let parts: Vec<_> = value.split(':').collect();
        if parts.len() != 3 {
            return Err(invalid("Invalid Skill view revision"));
        }
        let hash = |raw: &str| {
            let hash = format!("sha256:{raw}");
            crate::publication::receipt::digest(&hash)
                .then_some(hash)
                .ok_or_else(|| invalid("Invalid Skill view digest"))
        };
        let operation = uuid::Uuid::parse_str(parts[1]).map_err(invalid)?;
        if operation.is_nil() {
            return Err(invalid("Invalid Skill operation"));
        }
        let reviewed = match parts[2].len() {
            0 => Review::None,
            64 => Review::Tree(hash(parts[2])?),
            128 if parts[2].is_ascii() => Review::Update {
                current: hash(&parts[2][..64])?,
                source: hash(&parts[2][64..])?,
            },
            _ => return Err(invalid("Invalid Skill review")),
        };
        Ok(Self {
            revision: hash(parts[0])?,
            operation,
            reviewed,
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Recovery {
    route: Route,
    action: String,
    stamp: String,
}

pub(super) fn publish(skills: &Skills, staged: &mut Staged) -> Result<(), String> {
    let endpoint = Endpoint::standalone(Handler::Method(Arc::new(Library(skills.clone()))))
        .requiring_host_paths()
        .with_terminal_view(
            Descriptor::new(
                Text::localized("Skill library", "技能库", "技能庫"),
                Context::Session,
            )
            .icon("✦", "K")
            .changes("changes")
            .order(11),
        )
        .map_err(|error| error.to_string())?;
    staged
        .insert(
            key(ID, "terminal-library").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())
}
#[derive(Clone)]
struct Library(Skills);
impl App for Library {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let skills = self.0.clone();
        Box::pin(async move {
            match read::route(&skills, Route::decode(route)?, &cx).await? {
                Reply::View { view } => Ok(view),
                _ => Err(invalid("Skill catalog changed; refresh this view")),
            }
        })
    }
    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let skills = self.0.clone();
        Box::pin(async move { submit::action(&skills, submission, &cx).await })
    }
    fn recover(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let skills = self.0.clone();
        Box::pin(async move { submit::recover(&skills, route, &cx).await })
    }
}
// App's read method returns only a View. This dispatcher preserves the domain's
// explicit cursor-conflict reply while sharing the public App submit/recover API.
impl Method for Library {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let app = self.clone();
        Box::pin(async move {
            let request: Request = serde_json::from_value(input).map_err(invalid)?;
            request.validate().map_err(invalid)?;
            let cx = Cx {
                words: Words::new(request.locale()),
                caller,
            };
            let reply = match request {
                Request::Read { route, .. } => {
                    read::route(&app.0, Route::decode(route)?, &cx).await?
                }
                Request::Submit {
                    route,
                    revision,
                    action,
                    fields,
                    grant,
                    ..
                } => {
                    App::submit(
                        &app,
                        Submission {
                            route,
                            revision,
                            action,
                            fields,
                            grant,
                        },
                        cx,
                    )
                    .await?
                }
                Request::Recover { route, .. } => App::recover(&app, route, cx).await?,
            };
            reply.validate().map_err(invalid)?;
            serde_json::to_value(reply).map_err(invalid)
        })
    }
}
