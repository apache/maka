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

use super::{CallbackError, Context, Operation, Services, acp, call, check_path};
use maka_runtime::read::{ReadInput, ReadPage};
use std::num::NonZeroUsize;

const MAX_TEXT_BYTES: usize = 512 * 1024;

pub(super) async fn text(
    input: acp::ReadTextFileRequest,
    context: &Context,
    host: &Services,
) -> Result<String, CallbackError> {
    if input.line == Some(0) || input.limit == Some(0) {
        return Err(CallbackError::invalid("Line and limit must be positive"));
    }
    let original_path = check_path(&input.path)?.to_owned();
    let mut next = ReadInput {
        path: original_path.clone(),
        offset: input.line.map(|line| (line - 1) as usize),
        limit: input
            .limit
            .and_then(|limit| NonZeroUsize::new(limit as usize)),
    };
    let mut content = String::new();
    loop {
        if context.cancellation.is_cancelled() {
            return Err(CallbackError::host("File read cancelled"));
        }
        // Continuations carry content identity, never authority. Host reauthorizes every page.
        if next.resolve().map_err(CallbackError::host)?.path() != original_path {
            return Err(CallbackError::host("Read continuation changed its target"));
        }
        let output = host
            .files
            .invoke(call(context)?, Operation::Read(next.clone()))
            .await
            .map_err(CallbackError::host)?;
        let page: ReadPage =
            serde_json::from_value(output.into_json()).map_err(CallbackError::host)?;
        append(&mut content, &page)?;
        match page.next {
            Some(continuation) if continuation != next => next = continuation,
            Some(_) => return Err(CallbackError::host("Read continuation made no progress")),
            None => return Ok(content),
        }
    }
}

fn append(content: &mut String, page: &ReadPage) -> Result<(), CallbackError> {
    // A page ending before a newline omits that separator from content and its
    // continuation. partial_line also describes the start, so cannot identify this boundary.
    let separator = page.next.is_some()
        && page.returned_lines > page.content.bytes().filter(|byte| *byte == b'\n').count();
    if content.len() + page.content.len() + usize::from(separator) > MAX_TEXT_BYTES {
        return Err(CallbackError::host(
            "Requested text exceeds the 512 KiB callback limit",
        ));
    }
    content.push_str(&page.content);
    if separator {
        content.push('\n');
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reassembles_line_boundaries_and_lines_split_across_pages() {
        let text = format!("first\n{}\nlast\n", "界".repeat(2000));
        let mut input = ReadInput {
            path: "/file".into(),
            offset: None,
            limit: None,
        };
        let mut result = String::new();
        loop {
            let page = input
                .resolve()
                .unwrap()
                .page_with_budget(&text, 500)
                .unwrap();
            append(&mut result, &page).unwrap();
            match page.next {
                Some(next) => input = next,
                None => break,
            }
        }
        assert_eq!(result, text);
    }

    #[test]
    fn rejects_oversize_instead_of_returning_truncated_success() {
        let page = ReadInput {
            path: "/file".into(),
            offset: None,
            limit: None,
        }
        .resolve()
        .unwrap()
        .page("last")
        .unwrap();
        let mut content = "x".repeat(MAX_TEXT_BYTES - 2);
        assert!(append(&mut content, &page).is_err());
        assert_eq!(content.len(), MAX_TEXT_BYTES - 2);
    }
}
