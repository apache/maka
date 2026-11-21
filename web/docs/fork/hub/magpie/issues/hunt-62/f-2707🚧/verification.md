# hunt62 Lane F — #2707 维护者意见返工验证日志

日期：2026-10-22。工作区：/tmp/magpie-r62-f（分支 hunt62-f-2707-review-rework，基线 87d703c5）。
最终提交：`f698e15a820117bc1d52cfd64c5d5d0b27eb6c45`（单提交，父 87d703c5）。

## 0. 维护者三条要求原文（gh issue view 2707 --comments，yetone 10-17）

> **Before it lands as a co-authored commit**
> 1. Write v2 only when the v1 seal would be large (for example near the GitHub limit), so most users stay readable by older versions.
> 2. Return a non-`ErrCorrupt` error when decompression fails, and read the decompressed data through a size-capped reader.
> 3. Word the docs and messages so they don't promise that every library fits GitHub.
>
> With those changes it's ready to land with @ggbdpq as co-author. It isn't landed yet.

## 1. cherry-pick

- `git cherry-pick 95c253e7` → 干净落地，cherry-pick 提交 c5f78f46（6 files changed, 149 insertions, 9 deletions），退出码 0。

## 2. TDD RED（修改前，当前代码=原提交行为）

命令：`go test -tags nogui -count=1 -run 'TestSealStaysVersion1WhenSmall|TestOpenDecompressFailureIsPlain|TestOpenCapsTheDecompression|TestSealCompressesTheLibrary' ./internal/backup`

```
--- FAIL: TestSealStaysVersion1WhenSmall (0.07s)
    backup_test.go:518: a small backup sealed as version 2, want the plain version 1 an older magpie reads
--- FAIL: TestOpenDecompressFailureIsPlain (0.00s)
    backup_test.go:557: a decompression failure read as ErrCorrupt, offered for rebuild: not a magpie backup: the sealed bundle doesn't decompress
--- FAIL: TestOpenCapsTheDecompression (0.58s)
    backup_test.go:576: a 300 MiB bomb: invalid character '\x00' looking for beginning of value, want the cap refusal
FAIL
```

（TestSealCompressesTheLibrary 此时即绿：原实现永远写 v2。）

## 3. TDD GREEN（三点修改实现后）

命令：`go test -tags nogui -count=1 -run 'TestSealStaysVersion1WhenSmall|TestOpenDecompressFailureIsPlain|TestOpenCapsTheDecompression|TestSealCompressesTheLibrary|TestSealDerivesOnce' -v ./internal/backup`

```
--- PASS: TestSealDerivesOnce (0.06s)
--- PASS: TestSealStaysVersion1WhenSmall (0.06s)
--- PASS: TestOpenDecompressFailureIsPlain (0.00s)
--- PASS: TestOpenCapsTheDecompression (0.27s)
--- PASS: TestSealCompressesTheLibrary (1.70s)
ok  	github.com/yetone/magpie/internal/backup	2.464s
```

## 4. 消融（先提交 wip=9a02ac63，基线=分支父提交语义：摘除仅动产品文件、测试保留；恢复用 `git checkout HEAD -- internal/backup/backup.go`）

- ①摘除：`sealLarge = 0`（永走 v2）→ `TestSealStaysVersion1WhenSmall`：
  `--- FAIL: TestSealStaysVersion1WhenSmall (0.06s) / FAIL`；恢复后 `ok github.com/yetone/magpie/internal/backup 0.953s`。
- ②摘除：Open 恢复 `%w ErrCorrupt` 包装 + unzipped 去掉 LimitReader →
  `--- FAIL: TestOpenDecompressFailureIsPlain (0.06s) ... read as ErrCorrupt, offered for rebuild`
  `--- FAIL: TestOpenCapsTheDecompression (0.33s) ... invalid character '\x00' ... want the cap refusal / FAIL`；恢复后 `ok ... 1.040s`。
- ③措辞：无行为面，不做红绿。grep 证明承诺性措辞已移除：
  `grep -rn "so a full library\|full library stays\|fits what GitHub\|within what GitHub takes\|stays within what GitHub" --include="*.go" --include="*.md" internal/ docs/`（排除 _test）
  唯一命中 `docs/subsystems/sync-backup.md:127` 为新保留条款句内部片段（"expected to keep a full library within what GitHub takes, but GitHub's real limit is undocumented…"）。

