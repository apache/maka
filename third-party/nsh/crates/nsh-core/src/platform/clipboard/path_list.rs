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

//! Shell-quoted terminal file paths become the same rich payload as native file drops.

/// Recognizes a complete list of absolute POSIX, Windows or file-URI paths.
/// Returns their file URIs without reading files, expanding shell code or guessing
/// unquoted spaces; ordinary text remains available to the native input editor.
/// Ambiguous POSIX root names need quotes or a file URI to remain distinct from commands.
pub fn files_from_text(text: &str) -> Option<Vec<String>> {
    let text = text.trim();
    let leading = text.trim_start_matches(['\'', '"']);
    if !leading.starts_with('/')
        && !leading.starts_with('\\')
        && !drive_path(leading)
        && !file_uri(leading)
    {
        return None;
    }
    let words = words(text)?;
    (!words.is_empty()).then(|| {
        words
            .into_iter()
            .map(|word| {
                if file_uri(&word) {
                    word
                } else {
                    super::file_url(&word)
                }
            })
            .collect()
    })
}

fn absolute(value: &str, quoted: bool) -> bool {
    value
        .strip_prefix('/')
        .is_some_and(|path| quoted || path.contains('/'))
        || drive_path(value)
        || value.starts_with("\\\\")
        || file_uri(value) && url::Url::parse(value).is_ok()
}

fn file_uri(value: &str) -> bool {
    value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
}

fn drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn words(text: &str) -> Option<Vec<String>> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote = None;
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quote.is_some() || !ch.is_whitespace() {
            started = true;
        }
        if quote.is_none() && file_uri(&word) && !ch.is_whitespace() {
            word.push(ch);
            continue;
        }
        let windows = word.as_bytes().get(1) == Some(&b':')
            && word.as_bytes()[0].is_ascii_alphabetic()
            || word.starts_with("\\\\")
            || word == "\\" && ch == '\\'
            || word.is_empty() && ch == '\\' && chars.peek() == Some(&'\\');
        match (quote, ch) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), ch) => word.push(ch),
            (None, '\'' | '"') => {
                quoted = true;
                quote = Some(ch);
            }
            (_, '\\') if !windows => {
                let next = chars.peek().copied()?;
                if quote.is_none() || matches!(next, '"' | '\\' | '$' | '`' | '\n') {
                    chars.next();
                    if next != '\n' {
                        word.push(next);
                    }
                } else {
                    word.push(ch);
                }
            }
            (None, ch) if ch.is_whitespace() => {
                if started {
                    if !absolute(&word, quoted) {
                        return None;
                    }
                    result.push(std::mem::take(&mut word));
                    started = false;
                    quoted = false;
                }
            }
            (None, ';' | '&' | '|' | '<' | '>' | '(' | ')' | '$' | '`') => return None,
            (_, ch) => word.push(ch),
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        if !absolute(&word, quoted) {
            return None;
        }
        result.push(word);
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_file_pastes_keep_complete_paths_and_leave_ordinary_text_native() {
        assert_eq!(
            files_from_text(r#"'/tmp/a b.png' "/tmp/中.png""#),
            Some(vec![
                "file:///tmp/a%20b.png".into(),
                "file:///tmp/%E4%B8%AD.png".into(),
            ])
        );
        assert_eq!(
            files_from_text(r"/tmp/a\ b.png"),
            Some(vec!["file:///tmp/a%20b.png".into()])
        );
        assert_eq!(
            files_from_text("'/rootfile' file:///rootfile"),
            Some(vec!["file:///rootfile".into(), "file:///rootfile".into()])
        );
        assert_eq!(
            files_from_text(r#""C:\Users\A B\image.png""#),
            Some(vec!["file:///C:/Users/A%20B/image.png".into()])
        );
        assert_eq!(
            files_from_text(r#""\\wsl.localhost\Ubuntu\tmp\a b.png""#),
            Some(vec!["file://wsl.localhost/Ubuntu/tmp/a%20b.png".into()])
        );
        assert_eq!(
            files_from_text(r#""file:///tmp/a%20b.png" file:///tmp/quote's(1).txt"#),
            Some(vec![
                "file:///tmp/a%20b.png".into(),
                "file:///tmp/quote's(1).txt".into(),
            ])
        );
        for text in [
            "ordinary text",
            "/help",
            "/skills",
            "/review foo",
            "'/rootfile' /skills",
            "cat /tmp/a.png",
            "/tmp/a.png please read this",
            "/tmp/a b.png",
            "'/tmp/a.png' && '/tmp/b.png'",
            "'/tmp/a.png' ''",
            "https://example.com/a.png",
        ] {
            assert_eq!(files_from_text(text), None, "native text paste: {text}");
        }
    }
}
