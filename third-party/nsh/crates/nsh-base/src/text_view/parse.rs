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

//! One component-owned parser worker. Source effects replace the latest work;
//! an already-started blocking parse is allowed to finish before the next starts.
use super::markdown::{Projection, ProjectionKind};
use super::view::{TextViewEvent, TextViewProps};
use super::{Block, Document, Inline, MarkdownExtension, MarkdownOptions, MarkdownPlugins, Parser};
use nsh_core::ui::{Owner, Stored, prelude::*, stored};

#[derive(Clone, Debug, PartialEq)]
enum Input {
    Markdown(SharedString),
    Html(SharedString),
    Document(Document),
}
#[derive(Clone, Debug, PartialEq)]
struct Request {
    input: Input,
    source_id: Option<SharedString>,
    options: MarkdownOptions,
    extensions: Vec<MarkdownExtension>,
    plugins: MarkdownPlugins,
}
impl Request {
    fn admits(&self, parsed: &Self) -> bool {
        self.source_id == parsed.source_id
            && self.options == parsed.options
            && self.extensions == parsed.extensions
            && self.plugins == parsed.plugins
            && match (&self.input, &parsed.input) {
                (Input::Markdown(current), Input::Markdown(old)) => {
                    current.starts_with(old.as_ref())
                }
                _ => self.input == parsed.input,
            }
    }
    fn parse(&self) -> Projection {
        // Configure plugins (which may create non-Send ParseOptions callbacks)
        // entirely on the CPU worker; only owned source/configuration crosses.
        let parser = Parser::new()
            .options(self.options)
            .extensions(self.extensions.clone())
            .plugins(&self.plugins);
        match &self.input {
            Input::Markdown(source) => parser.markdown_projection(source),
            Input::Html(source) => Projection {
                document: parser.html(source),
                ..Projection::default()
            },
            Input::Document(document) => Projection {
                document: document.clone(),
                ..Projection::default()
            },
        }
    }
    fn literal(&self) -> Projection {
        match &self.input {
            Input::Markdown(source) | Input::Html(source) => {
                let raw_len = source.len() as u64;
                Projection {
                    document: Document::new(vec![Block::paragraph(vec![Inline::Source {
                        content: vec![Inline::text(source.to_string())],
                        segments: super::markdown::source::literal(0, source),
                    }])]),
                    kind: ProjectionKind::LiteralWholeDocument,
                    raw_len,
                    rows: vec![if raw_len == 0 {
                        Vec::new()
                    } else {
                        std::iter::once(0..raw_len).collect()
                    }]
                    .into(),
                }
            }
            Input::Document(document) => Projection {
                document: document.clone(),
                ..Projection::default()
            },
        }
    }
}
#[derive(Default)]
struct Work {
    latest: Option<Request>,
    pending: bool,
    running: bool,
}

#[derive(Clone, Copy)]
pub(super) struct DocumentState {
    pub document: Signal<Projection>,
    source: Signal<Option<Request>>,
}
impl DocumentState {
    /// The native subtree's lifetime changes only for a source/configuration
    /// replacement. Appends retain controls and their owners.
    pub(super) fn track_source(&self) {
        self.source.with(|_| ());
    }
    pub(super) fn origin(&self) -> SourceOrigin {
        SourceOrigin {
            source: self.source,
            request: self.source.get_untracked(),
        }
    }
}

/// The same source boundary that owns the native subtree and gates parser
/// results. A link only retains this capability; it owns no parallel state.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct SourceOrigin {
    source: Signal<Option<Request>>,
    request: Option<Request>,
}
impl SourceOrigin {
    pub(super) fn is_current(&self) -> bool {
        self.source.get_untracked() == self.request
    }
}

pub(super) fn document(
    props: TextViewProps,
    plugins: MarkdownPlugins,
    scope: Scope<TextViewEvent>,
) -> DocumentState {
    let owner = Owner::current();
    let document = signal(Projection::default());
    let source = signal(None::<Request>);
    let failure = signal(None::<SharedString>);
    effect(move || scope.emit(TextViewEvent::ParseError(failure.get())));
    let shown = stored(None::<Request>);
    let work = stored(Work::default());
    effect(move || {
        let request = Request {
            input: if let Some(source) = props.markdown.get() {
                Input::Markdown(source)
            } else if let Some(source) = props.html.get() {
                Input::Html(source)
            } else {
                Input::Document(props.document.get().unwrap_or_default())
            },
            source_id: props.source_id.get(),
            options: props.options.get(),
            extensions: props.extensions.get(),
            plugins: plugins.clone(),
        };
        let (start, replacement) = work.with(|work| {
            if work.latest.as_ref() == Some(&request) {
                return (false, false);
            }
            let replacement = work
                .latest
                .as_ref()
                .is_none_or(|previous| !request.admits(previous));
            work.latest = Some(request.clone());
            work.pending = true;
            if work.running {
                (false, replacement)
            } else {
                work.running = true;
                (true, replacement)
            }
        });
        if shown.with(|old| old.as_ref().is_none_or(|old| !request.admits(old))) {
            document.set(request.literal());
            shown.replace(None);
        }
        if replacement {
            source.set(Some(request.clone()));
        }
        failure.set(None);
        if start {
            owner.run(move || {
                spawn(worker(owner, work, shown, document, failure));
            });
        }
    });
    DocumentState { document, source }
}
async fn worker(
    owner: Owner,
    work: Stored<Work>,
    shown: Stored<Option<Request>>,
    document: Signal<Projection>,
    failure: Signal<Option<SharedString>>,
) {
    loop {
        let request = work.with(|work| {
            if !work.pending {
                work.running = false;
                None
            } else {
                work.pending = false;
                work.latest.clone()
            }
        });
        let Some(request) = request else {
            return;
        };
        let captured = request.clone();
        #[cfg(not(target_arch = "wasm32"))]
        let parsed = blocking(move || captured.parse()).await;
        #[cfg(target_arch = "wasm32")]
        let parsed = {
            next_frame().await;
            Ok::<_, String>(captured.parse())
        };
        if !owner.is_live() {
            return;
        }
        match parsed {
            Ok(parsed)
                if work.with(|work| {
                    work.latest
                        .as_ref()
                        .is_some_and(|current| current.admits(&request))
                }) =>
            {
                document.set(parsed);
                shown.replace(Some(request));
                failure.set(None);
            }
            Err(reason) => {
                log::error!("TextView parser worker: {reason}");
                let current = work.with(|work| work.latest.clone());
                if let Some(current) = current
                    && current.admits(&request)
                {
                    document.set(current.literal());
                    shown.replace(None);
                    failure.set(Some(reason.to_string().into()));
                }
            }
            _ => {}
        }
    }
}
