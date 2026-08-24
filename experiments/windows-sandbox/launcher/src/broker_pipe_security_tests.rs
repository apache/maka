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

#[cfg(test)]
mod tests {
    use crate::broker_pipe_security::{
        PipeSecurityError, pipe_security_sddl, validate_account_sid, validate_pipe_name,
    };

    #[test]
    fn accepts_only_private_maka_pipe_namespace() {
        assert_eq!(
            validate_pipe_name(r"\\.\pipe\maka-sandbox-session_42"),
            Ok(())
        );
        assert_eq!(
            validate_pipe_name(r"\\.\pipe\other-session"),
            Err(PipeSecurityError::InvalidPipeName)
        );
        assert_eq!(
            validate_pipe_name(r"\\server\pipe\maka-sandbox-session"),
            Err(PipeSecurityError::InvalidPipeName)
        );
        assert_eq!(
            validate_pipe_name(r"\\.\pipe\maka-sandbox-..\escape"),
            Err(PipeSecurityError::InvalidPipeName)
        );
    }

    #[test]
    fn accepts_canonical_numeric_account_sid() {
        assert_eq!(validate_account_sid("S-1-5-21-1-2-3-1001"), Ok(()));
        assert_eq!(
            validate_account_sid("BA"),
            Err(PipeSecurityError::InvalidAccountSid)
        );
        assert_eq!(
            validate_account_sid("S-1-5-21-user"),
            Err(PipeSecurityError::InvalidAccountSid)
        );
        assert_eq!(
            validate_account_sid("S-1-1-0"),
            Err(PipeSecurityError::InvalidAccountSid)
        );
        assert_eq!(validate_account_sid("S-1-12-1-1-2-3-4"), Ok(()));
    }

    #[test]
    fn creates_protected_system_and_user_only_dacl() {
        assert_eq!(
            pipe_security_sddl("S-1-5-21-1-2-3-1001"),
            Ok("D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-1-2-3-1001)".to_owned())
        );
    }
}
