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

//! Interface copy of the screen the window shows in place of the task view
//! when no connection attempt can succeed until a person changes something
//! outside the app: a Runtime Host of another protocol epoch, or no built
//! Maka checkout to start one from. Maka Desktop has no such screen (it
//! ships its own Host), so the wording is this client's; the terms follow
//! Desktop's ("Runtime Host", 客户端 / 用戶端, 源码目录 / 原始碼目錄 as the
//! About page says it, 协议 epoch / 協定 epoch). Same rules as the parent
//! module. The shell commands it shows are not translated.

use std::path::Path;

use super::Locale;

texts! {
    // Titles: which side is newer, or what is missing.
    HOST_OLDER_TITLE =
        "The Runtime Host is older than this client",
        "Runtime Host 版本比此客户端旧",
        "Runtime Host 版本比此用戶端舊";
    HOST_NEWER_TITLE =
        "The Runtime Host is newer than this client",
        "Runtime Host 版本比此客户端新",
        "Runtime Host 版本比此用戶端新";
    CHECKOUT_MISSING_TITLE =
        "No Maka checkout to start a Runtime Host from",
        "没有可用于启动 Runtime Host 的 Maka 源码目录",
        "沒有可用於啟動 Runtime Host 的 Maka 原始碼目錄";
    CHECKOUT_UNBUILT_TITLE =
        "The Maka checkout isn’t built",
        "Maka 源码目录尚未构建",
        "Maka 原始碼目錄尚未建置";

    // The line under the title.
    EPOCH_SUMMARY =
        "The two speak different protocol epochs, so the Host refuses every request from this \
         client.",
        "两者的协议 epoch 不同，Host 会拒绝此客户端的所有请求。",
        "兩者的協定 epoch 不同，Host 會拒絕此用戶端的所有請求。";
    CHECKOUT_SUMMARY =
        "This client starts its Runtime Host from a Maka checkout at the commit in MAKA_PIN.",
        "此客户端从 Maka 源码目录启动 Runtime Host，该目录需位于 MAKA_PIN 中的提交。",
        "此用戶端從 Maka 原始碼目錄啟動 Runtime Host，該目錄需位於 MAKA_PIN 中的提交。";

    // The facts, as label and value rows.
    CLIENT_LABEL = "This client", "此客户端", "此用戶端";
    HOST_LABEL = "Runtime Host", "当前 Runtime Host", "目前 Runtime Host";
    PIN_LABEL = "Built for", "构建时对应的提交", "建置時對應的提交";
    CHECKOUT_LABEL = "Maka checkout", "Maka 源码目录", "Maka 原始碼目錄";
    /// A protocol epoch, the value of the first two rows.
    EPOCH_VALUE = "Protocol epoch {epoch}", "协议 epoch {epoch}", "協定 epoch {epoch}";
    /// Under the pinned commit: what it is and where it comes from.
    PIN_DETAIL =
        "The apache/maka commit in MAKA_PIN",
        "MAKA_PIN 中的 apache/maka 提交",
        "MAKA_PIN 中的 apache/maka 提交";
    /// Where the checkout path came from.
    CHECKOUT_FROM_ENVIRONMENT = "Set by MAKA_REPO", "由 MAKA_REPO 指定", "由 MAKA_REPO 指定";
    CHECKOUT_DEFAULT =
        "The default; set MAKA_REPO to use another checkout",
        "默认位置；设置 MAKA_REPO 可改用其他目录",
        "預設位置；設定 MAKA_REPO 可改用其他目錄";

    // What to do, above the commands that do it.
    UPDATE_HOST_STEPS =
        "Update the Maka checkout or Maka CLI that runs the Host to the commit in MAKA_PIN and \
         build it, then retry. For the checkout:",
        "请将运行 Host 的 Maka 源码目录或 Maka CLI 更新到 MAKA_PIN 中的提交并重新构建，然后重试。源码目录可执行：",
        "請將執行 Host 的 Maka 原始碼目錄或 Maka CLI 更新至 MAKA_PIN 中的提交並重新建置，然後重試。原始碼目錄可執行：";
    UPDATE_CLIENT_STEPS =
        "Update this client to a build for protocol epoch {epoch}, or run a Host built from the \
         commit in MAKA_PIN, then retry. For the checkout:",
        "请将此客户端更新到支持协议 epoch {epoch} 的版本，或改用由 MAKA_PIN 中的提交构建的 Host，然后重试。源码目录可执行：",
        "請將此用戶端更新至支援協定 epoch {epoch} 的版本，或改用由 MAKA_PIN 中的提交建置的 Host，然後重試。原始碼目錄可執行：";
    CHECKOUT_MISSING_STEPS =
        "Nothing is at {path}. Clone apache/maka there, check out the pinned commit and build it, \
         then retry:",
        "{path} 不存在。请在此克隆 apache/maka，切换到固定的提交并构建，然后重试：",
        "{path} 不存在。請在此複製 apache/maka，切換至固定的提交並建置，然後重試：";
    CHECKOUT_UNBUILT_STEPS =
        "{path} has no built Runtime Host. Build it, then retry:",
        "{path} 中没有已构建的 Runtime Host。请先构建，然后重试：",
        "{path} 中沒有已建置的 Runtime Host。請先建置，然後重試：";
    /// The copy button beside the commands.
    COPY_COMMANDS = "Copy commands", "复制命令", "複製命令";

    // Whether the Host that refused can be replaced, from its answer.
    HOST_EXITS_WHEN_IDLE =
        "The Host that answered stops by itself once it is idle; a retry after that starts one \
         from the checkout.",
        "已应答的 Host 空闲后会自行退出；之后重试会从源码目录启动新的 Host。",
        "已回應的 Host 閒置後會自行結束；之後重試會從原始碼目錄啟動新的 Host。";
    HOST_KEEPS_RUNNING =
        "The Host that answered keeps running: it runs as a service or has work in progress. \
         Stop it before you retry.",
        "已应答的 Host 会继续运行：它以服务方式运行，或仍有进行中的工作。请先停止它再重试。",
        "已回應的 Host 會繼續執行：它以服務方式執行，或仍有進行中的工作。請先停止它再重試。";
}

