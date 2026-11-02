//! Regression coverage for the OS module generated from the core runtime registry.
#[cfg(test)]
mod tests {
    #[test]
    fn metadata_has_exact_exports_and_native_values() {
        let host = crate::Host::new().unwrap();
        host.eval_source(
            r#"
            import os, {platform, arch, EOL, homedir} from 'os';
            globalThis.osProjectionMatches = os.platform === platform
                && os.arch === arch && os.homedir === homedir && os.EOL === EOL
                && Object.keys(os).sort().join(',') === 'EOL,arch,homedir,platform';
            globalThis.osPlatform = platform();
            globalThis.osArch = arch();
            globalThis.osEol = EOL;
        "#,
        )
        .unwrap();
        assert!(
            host.eval_script("os-projection", "osProjectionMatches")
                .unwrap()
        );
        assert!(
            host.eval_script(
                "os-native-platform",
                &format!("osPlatform === {:?}", std::env::consts::OS)
            )
            .unwrap()
        );
        assert!(
            host.eval_script(
                "os-native-arch",
                &format!("osArch === {:?}", std::env::consts::ARCH)
            )
            .unwrap()
        );
        assert!(
            host.eval_script(
                "os-native-eol",
                &format!("osEol === {:?}", if cfg!(windows) { "\r\n" } else { "\n" })
            )
            .unwrap()
        );
    }
    #[test]
    fn home_metadata_does_not_grant_file_access() {
        let host = crate::Host::new().unwrap();
        host.eval_source("import os from 'os'; import process from 'process'; globalThis.metadataMatches = os.platform() === process.platform && os.arch() === process.arch; globalThis.homeIsMetadata = typeof os.homedir() === 'string'; globalThis.os = os;").unwrap();
        assert!(
            host.eval_script("metadata", "metadataMatches && homeIsMetadata")
                .unwrap()
        );
        host.eval_source("import fs from 'fs/promises'; globalThis.homeReadDenied = false; fs.readdir(os.homedir()).catch(e => globalThis.homeReadDenied = e.code === 'ERR_ACCESS_DENIED' && e.permission === 'fs');").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !host
            .eval_script("denied-home-read", "homeReadDenied === true")
            .unwrap()
        {
            assert!(std::time::Instant::now() < deadline);
            host.run_system();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
}
