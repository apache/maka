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

//! Asset indexing runs in the Host; page script only observes resource/SVG data.
use super::*;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Resource {
    pub name: Option<String>,
    pub initiator_type: Option<String>,
}
fn path(url: &str) -> String {
    reqwest::Url::parse("https://example.invalid")
        .expect("fixed URL")
        .join(url)
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|_| url.split(['?', '#']).next().unwrap_or("").to_owned())
}
fn kind(url: &str) -> Kind {
    let path = path(url).to_ascii_lowercase();
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "avif" | "gif" | "ico" | "jpg" | "jpeg" | "png" | "svg" | "webp" => Kind::Image,
        "mp4" | "mov" | "m4v" | "webm" => Kind::Video,
        "otf" | "ttf" | "woff" | "woff2" => Kind::Font,
        "css" => Kind::Stylesheet,
        "js" | "mjs" => Kind::Script,
        _ => Kind::Other,
    }
}
fn name(url: &str) -> String {
    let path = path(url);
    let tail = path.split('/').rfind(|part| !part.is_empty());
    let hash = reqwest::Url::parse("https://example.invalid")
        .expect("fixed URL")
        .join(url)
        .ok()
        .and_then(|url| url.fragment().map(str::to_owned))
        .or_else(|| url.split_once('#').map(|(_, hash)| hash.to_owned()));
    match (tail, hash.filter(|hash| !hash.is_empty())) {
        (Some(tail), Some(hash)) => format!("{tail}#{hash}"),
        (Some(tail), None) => tail.into(),
        _ => url.into(),
    }
}
fn resolve(url: &str, base: &str) -> String {
    reqwest::Url::parse(base)
        .and_then(|base| base.join(url))
        .or_else(|_| reqwest::Url::parse(url))
        .map(String::from)
        .unwrap_or_else(|_| url.into())
}
fn js_space(ch: char) -> bool {
    matches!(ch,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn css_urls(mut value: &str) -> Vec<String> {
    let mut result = Vec::new();
    while let Some(start) = value.find("url(") {
        let body = &value[start + 4..];
        let quote = body.chars().next().filter(|ch| matches!(ch, '\'' | '"'));
        let matched = quote
            .and_then(|quote| {
                body[1..]
                    .find(&format!("{quote})"))
                    .map(|end| (&body[1..1 + end], end + 3))
            })
            .or_else(|| body.find(')').map(|end| (&body[..end], end + 1)));
        let Some((url, end)) = matched else { break };
        if url
            .chars()
            .any(|ch| matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
        {
            value = body;
            continue;
        }
        let url = url.trim_matches(js_space);
        if !url.is_empty() {
            result.push(url.into())
        }
        value = &body[end..];
    }
    result
}
fn text(strings: &[Value], index: Option<&Value>) -> String {
    index
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .and_then(|index| strings.get(index))
        .and_then(Value::as_str)
        .unwrap_or("")
        .into()
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn add(
    assets: &mut [Asset],
    indices: &HashMap<String, usize>,
    url: String,
    kind: Kind,
    source: Source,
) {
    if let Some(index) = indices.get(&url) {
        let asset = &mut assets[*index];
        asset.sources.push(source);
        if asset.kind == Kind::Other {
            asset.kind = if kind == Kind::Other {
                self::kind(&url)
            } else {
                kind
            }
        }
    }
}
pub(super) fn assets(snapshot: &Value, resources: Vec<Resource>) -> Vec<Asset> {
    let document = snapshot["documents"]
        .as_array()
        .and_then(|documents| documents.first());
    let mut assets: Vec<Asset> = Vec::new();
    let mut indices: HashMap<String, usize> = HashMap::new();
    for resource in resources {
        let Some(url) = resource.name.filter(|name| !name.is_empty()) else {
            continue;
        };
        let mut kind = kind(&url);
        if kind == Kind::Other {
            kind = match resource.initiator_type.as_deref() {
                Some("css") => Kind::Stylesheet,
                Some("font") => Kind::Font,
                Some("img") => Kind::Image,
                Some("script") => Kind::Script,
                Some("video") => Kind::Video,
                _ => Kind::Other,
            }
        }
        let source = Source {
            kind: "resource".into(),
            node_id: None,
            property: resource.initiator_type,
        };
        if let Some(index) = indices.get(&url).filter(|_| document.is_some()) {
            assets[*index].sources.push(source);
            if assets[*index].kind == Kind::Other && kind != Kind::Other {
                assets[*index].kind = kind
            }
        } else {
            indices.insert(url.clone(), assets.len());
            assets.push(Asset {
                id: short_digest(&url),
                kind,
                name: name(&url),
                sources: vec![source],
                url,
            })
        }
    }
    let Some(document) = document else {
        return assets;
    };
    let strings = array(&snapshot["strings"]);
    let base = text(strings, document.get("documentURL"));
    let nodes = &document["nodes"];
    let ids = array(&nodes["backendNodeId"]);
    for (index, id) in ids.iter().enumerate() {
        let Some(id) = id.as_u64().filter(|id| *id > 0) else {
            continue;
        };
        let tag = text(strings, array(&nodes["nodeName"]).get(index)).to_ascii_lowercase();
        let mut attrs = HashMap::new();
        for pair in array(
            array(&nodes["attributes"])
                .get(index)
                .unwrap_or(&Value::Null),
        )
        .chunks(2)
        {
            let key = text(strings, pair.first());
            if !key.is_empty() {
                attrs.insert(key, text(strings, pair.get(1)));
            }
        }
        let mut attribute = |property: &str, kind: Kind, srcset: bool| {
            let Some(value) = attrs.get(property).filter(|value| !value.is_empty()) else {
                return;
            };
            let urls = if srcset {
                value
                    .split(',')
                    .filter_map(|part| {
                        part.trim_matches(js_space)
                            .split(js_space)
                            .next()
                            .filter(|part| !part.is_empty())
                    })
                    .collect::<Vec<_>>()
            } else {
                vec![value.as_str()]
            };
            for url in urls {
                add(
                    &mut assets,
                    &indices,
                    resolve(url, &base),
                    kind,
                    Source {
                        kind: "attribute".into(),
                        node_id: Some(id),
                        property: Some(property.into()),
                    },
                )
            }
        };
        match tag.as_str() {
            "img" => {
                attribute("src", Kind::Image, false);
                attribute("srcset", Kind::Image, true)
            }
            "source" => {
                attribute("src", Kind::Video, false);
                attribute("srcset", Kind::Image, true)
            }
            "video" => {
                attribute("poster", Kind::Image, false);
                attribute("src", Kind::Video, false)
            }
            "script" => attribute("src", Kind::Script, false),
            "link" => attribute(
                "href",
                if attrs.get("rel").is_some_and(|rel| rel == "stylesheet") {
                    Kind::Stylesheet
                } else {
                    Kind::Other
                },
                false,
            ),
            "use" => {
                attribute("href", Kind::Image, false);
                attribute("xlink:href", Kind::Image, false)
            }
            _ => {}
        }
    }
    let layout = &document["layout"];
    for (index, node) in array(&layout["nodeIndex"]).iter().enumerate() {
        let Some(id) = node
            .as_u64()
            .and_then(|node| usize::try_from(node).ok())
            .and_then(|node| ids.get(node))
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
        else {
            continue;
        };
        let styles = array(array(&layout["styles"]).get(index).unwrap_or(&Value::Null));
        for (column, property) in STYLES.iter().enumerate() {
            for url in css_urls(&text(strings, styles.get(column))) {
                add(
                    &mut assets,
                    &indices,
                    resolve(&url, &base),
                    Kind::Image,
                    Source {
                        kind: "computedStyle".into(),
                        node_id: Some(id),
                        property: Some((*property).into()),
                    },
                );
            }
        }
    }
    assets
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loaded_dom_sources_and_order_match_selected_source_fixture() {
        let snapshot = json!({"strings":["https://fixture.test/page","IMG","src","/seen.png","srcset","/seen.png 1x, /unloaded.png 2x","url(\"/seen.png\")","url(\"/unloaded.png\")"],"documents":[{"documentURL":0,"nodes":{"backendNodeId":[8],"nodeName":[1],"attributes":[[2,3,4,5]]},"layout":{"nodeIndex":[0],"styles":[[6,7]]}}]});
        let resources = vec![
            Resource {
                name: Some("https://fixture.test/seen.png".into()),
                initiator_type: Some("img".into()),
            },
            Resource {
                name: Some("https://fixture.test/seen.png".into()),
                initiator_type: Some("fetch".into()),
            },
        ];
        let actual = assets(&snapshot, resources);
        assert_eq!(actual.len(), 1);
        assert_eq!(actual[0].sources.len(), 5);
        assert_eq!(actual[0].kind, Kind::Image);
        assert_eq!(actual[0].id, short_digest("https://fixture.test/seen.png"));
        assert_eq!(actual[0].sources[2].property.as_deref(), Some("src"));
        assert_eq!(actual[0].sources[4].kind, "computedStyle");
    }
    #[test]
    fn no_document_keeps_repeated_rows_and_kind_name_rules() {
        let actual = assets(
            &json!({"documents":[]}),
            vec![
                Resource {
                    name: Some("https://fixture.test/a.svg#icon".into()),
                    initiator_type: Some("fetch".into()),
                },
                Resource {
                    name: Some("https://fixture.test/a.svg#icon".into()),
                    initiator_type: Some("img".into()),
                },
            ],
        );
        assert_eq!(actual.len(), 2);
        assert_eq!(actual[0].name, "a.svg#icon");
        assert_eq!(actual[1].sources.len(), 1);
        assert_eq!(kind("https://fixture.test/a.MJS?cache=1"), Kind::Script);
    }
}
