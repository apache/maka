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
