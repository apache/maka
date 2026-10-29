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

//! Typed values for the two effective browser capabilities.
use serde::{Deserialize, Serialize};
#[cfg(feature = "native-desktop")]
use std::collections::BTreeMap;

#[cfg(feature = "native-desktop")]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Font,
    Image,
    Other,
    Script,
    Stylesheet,
    Video,
}
#[cfg(feature = "native-desktop")]
impl Kind {
    pub(crate) fn bundleable(self) -> bool {
        matches!(
            self,
            Self::Font | Self::Image | Self::Stylesheet | Self::Video
        )
    }
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property: Option<String>,
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Asset {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub sources: Vec<Source>,
    pub url: String,
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct InlineSvg {
    pub id: String,
    pub markup: String,
    pub name: String,
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub by_kind: BTreeMap<Kind, usize>,
    pub inline_svg_count: usize,
    pub total_count: usize,
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inventory {
    pub assets: Vec<Asset>,
    pub id: String,
    pub inline_svgs: Vec<InlineSvg>,
    pub page_url: Option<String>,
    pub summary: Summary,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleOptions {
    pub inventory_id: String,
    #[serde(
        default,
        deserialize_with = "optional_array",
        skip_serializing_if = "Option::is_none"
    )]
    pub asset_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "optional_array",
        skip_serializing_if = "Option::is_none"
    )]
    pub kinds: Option<Vec<BundleKind>>,
}
fn optional_array<'de, D, T>(deserializer: D) -> Result<Option<Vec<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Vec::<T>::deserialize(deserializer).map(Some)
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BundleKind {
    Font,
    Image,
    Stylesheet,
    Video,
}
#[cfg(feature = "native-desktop")]
impl BundleKind {
    pub(crate) fn kind(self) -> Kind {
        match self {
            Self::Font => Kind::Font,
            Self::Image => Kind::Image,
            Self::Stylesheet => Kind::Stylesheet,
            Self::Video => Kind::Video,
        }
    }
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BundledAsset {
    pub content_type: Option<String>,
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub path: String,
    pub url: String,
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    pub content_type: Option<String>,
    pub id: String,
    pub name: String,
    pub reason: String,
    pub url: String,
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BundleSummary {
    pub downloaded_count: usize,
    pub elapsed_ms: f64,
    pub failed_count: usize,
    pub requested_count: usize,
}
#[cfg(feature = "native-desktop")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bundle {
    pub assets: Vec<BundledAsset>,
    pub directory_path: String,
    pub failures: Vec<Failure>,
    pub manifest_path: String,
    pub summary: BundleSummary,
}

/// JSON numbers retain the Original positive safe-integer domain until Chrome
/// applies its own device-metrics constraints. No invented u16/u32 dimension cap.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
}
#[cfg(feature = "native-desktop")]
impl Viewport {
    pub(crate) fn validate(self) -> Result<Self, &'static str> {
        let valid =
            |n: f64| n.is_finite() && n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0;
        if valid(self.width) && valid(self.height) {
            Ok(self)
        } else {
            Err("Viewport width and height must be positive safe integers")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_selection_is_default_but_null_is_not_a_selection() {
        let options: BundleOptions =
            serde_json::from_value(serde_json::json!({"inventoryId":"observed"})).unwrap();
        assert!(options.asset_ids.is_none());
        assert!(options.kinds.is_none());
        assert!(
            serde_json::from_value::<BundleOptions>(
                serde_json::json!({"inventoryId":"observed","assetIds":null})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<BundleOptions>(
                serde_json::json!({"inventoryId":"observed","kinds":null})
            )
            .is_err()
        );
        let options: BundleOptions = serde_json::from_value(
            serde_json::json!({"inventoryId":"observed","assetIds":[],"kinds":[]}),
        )
        .unwrap();
        assert_eq!(options.asset_ids.unwrap().len(), 0);
        assert_eq!(options.kinds.unwrap().len(), 0);
    }
}
