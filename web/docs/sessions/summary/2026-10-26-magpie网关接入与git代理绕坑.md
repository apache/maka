# magpie 网关接入第三方 agent 与 git 代理绕坑

**一句话总结**：maka、dsh 两个 coding agent 接入 magpie 本地网关都是纯配置零代码；dsh 报 MISSING_CREDENTIAL 的根因是桌面版不读 `.env` 只读自己的密钥库；SSH 22 口被代理掐断时，fetch 走 https URL、push 走 ssh.github.com:443。

## 背景

想把 apache/maka 和 DeepSeek Harness (dsh) 两个 coding agent 都接到 magpie（本地模型网关）统一供模型。maka 配置一次成功；dsh 配好后发会话报 `no credential for provider route "magpie-anthropic"`（MISSING_CREDENTIAL）。同一天在 magpie 仓库跑多路并行后台任务，还遇到 fetch/push 网络不通和 /tmp 工作树丢失两个环境坑。

## 核心命令

```bash
# 接入方式（以 maka 为例，dsh 同理）：设置→模型→添加连接→自定义连接
#   API 地址：http://127.0.0.1:3425/v1   （/v1 必须手写，maka 的 URL 拼接不自动补）
#   API 密钥：本机回环随便填非空字符串（如 magpie）；模型列表走 /v1/models 自动发现

git -C <repo> fetch https://github.com/yetone/magpie.git +refs/heads/main:refs/remotes/upstream/main
# SSH 22 端口被代理掐断时，fetch 用 https URL 显式拉到本地 upstream 引用，不用改 remote 配置

git ls-remote --heads ssh://git@ssh.github.com:443/<你的GitHub用户名>/<repo>.git
# SSH 22 不通时改用 443 端口的 ssh.github.com 验证通路；push 同款写法：
git push ssh://git@ssh.github.com:443/<你的GitHub用户名>/<repo>.git <branch>:<branch>

git -C <主clone> worktree add -b <分支名> /tmp/<目录名> <起始SHA>   # 并行任务每路独占一个 worktree
git -C <主clone> worktree prune                                    # 目录已丢时清掉残留注册关系
git -C <主clone> rev-list --count <分支> --not upstream/main        # 删分支前先数独有提交数，>0 必须停手

"/c/Program Files/GitHub CLI/gh.exe" issue list -R <org>/<repo> --author <你的GitHub用户名> --state all --limit 30
# 多台机器都在干活时，动手前先查自己名下已发的 issue，防撞重复

gh api "repos/<org>/<repo>/issues?per_page=1&state=all" --jq '.[0].created_at'
# 本机时钟可疑时，用 GitHub 服务器时间戳核对真实当前日期

grep -c "SOME_KEY" ~/.dsh/.env 2>/dev/null || echo "缺失"
grep -n "version\|MAGPIE" ~/.dsh/.credentials.yaml
# 只查键名/条数、不打印值，定位凭据到底存进了哪个文件
```

dsh 报「密钥未设置」时的修复（`~/.dsh/.credentials.yaml`，与已有键平级补一行）：

```yaml
refs:
  MAGPIE_GATEWAY_KEY: <网关key或任意非空串>
```

## 关键结论

1. **magpie 接任何支持「自定义连接/OpenAI 兼容」的 agent 都是纯配置**：网关 `http://127.0.0.1:3425/v1` 同时讲 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种协议，回环本机不校验 key。同一个 agent 别配两遍（网关应用的一键接线 + 手填表单），会出现两套指向同一网关的 provider 行。
2. **dsh 桌面版不读 `~/.dsh/.env`，只读自己的密钥库 `~/.dsh/.credentials.yaml`**（magpie 源码里编号 #969 的已知坑）。报 "no credential for provider route" 就是密钥没进这个库：补 yaml 一行，或在 dsh 设置→模型里给该 provider 重填一次密钥，均可。
3. **代理环境 git 网络分两口走**：fetch 走 https（443 口），push 走 `ssh://git@ssh.github.com:443/`。改 remote 不是必须的，命令行显式给 URL 即可。
4. **/tmp 里的 worktree 不保命**：重启或清理后目录直接消失，未提交物全丢；提交过的内容在主 clone 的分支引用上，安全。重要中间产物要么即提即推，要么落到仓库外的固定证据目录。
5. **删分支前先数独有提交**（`rev-list --count`）：`git branch -D` 只打印一行 "was <sha>"，删错了赶紧按这个 SHA 重建分支，对象在 gc 前都还在。
