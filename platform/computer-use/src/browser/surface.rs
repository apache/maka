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

//! Public browser collection selection and session surfaces.
//! Selection only chooses a provider; it never claims a tab or retries an action.

use super::*;

fn hierarchy(left: &str, right: &str) -> bool {
    let left = left.to_ascii_lowercase();
    let right = right.to_ascii_lowercase();
    let left = left.trim_end_matches('.');
    let right = right.trim_end_matches('.');
    let (short, long) = if left.len() < right.len() {
        (left, right)
    } else {
        (right, left)
    };
    short.contains('.')
        && short.parse::<std::net::IpAddr>().is_err()
        && long
            .strip_suffix(short)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn url_match(open: &reqwest::Url, wanted: &reqwest::Url, rank: usize) -> bool {
    match rank {
        0 => {
            let mut open = open.clone();
            let mut wanted = wanted.clone();
            open.set_fragment(None);
            wanted.set_fragment(None);
            open == wanted
        }
        1 => open.origin() == wanted.origin() && open.path() == wanted.path(),
        2 => open.host_str() == wanted.host_str(),
        3 => open
            .host_str()
            .zip(wanted.host_str())
            .is_some_and(|(left, right)| hierarchy(left, right)),
        _ => false,
    }
}

impl Browsers {
    pub(super) async fn select_browser(
        &self,
        selection: BrowserSelection,
    ) -> Result<Value, ToolError> {
        let wanted = match selection {
            BrowserSelection::Default => None,
            BrowserSelection::Url { url } => Some(reqwest::Url::parse(&url).map_err(failed)?),
        };
        let mut available = Vec::new();
        let mut failure = None;
        for provider in self.providers(None)? {
            match self.visible_inventory(&provider).await {
                Ok(_) => available.push(provider),
                Err(error) => retain_inventory_error(&mut failure, error),
            }
        }
        if available.is_empty() {
            let mut configured = Vec::new();
            self.append_handoff_candidate(&mut configured).await?;
            if let Some(candidate) = configured.into_iter().next() {
                return Ok(candidate);
            }
            return Err(failure.unwrap_or_else(|| failed("No browser is available")));
        }
        if available.len() == 1 {
            return Ok(available[0].info());
        }
        if let Some(wanted) = wanted {
            // The selected runtime ranks extension tab URLs before falling back.
            // CDP-only connections do not provide user-tab URL preferences.
            let mut candidates = Vec::new();
            for provider in available
                .iter()
                .filter(|provider| provider.extension().is_some())
            {
                let rows =
                    tokio::time::timeout(Duration::from_secs(1), self.user_tabs(provider.id()))
                        .await;
                let urls: Vec<reqwest::Url> = match rows {
                    Ok(Ok(rows)) => rows
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|row| row.get("url").and_then(Value::as_str))
                        .filter_map(|url| reqwest::Url::parse(url).ok())
                        .collect(),
                    _ => Vec::new(),
                };
                candidates.push((provider, urls));
            }
            for rank in 0..4 {
                if let Some((provider, _)) = candidates
                    .iter()
                    .find(|(_, urls)| urls.iter().any(|url| url_match(url, &wanted, rank)))
                {
                    return Ok(provider.info());
                }
            }
        }
        // There is no embedded-browser backend or external-app preference in
        // Maka's current provider set. Among supported types, extension precedes
        // a raw CDP connection and discovery order breaks ties.
        Ok(available
            .iter()
            .find(|provider| provider.extension().is_some())
            .unwrap_or(&available[0])
            .info())
    }

    pub(super) async fn selected_tab(
        &mut self,
        browser_id: &str,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let provider = self
            .providers(Some(browser_id))?
            .pop()
            .expect("selected provider");
        let Some(extension) = provider.extension() else {
            // Raw CDP has no logical-session active tab service. In particular,
            // querying the OS focused tab would change the selected() contract.
            return Ok(Value::Null);
        };
        let generation = extension.identity().generation.clone();
        let (actual_generation, rows) = self.extension_session_metadata(&provider, call).await?;
        if actual_generation != generation {
            return Err(failed("selected browser generation changed"));
        }
        let identity = BrowserIdentity::of(&provider, &generation)?;
        let active = self
            .host()
            .await
            .lock()
            .await
            .logical_active(self.owner, &identity);
        let Some(info) = active.and_then(|id| rows.into_iter().find(|row| row.id == id)) else {
            return Ok(Value::Null);
        };
        self.bind(
            TabSource {
                provider,
                generation,
                info,
            },
            InitialState::Deferred,
            call.invocation,
            call.cancellation,
            call.language,
        )
        .await
    }

    pub(super) async fn user_history(
        &self,
        browser_id: &str,
        options: BrowserHistoryOptions,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        if options.queries.as_ref().is_some_and(Vec::is_empty) {
            return Err(failed(
                "browser_user_history requires queries to be a non-empty array of strings",
            ));
        }
        if options
            .limit
            .is_some_and(|limit| !limit.is_finite() || limit <= 0.0 || limit.fract() != 0.0)
        {
            return Err(failed(
                "browser_user_history requires limit to be a positive integer",
            ));
        }
        self.extension_user_history(browser_id, options, call).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_urls_ignore_fragments_but_keep_search_until_path_rank() {
        let open = reqwest::Url::parse("https://a.example/path?q=old#one").unwrap();
        let fragment = reqwest::Url::parse("https://a.example/path?q=old#two").unwrap();
        let query = reqwest::Url::parse("https://a.example/path?q=new").unwrap();
        assert!(url_match(&open, &fragment, 0));
        assert!(!url_match(&open, &query, 0));
        assert!(url_match(&open, &query, 1));
    }

    #[test]
    fn hierarchy_requires_domain_boundary_and_never_treats_an_ip_as_parent() {
        assert!(hierarchy("EXAMPLE.com.", "docs.example.com"));
        assert!(hierarchy("docs.example.com", "example.com"));
        assert!(!hierarchy("example.com", "notexample.com"));
        assert!(!hierarchy("localhost", "app.localhost"));
        assert!(!hierarchy("127.0.0.1", "docs.127.0.0.1"));
    }
}
