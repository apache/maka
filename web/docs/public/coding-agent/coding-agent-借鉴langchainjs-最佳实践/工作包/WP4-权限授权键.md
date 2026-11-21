# WP4 · 审批新增"本会话允许此类"（scoped）

**目标**：缓解 C4。在"允许一次"和"本会话全部允许"之间加一档：只记住**这一类**操作（授权键）。

> ⚠️ 现状是有意设计：`core/permission.ts:1` 注释与 `specs/permission.md` R3 锁定"always = 进程内全局布尔，不按工具分粒度"，五版都有测试。所以本包**不改 always**，只新增第四态 `scoped`。合并前需要 owner 确认接受新增审批选项。

**langchain 对标**：`agents/middleware/hitl.ts` 的 `interruptOn: { [toolName]: { allowedDecisions } }`——按工具配置审批策略。只借"粒度"这个思路，不借 `interrupt()`/resume 机制。

**归属文件**：`src/core/permission.ts`、`src/plugins/tools/*.ts`（只加 `grantKey`）、`src/shell/repl.ts`（审批提示）、`src/shell/web.ts:985`（决策校验接受 `scoped`）、`src/shell/web.html`（审批按钮）。

**接口依赖**：WP0。

## 授权键规则

| 工具 | grantKey | grantLabel |
|---|---|---|
| 缺省 | 工具名，如 `edit` | 本会话允许所有 edit |
| `write` / `edit` / `apply_patch` | 工具名 | 本会话允许所有 <工具> |
| `bash` | `bash:<首词>`，如 `bash:npm` | 本会话允许 npm 命令 |
| `bash` 复合命令 | **不可 scoped** | 不显示该选项 |
| MCP 工具 | 完整名 `mcp__<server>__<tool>` | 本会话允许 <tool> |

bash 不可 scoped 的条件（任一命中）：首词是 `bash sh zsh fish env xargs sudo eval exec nohup time`；命令含 `;`、`&&`、`||`、`|`、`$(`、反引号、`>`、`<`、换行。

## 闸门顺序（R1 增量）

① yolo → 放行；② skipPermission 白名单 → 放行；**②b grants 里有本次 grantKey → 放行**；③ 询问四态；④ 非 deny 即放行本次。`scoped` 时把 grantKey 加入 grants；`always` 仍置 yolo。

## Cursor 提示词

```text
仓库 coding-agent，impls/typescript，分支 feat/wp4-permission-scope（从已合并 WP0 的 develop 拉）。
目标：审批新增第四态 scoped（"本会话允许此类"），按授权键记忆。always 的语义保持不变（specs/permission.md R3 是五版锁定契约）。
参考：附带的 02-接口契约.md §4、05-风险与不确定点.md R3/R14、工作包/WP4。
1. 先写测试 test/approval.test.ts 新用例：
   a. 对 write 回答 scoped 后，再调 bash 仍询问；
   b. 对 "npm test" 回答 scoped（grantKey=bash:npm）后，"npm run build" 不询问，"rm -rf x" 仍询问；
   c. "bash -c 'rm x'"、"npm test && rm x"、"cat a | sh" 的请求里 grantKey 为空，不提供 scoped；
   d. 回答 always 仍全局放行（已有测试不改）。
   先跑确认失败。
2. core/permission.ts：PermissionDecision 增加 'scoped'；PermissionRequest 增加 grantKey?、grantLabel?；createPermissionGate 增加可选 grants: Set<string> 参数和第三个参数 grantKey；决策顺序：yolo → （白名单在调用方）→ grants.has(grantKey) → 询问。
3. 各工具插件加 grantKey(args)：bash 按 WP4 表格（复合命令返回 undefined），其他缺省用工具名。调用方（agentloop 内联权限处，或 WP1 合并后的 permissionMiddleware）传入 grantKey。
4. repl.ts：有 grantKey 时提示改为 "[y=允许 / s=<grantLabel> / n=拒绝 / a=本会话全部允许]"，无 grantKey 时保持原文案；web.ts:985 决策校验接受 'scoped'；web.html 审批卡片在有 grantLabel 时多一个按钮，用已有按钮样式。
5. specs/permission.md：R1 增加 ②b；R2 增量为四态；新增 R3b scoped 记忆；偏离清单中"按工具名分粒度"一条注明只约束 always。
硬约束：不改 always/yolo 的现有行为和文案；零新增依赖；grants 只在进程内，不持久化；npm test、npm run check、npm run test:ui 全绿。
完成后输出：改动文件、测试结果、repl 审批提示的前后对比。
