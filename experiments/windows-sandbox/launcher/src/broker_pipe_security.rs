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

const PIPE_PREFIX: &str = r"\\.\pipe\maka-sandbox-";

pub fn validate_pipe_name(name: &str) -> Result<(), PipeSecurityError> {
    let suffix = name
        .strip_prefix(PIPE_PREFIX)
        .ok_or(PipeSecurityError::InvalidPipeName)?;
    if suffix.is_empty()
        || suffix.len() > 64
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(PipeSecurityError::InvalidPipeName);
    }
    Ok(())
}

pub fn validate_account_sid(sid: &str) -> Result<(), PipeSecurityError> {
    let components = sid
        .strip_prefix("S-1-")
        .ok_or(PipeSecurityError::InvalidAccountSid)?
        .split('-')
        .collect::<Vec<_>>();
    let user_sid_shape = matches!(components.as_slice(), ["5", "21", _, _, _, _])
        || matches!(components.as_slice(), ["12", "1", _, _, _, _]);
    if !user_sid_shape
        || components.iter().any(|component| {
            component.is_empty()
                || component.len() > 10
                || !component.bytes().all(|byte| byte.is_ascii_digit())
        })
        || components
            .last()
            .and_then(|component| component.parse::<u32>().ok())
            == Some(0)
    {
        return Err(PipeSecurityError::InvalidAccountSid);
    }
    Ok(())
}

pub fn pipe_security_sddl(account_sid: &str) -> Result<String, PipeSecurityError> {
    validate_account_sid(account_sid)?;
    Ok(format!("D:P(A;;GA;;;SY)(A;;GA;;;{account_sid})"))
}

#[derive(Debug, Eq, PartialEq)]
pub enum PipeSecurityError {
    InvalidPipeName,
    InvalidAccountSid,
}
