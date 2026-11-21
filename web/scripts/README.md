# scripts — cc 仓与家目录运维脚本

- `home-sync.sh` — 家目录 dotfiles 仓（~）的安全同步：只 fetch + ff-only/push，分叉即停；AI 自动化硬约束文本在脚本头部（家目录事故防复发，见 `web/docs/fork/handbook/11-事故复盘.md`）
- `backup.sh` / `restore.sh` / `scan.sh` — 仓库灾备三件套：按 `repos.tsv` 做 git bundle 备份 / 还原（远程失效自动解包）/ 扫描生成清单
- `scan-repos.sh` — 扫描 cc 下独立 git 仓，输出 `web/docs/sessions/curated/projects/独立仓库清单.md`
- `github/` — github 收藏的备份脚本，清单是这份目录自己的 `repos.tsv`
- `interview/check_docs.py` — 面试复习库验收，目标是 `code/paused/interview`
- `install.sh` — 一键安装各活跃子项目依赖
- `go-skills.mjs` — 六个 Go 项目级 Skills 的安装/复装（复装保护本地改动）
- `test.sh` — 脚本自测
- `clean/` — 清理脚本

多数脚本按 Windows 时期布局编写（`BASE=/e` 等默认值），Mac 上使用需核对路径或以环境变量覆盖。