/// The epoch row's value.
pub fn epoch_value(locale: Locale, epoch: u32) -> String {
    EPOCH_VALUE.fill(locale, &[("epoch", &epoch.to_string())])
}

/// What to do when the Host is newer and speaks `epoch`.
pub fn update_client_steps(locale: Locale, epoch: u32) -> String {
    UPDATE_CLIENT_STEPS.fill(locale, &[("epoch", &epoch.to_string())])
}

/// What to do when nothing is at `path`, or it was not built.
pub fn checkout_steps(locale: Locale, path: &Path, exists: bool) -> String {
    let text = if exists { CHECKOUT_UNBUILT_STEPS } else { CHECKOUT_MISSING_STEPS };
    text.fill(locale, &[("path", &path.display().to_string())])
}

/// The URL `docs/dev-host.md` clones Maka from.
const MAKA_REPOSITORY: &str = "https://github.com/apache/maka.git";

/// The build steps of `docs/dev-host.md` (Prerequisites), run in the
/// checkout at `checkout`: Node 24.18 through nvm, then the packages the
/// Host loads, then the CLI.
const BUILD_STEPS: &str = "source ~/.nvm/nvm.sh && nvm use 24.18\n\
     npm --workspace maka-agent run build:workspace-deps\n\
     npm --workspace maka-agent run build";

/// `path` as one shell word: quoted when it holds anything but the
/// characters a path usually has.
fn shell_word(path: &Path) -> String {
    let text = path.display().to_string();
    let plain = text.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+~@%:,".contains(c));
    if plain && !text.is_empty() { text } else { format!("'{}'", text.replace('\'', r"'\''")) }
}

/// Builds the checkout at `checkout` as it stands (`docs/dev-host.md`).
pub fn build_commands(checkout: &Path) -> String {
    format!("cd {}\n{BUILD_STEPS}", shell_word(checkout))
}

/// Moves the checkout at `checkout` to `commit`, installs what that commit
/// locks, and builds it.
pub fn pin_commands(checkout: &Path, commit: &str) -> String {
    format!(
        "cd {}\ngit fetch && git checkout --detach {commit}\nnpm ci\n{BUILD_STEPS}",
        shell_word(checkout)
    )
}

/// Clones Maka to `checkout` at `commit` and builds it.
pub fn clone_commands(checkout: &Path, commit: &str) -> String {
    let checkout = shell_word(checkout);
    format!(
        "git clone {MAKA_REPOSITORY} {checkout}\ncd {checkout}\ngit checkout --detach {commit}\n\
         npm ci\n{BUILD_STEPS}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT: &str = "de4fc5ff95b1f8034ca00b448984b31ca711dce1";

    #[test]
    fn the_commands_are_the_ones_dev_host_documents() {
        let checkout = Path::new("/Users/me/code/maka-pin");
        assert_eq!(
            build_commands(checkout),
            "cd /Users/me/code/maka-pin\nsource ~/.nvm/nvm.sh && nvm use 24.18\n\
             npm --workspace maka-agent run build:workspace-deps\n\
             npm --workspace maka-agent run build"
        );
        let pin = pin_commands(checkout, COMMIT);
        assert!(pin.contains(&format!("git fetch && git checkout --detach {COMMIT}\nnpm ci\n")));
        assert!(pin.ends_with("npm --workspace maka-agent run build"));
        let clone = clone_commands(checkout, COMMIT);
        assert!(clone.starts_with(
            "git clone https://github.com/apache/maka.git /Users/me/code/maka-pin\n\
             cd /Users/me/code/maka-pin\n"
        ));
        assert!(clone.contains(&format!("git checkout --detach {COMMIT}\nnpm ci\n")));
    }

    #[test]
    fn a_path_with_spaces_or_quotes_stays_one_shell_word() {
        assert_eq!(shell_word(Path::new("/tmp/My Maka")), "'/tmp/My Maka'");
        assert_eq!(shell_word(Path::new("/tmp/it's")), r"'/tmp/it'\''s'");
        assert!(build_commands(Path::new("/tmp/My Maka")).starts_with("cd '/tmp/My Maka'\n"));
    }

    #[test]
    fn the_steps_name_what_is_missing() {
        let path = Path::new("/Users/me/code/maka-pin");
        let en = Locale::English;
        assert!(
            checkout_steps(en, path, false).starts_with("Nothing is at /Users/me/code/maka-pin.")
        );
        assert!(checkout_steps(en, path, true).starts_with("/Users/me/code/maka-pin has no built"));
        assert_eq!(epoch_value(en, 197), "Protocol epoch 197");
        assert!(update_client_steps(Locale::SimplifiedChinese, 198).contains("epoch 198"));
    }
}
