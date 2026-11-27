//! `nsh check` says what an app's `nsh.json` is ignored or refused, as the
//! commands that build or run the app do reading it.

use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn check_warns_of_nsh_json_it_ignores() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = Directory(std::env::temp_dir().join(format!("nsh-cli-check-{}", std::process::id())));
    let root = &dir.0;
    fs::create_dir_all(root).unwrap();
    // One key of a newer NSH, and one where a key's shape is wrong: both
    // are warned, as `nsh test` of the same app does.
    fs::write(
        root.join("nsh.json"),
        r##"{
            "window": { "width": 1000, "defaultSize": { "width": 1000, "height": 700 } },
            "futureKey": true
        }"##,
    )
    .unwrap();
    fs::write(
        root.join("App.tsx"),
        "import { mount, Text } from 'nsh'; mount(() => <Text>Hello</Text>);",
    )
    .unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    // The type check itself is not this test's subject: a `tsc` that passes.
    let tsc = root.join("tsc");
    fs::write(&tsc, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&tsc, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nsh"))
        .args(["check", "--tsc"])
        .arg(&tsc)
        .arg(root)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{stderr}{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(stderr.contains(r#"unknown key "width""#), "{stderr}");
    assert!(stderr.contains("unknown key `futureKey`"), "{stderr}");
}

#[test]
fn check_typechecks_translations_from_locales() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = Directory(std::env::temp_dir().join(format!(
        "nsh-cli-i18n-typed-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    let root = &dir.0;
    fs::create_dir_all(root.join("locales")).unwrap();
    fs::write(root.join("nsh.json"), "{\n  \"name\": \"I18nTest\"\n}\n").unwrap();
    fs::write(
        root.join("tsconfig.json"),
        "{\n  \"extends\": \"./.nsh/tsconfig.json\",\n  \"include\": [\"**/*.ts\", \"**/*.tsx\"]\n}\n",
    )
    .unwrap();
    fs::write(
        root.join("locales/app.yml"),
        "_version: 2\nhello:\n  en: Hello\n  zh-CN: 你好\nmessages.hello:\n  en: \"Hello, %{name}!\"\n  zh-CN: \"你好，%{name}！\"\nstatus.ok:\n  en: Ready\nstatus.err:\n  en: Failed\n",
    )
    .unwrap();
    fs::write(
        root.join("App.tsx"),
        r#"import { mount, Text } from "nsh";
import { type LocaleTag, type TranslationKey, addTranslations, setLocale, t } from "nsh/i18n";

const status: "ok" | "err" = "ok";
const typedKey: TranslationKey = "hello";
const dynamicKey: string = "hello";
const knownLocale: LocaleTag = "zh-CN";
const customLocale: string | null = "en-US";
const tDynamic = t as (key: string, options?: { locale?: LocaleTag; [name: string]: unknown }) => string;

addTranslations({ fr: { extra: "Bonjour %{who}" } });
setLocale(knownLocale);
setLocale("fr");
setLocale(null);
setLocale(customLocale);

const valid = [
  t("hello"),
  t("hello", { locale: "zh-CN" }),
  t("hello", { locale: "fr" }),
  t("messages.hello", { name: "Ada" }),
  t("messages.hello", { name: 42, locale: "en" }),
  t(`status.${status}`),
  t(typedKey),
  t(dynamicKey as TranslationKey),
  tDynamic("extra", { who: "Ada" }),
];

// @ts-expect-error unknown key
t("missing.key");
// @ts-expect-error missing required %{name} parameter
t("messages.hello");
// @ts-expect-error wrong parameter name
t("messages.hello", { wrong: "Ada" });
// @ts-expect-error unexpected parameter on parameterless key
t("hello", { extra: 1 });
// @ts-expect-error plain string variable requires TranslationKey or cast
t(dynamicKey);

mount(() => <Text>{valid.join(" ")}</Text>);
"#,
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_nsh"))
        .args(["check"])
        .arg(root)
        .args(["--", "--skipLibCheck", "false"])
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stderr}\n{stdout}");
}

#[test]
fn check_keeps_t_permissive_without_locales() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = Directory(std::env::temp_dir().join(format!(
        "nsh-cli-i18n-empty-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    let root = &dir.0;
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("nsh.json"), "{\n  \"name\": \"NoLocales\"\n}\n").unwrap();
    fs::write(
        root.join("tsconfig.json"),
        "{\n  \"extends\": \"./.nsh/tsconfig.json\",\n  \"include\": [\"**/*.ts\", \"**/*.tsx\"]\n}\n",
    )
    .unwrap();
    fs::write(
        root.join("App.tsx"),
        r#"import { mount, Text } from "nsh";
import { setLocale, t } from "nsh/i18n";

const dynamicKey: string = "anything";
setLocale("en");

mount(() => (
  <Text>
    {t("anything")}
    {t("anything", { count: 1, locale: "en" })}
    {t(dynamicKey)}
  </Text>
));
"#,
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_nsh"))
        .args(["check"])
        .arg(root)
        .args(["--", "--skipLibCheck", "false"])
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stderr}\n{stdout}");
}

#[test]
fn check_warns_of_inconsistent_locales() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = Directory(std::env::temp_dir().join(format!(
        "nsh-cli-i18n-warn-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    let root = &dir.0;
    fs::create_dir_all(root.join("locales")).unwrap();
    fs::write(root.join("nsh.json"), "{\n  \"name\": \"I18nWarn\"\n}\n").unwrap();
    fs::write(
        root.join("App.tsx"),
        "import { mount, Text } from 'nsh'; mount(() => <Text>Hello</Text>);",
    )
    .unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(
        root.join("locales/en.yml"),
        "hello: Hello\nbye: Goodbye\ngreet: \"Hello, %{name}!\"\n",
    )
    .unwrap();
    fs::write(
        root.join("locales/zh.yml"),
        "hello: 你好\ngreet: \"你好，%{user}！\"\n",
    )
    .unwrap();
    fs::write(
        root.join("locales/zh-TW.yml"),
        "hello: 哈囉\ngreet: \"你好！\"\n",
    )
    .unwrap();

    let tsc = root.join("tsc");
    fs::write(&tsc, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&tsc, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nsh"))
        .args(["check", "--tsc"])
        .arg(&tsc)
        .arg(root)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{stderr}{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        stderr.contains("locales: `zh` is missing 1 key: \"bye\""),
        "{stderr}"
    );
    assert!(
        stderr.contains(
            "locales: `zh` key \"greet\" has placeholders `%{user}` (expected `%{name}` from `en`)"
        ),
        "{stderr}"
    );
    assert!(
        stderr.contains(
            "locales: `zh-TW` key \"greet\" has placeholders none (expected `%{name}` from `en`)"
        ),
        "{stderr}"
    );
    assert!(!stderr.contains("`zh-TW` is missing"), "{stderr}");
}
