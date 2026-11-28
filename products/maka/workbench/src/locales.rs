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

fn decode(frame: &[u8]) -> String {
    String::from_utf8(zstd::decode_all(frame).expect("bundled workbench locale frame"))
        .expect("bundled workbench locale JSON")
}

pub(crate) fn read(locale: &str) -> Option<String> {
    let frame: &[u8] = match locale {
        "zh-CN" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/zh-CN.json.zst")),
        "zh-TW" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/zh-TW.json.zst")),
        "zh-HK" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/zh-HK.json.zst")),
        "ja" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/ja.json.zst")),
        "ko" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/ko.json.zst")),
        "es" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/es.json.zst")),
        "fr" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/fr.json.zst")),
        "de" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/de.json.zst")),
        "pt-BR" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/pt-BR.json.zst")),
        "ru" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/ru.json.zst")),
        "it" => include_bytes!(concat!(env!("OUT_DIR"), "/locales/it.json.zst")),
        _ => return None,
    };
    Some(decode(frame))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_non_english_locales_decode_to_valid_json() {
        for tag in [
            "zh-CN", "zh-TW", "zh-HK", "ja", "ko", "es", "fr", "de", "pt-BR", "ru", "it",
        ] {
            let raw = read(tag).expect(tag);
            let parsed: serde_json::Value = serde_json::from_str(&raw).expect(tag);
            assert!(parsed.is_object(), "{tag} must be a JSON object");
        }
        assert!(read("en").is_none());
        assert!(read("unknown").is_none());
    }
}