## 5. 验证矩阵（对最终树=HEAD 树，squash 前后 tree sha 一致）

| 项 | 结果 |
| --- | --- |
| `go test -tags nogui -count=1 ./internal/backup ./internal/davsync` | ok backup 7.459s / davsync 30.674s，exit=0 |
| `go test -tags nogui -count=1 ./internal/library` | ok 63.880s，exit=0（另一轮 72.193s，未复现维护者所见超时） |
| `go test -tags nogui -count=1 ./internal/cli` | ok 29.192s（原 PR 矩阵含此包，补跑） |
| `gofmt -l internal/backup internal/davsync internal/library docs` | 空，exit=0 |
| `GOOS/GOARCH=darwin-arm64, linux-amd64, windows-amd64 go vet -tags nogui ./internal/backup ./internal/davsync ./internal/library` | 三平台各 exit=0 |
| `GOOS/GOARCH=同上 go build -tags nogui -o … .`（main 二进制） | 三平台各 exit=0（darwin 有一条 internal/gui/trayimage_darwin.go 的 cgo -Wenum-conversion 警告，预存、与本单无关） |

插曲：第一轮 vet/build 报 "build constraints exclude all Go files" / "unsupported GOOS/GOARCH pair darwin arm64/arm64"，为 zsh 下 `set -- $pair` 不分词导致 GOOS="darwin arm64" 整串的环境错误；改显式环境变量后三平台全绿。日志：/tmp/magpie-r62-logs/matrix1.log、matrix2.log、matrix3.log。

## 6. 单提交与身份

- `git reset --soft 87d703c5` + `git -c user.name=ggbdpq -c user.email=ggbdpq@gmail.com commit -F <msg>` → `f698e15a`。
- squash 前（9a02ac63^{tree}）与提交后 HEAD^{tree} 相同：tree-same=yes。
- `git log -1` 核验：`author: ggbdpq <ggbdpq@gmail.com>` / `committer: ggbdpq <ggbdpq@gmail.com>`。
- 工作树干净（git status 无未提交项；.testlog 已挪出仓库至 /tmp/magpie-r62-logs）。

## 7. patch 与 git am 实套

- 文件：`docs/issues/hunt62/f-2707/0001-backup-davsync-a-backup-that-would-be-too-big-for-Gi.patch`（format-patch -1 f698e15a）。
- `shasum -a 256` → `78dc37c991ae8512e854b32166f95cfeba52af62f0bbd9e8df2ccd84b0eb0800`（前 16：`78dc37c991ae8512`）。
- 实套验证：临时 detach worktree @87d703c5 → `git am` → `Applying: backup, davsync: …` 成功，结果树 == f698e15a^{tree}（tree-same=yes），worktree 已移除。

## 8. Watched 三查

- 其他写 v2 的点：全仓 grep `Version: 2|Version = 2`，封套层唯一写点即本提交 backup.go:317（Seal 的 v2 分支）；`BundleVersion = 2` 是 bundle 结构版本，非封套版本；`SealData/OpenData`（magpie-data 用量文件）保持 version 1 plain，未动。
- 其他 ErrCorrupt 消费方：davsync.go:1139（重建路径）——解压失败现为普通错误，不再命中 ErrCorrupt，同步直接报错停止，不再走重建/Replace；notbackup.go:121（described）——普通错误原样透传，不再包成 notBackup（restore.go:150 因此不允许 Upload 覆写）。ErrPassphrase 消费方（usage.go:295、davsync.go:1114、restore.go:69/145）不受影响（GCM 认证先于解压，解压失败非口令错误）。davsync 全量套件含 corrupt_remote_test.go、not_backup_test.go 全绿。
- backup.Open/Seal 其他调用方：cli/backup_cmd.go、gui/backup.go、davsync——均经错误传播，无版本断言；cli 套件补跑全绿。

## 9. 交付物与自检

- 2707-comment.body.md：Attribution 行=1、details/summary 行=1、Branch 行=1（python 精确行匹配；grep -c 计 0 系 shell 转义，非文件问题）、```patch 围栏 1 开 1 闭、`</details>`=1、零中文（正则 [\u4e00-\u9fff] 无命中）、无 AI use 段。
- 三条要点均含原 review 引文 + 修法 + 测试名；library 超时以"本机 64s 全绿 + 认同维护者负载定性"呼应，未另做动作。
