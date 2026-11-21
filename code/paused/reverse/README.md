# reverse — 逆向工程工作区

浏览器扩展与客户端逆向的资料与实验区。本目录按「独立区只留 README 作轮廓」模式入 cc 仓：结构说明在册，内容本体不入 cc 跟踪（原因见下）。

## 目录内容

- **`code/`** — 4 个第三方上游克隆（各带自己的 `.git` 与 origin，独立管理，不入 cc 跟踪）：
  - [rea](code/rea)（shijianzhong/rea）· [ARTIFEX](code/ARTIFEX)（sebastian93921/ARTIFEX）· [autonomous-pentest-agent](code/autonomous-pentest-agent)（kutukam/autonomous-pentest-agent）· [reverse-engineering-assistant](code/reverse-engineering-assistant)（cyberkaida/reverse-engineering-assistant）
- **`cases/`** — 逆向案例工作现场（源码分析、抓包记录）；成品可入库，安装包等二进制不入
- **`crx-archive/`** — 按日期归档的原始 `.crx`/`.exe` 安装包（仅本地保留）

## 跟踪边界

- 4 个克隆仓内容不进 cc：上游已各有远程，重复入库只添噪音（2026-10-26 嵌套仓库指针退役的同一口径）；`.gitignore` 的 `reverse/code/*` 再忽略规则维持此边界。
- 二进制与日志（`.crx`/`.exe`/`.zip`/`.log` 等）由仓根扩展名兜底规则排除，仅本地保留。
- 案例分析类文本成果若需长期沉淀，可放入 `cases/` 并单独 `git add -f` 或调整白名单。

## 历史

早期案例内容（iTab/WebInk/Youmind 等约 1900 个分析文件）曾入 cc 跟踪，2026-10-28 目录重构时移出跟踪；需要时从 cc 仓 git 历史找回。
