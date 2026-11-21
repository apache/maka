# Git 对象损坏导致 pull 失败 的排查与恢复

> 日期：2026-08-06
> 场景：`git pull` / `git fetch` 报 corrupt loose object，随后快进合并报未跟踪文件冲突
> 结论先行：**根因是 `.git/objects` 里一个 62MB 大 blob（exe）被截断成 23MB**。git 认为对象"已存在"而跳过重新下载，必须**先删损坏对象、再用 HTTPS + 严格校验强制重取**，最后才处理文件冲突。

---

## 1. 问题现象

```text
$ git fetch origin
error: inflate: data stream error (invalid stored block lengths)
error: corrupt loose object '09640039c7c7d01cc7481a428144988a2c2058fe'
fatal: loose object 09640039c7c7d01cc7481a428144988a2c2058fe (...) is corrupt
error: failed to perform geometric repack
error: task 'geometric-repack' failed
```

`git pull` / `git merge --ff-only origin/main` 在对象修复后还会报：

```text
error: The following untracked working tree files would be overwritten by merge:
        .claude/plans/typed-marinating-rivest.md
        ...
Please move or remove them before you merge. Aborting
```

---

## 2. 根因

1. `.git/objects/09/640039...` 是 `CLIProxyAPI/cli-proxy-api.exe`（**62MB**）的 blob，磁盘上实际只有 **23MB**（被截断），zlib 数据流损坏。
2. git 判定本地"已有该对象"（哪怕是坏的），`fetch` **不会重新下载**——不删坏对象，拉取永远失败。
3. 大文件每次改动都会生成完整新 blob，是对象损坏的高发区；传输中断/拷贝 .git 目录中断都可能造成。

---

## 3. 诊断命令（只读，先确认范围）

| 目的 | 命令 |
|---|---|
| 找出所有损坏对象 | `git fsck --full`（找 `corrupt` / `broken` 行） |
| 确认对象类型与声明大小 | `git cat-file -t <sha>`、`git cat-file -s <sha>` |
| 确认损坏对象对应哪个文件 | `git rev-list --objects --all \| grep <sha>` |
| 确认哪个版本的该文件损坏 | `git ls-tree -r HEAD -- <path>` vs `git ls-tree -r origin/main -- <path>` |
| 找引用该对象的提交 | `git log --all --find-object=<sha>` |
| 确认该提交是否在远程 | `git log origin/main --oneline -- <path>` |
| 查看损坏文件磁盘实际大小 | `ls -la .git/objects/<ab>/<sha>`（对比 `cat-file -s` 的声明大小） |

判断要点：若损坏对象对应 `origin/main`（远程最新版），远程必有完整副本 → 可恢复。若损坏文件磁盘大小 ≪ 声明大小，即为截断损坏。

---

## 4. 修复步骤（HTTPS + 严格校验）

```bash
# ① 备份损坏对象（可回滚）
mkdir -p ~/.git-object-backup
cp -p .git/objects/09/640039c7c7d01cc7481a428144988a2c2058fe ~/.git-object-backup/

# ② 删除损坏对象（关键：不删，git 永远不重新下载它）
rm -f .git/objects/09/640039c7c7d01cc7481a428144988a2c2058fe

# ③ 强制从远程按 SHA 重取（HTTPS 通道 + 严格校验 + 强制打包成 pack）
#    fetch.unpackLimit=1  → 不写成松散对象（松散对象写入路径曾出现截断）
#    fsckobjects=true     → 传输后严格校验，损坏则报错中止
git -c fetch.fsckobjects=true -c transfer.fsckobjects=true -c fetch.unpackLimit=1 \
    fetch https://github.com/<owner>/<repo>.git <sha>

# ④ 验证（必须完整解压核对大小，不能只 | head）
git cat-file -p <sha> > /tmp/blob.bin && ls -la /tmp/blob.bin   # 大小应等于 cat-file -s <sha>
git fsck --full                                                  # 无 corrupt / broken / missing
```

> 若③用 HTTPS 后对象仍是坏松散对象，说明网络层对该大对象稳定截断 → 保持 `fetch.unpackLimit=1` 强制打包重试；仍失败可考虑从仓库 archive/其他完整 clone 复制对象。

---

## 5. 快进合并时的未跟踪文件冲突

对象修复后，`git merge --ff-only origin/main` 可能报 "untracked working tree files would be overwritten"。

处理原则：**先对比内容，一致则零风险解决**。

```bash
# ① 拿远程版本 blob sha，提取内容
git ls-tree origin/main .claude/plans/
git cat-file -p <blob-sha> > /tmp/remote.md

# ② 与本地未跟踪文件逐字节对比
cmp /tmp/remote.md .claude/plans/local.md && echo IDENTICAL

# ③ 内容一致 → 备份后删除本地未跟踪文件，再 merge（远程会提供同内容文件）
cp -p .claude/plans/local.md ~/.git-object-backup/plans/
rm .claude/plans/local.md
git merge --ff-only origin/main
```

若内容**不一致**：本地未跟踪版本是未提交的本地成果，不要直接删。应先把本地文件复制到仓库外，merge 后用 diff 合并或按需覆盖。

---

## 6. 陷阱清单（本次踩过的坑）

1. **git 不重新下载"已存在"的坏对象** → 必须删除坏对象再 fetch，这是第一步。
2. **第二次 fetch 时远程若无新提交，git 走 no-op 不补全缺失对象** → 删对象后要用 `fetch <sha>` 强制拉取该对象，而不是只跑普通 `git fetch`。
3. **SSH 通道对大对象 fetch 可能卡死**（本次 7 分钟无输出）→ 换 HTTPS 通道（Windows credential manager 有缓存凭据）。
4. **fetch 写松散对象时可能静默截断**（git 早期版本不校验）→ 用 `fetch.unpackLimit=1` 强制打包 + `fsckobjects=true` 严格校验。
5. **`git cat-file -p <sha> | head` 是假阳性**：大对象流式解压前几 KB 正常，管道提前关闭掩盖了后续损坏。正确验证是完整解压到文件核对大小，或 `git fsck --full`。
6. `cat-file -s` 从对象头读声明大小，不代表内容完整——只信 `-p` 全量输出 + `fsck`。
7. fetch 中断会在 `.git/objects/pack/` 留下零字节 `tmp_pack_*` 和孤儿 `.idx`，无害，可 `git gc --prune=now` 清理。

---

## 7. 故障速查表

| 现象 | 原因 | 动作 |
|---|---|---|
| `inflate: invalid stored block lengths` | 松散对象截断/损坏 | 备份 → 删对象 → HTTPS fetch sha |
| `inflate: incorrect data check` | 新写入的对象 CRC 不匹配 | 强制打包 `fetch.unpackLimit=1` + `fsckobjects=true` 重取 |
| fetch 无报错但对象仍缺 | 远程无新提交，git 不补全 | 用 `git fetch <url> <sha>` 显式拉对象 |
| SSH fetch 长时间无输出 | 大对象经 SSH 传输问题 | 换 HTTPS URL fetch |
| merge 报 untracked overwritten | 远程归档了本地同名未跟踪文件 | 先 `cmp` 对比，一致则备份后删本地，再 merge |

---

## 8. 预防建议

- 仓库内几十 MB 的二进制（exe、tar、png）建议迁到 **Git LFS**，避免对象库膨胀与损坏风险。
- 拷贝 `.git` 目录、磁盘整理、杀软扫描时注意不要在写对象时中断。
- 定期 `git fsck --full` 巡检对象完整性；`git count-objects -v` 看 garbage。
