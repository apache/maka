# 06 · aider：老牌 pair programmer 与 repo map

> 引擎层 ｜ Stars ~48.7k（2026-09-04） ｜ Python ｜ Apache-2.0 ｜ [Aider-AI/aider](https://github.com/Aider-AI/aider) ｜ ⚠️ 2026-05 后推送明显放缓
> 学习目标：理解 repo map——前上下文工程时代最聪明的"代码库注意力分配"设计；顺带把它当 Python 单包架构样本读。

## 一、为什么存在

终端里的 AI 结对编程，比"agent 元年"更早一代。它的招牌是 **repo map**：用 tree-sitter 提取全仓库符号，按相关性把"代码库地图"塞进有限上下文，让模型不读全库也知道该改哪。在长上下文便宜之前，这是最优雅的解法；今天读它，学的是**注意力分配的思路**——这个思路在 1M 上下文时代依然决定 agent 的成败。

状态提醒：star 高、口碑好，但近月无 push。学习价值不受影响，生产采用前确认活跃度。

## 二、快速入门

```bash
python -m pip install aider-install && aider-install
# 或直接：python -m pip install aider-chat
```

第一次跑通：项目目录运行 `aider`，配好模型 key，然后：

```text
/add src/xxx.py        # 把文件加进会话
请把 xxx 函数改成支持并发，并补测试
```

它会直接给出 diff 并**自动 git commit**——aider 的哲学：每一次 AI 修改都是一个可回滚的 commit。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| repo map | 全库符号地图，自动决定哪些上下文进 prompt |
| /add /drop | 手动控制会话内的文件集 |
| 自动 commit | 每次 AI 编辑落一个 git 提交，天然可回滚 |
| 多模型 | Claude/DeepSeek/GPT/本地模型皆可接 |
| benchmark | 仓库自带 polyglot 基准，业界引用率极高 |

熟练建议：故意给一个 200 文件的项目只 `/add` 三个文件，观察 repo map 如何把远处符号"递"给模型——然后去源码看它怎么算的。

## 四、架构设计

单 Python 包 `aider/`，加上独立的 `benchmark/` 与 `tests/`。核心抽象是一族 Coder 类（不同编辑格式的 coders），编辑输出走 **diff/udiff 格式约束**——用"让模型输出可解析的补丁"代替"让模型输出自由文本再解析"，这是它修改成功率高的关键工程决策。

与新一代 agent 的对照：aider 是**人每个回合驱动**的 pair programming（你说一步它改一步），claude-code/opencode 是**目标驱动**的 agent（给目标它自己多步执行）。这不是代际优劣，是两种交互契约。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `aider/` | 全部主体：coders、repo map、模型接入、命令 |
| `aider/coders/` | 不同 diff 格式的编辑器实现——**精髓所在** |
| `benchmark/` | polyglot benchmark，看它如何量化"改对没有" |
| `tests/` | 测试 |

建议顺序：`aider/repomap.py`（repo map 算法）→ `coders/` 的 diff 约束与回退重试逻辑 → `benchmark/`。总共不到十个核心文件，一个周末能读透。

## 六、自测清单

- [ ] 跑通一次带自动 commit 的完整修改
- [ ] 能向别人讲清 repo map 解决什么问题、怎么解决
- [ ] 能说出 diff 格式约束为什么提升修改成功率
- [ ] 知道它的交互契约与新一代 agent 的区别

## 七、参考

- 仓库：<https://github.com/Aider-AI/aider>
- 文档：<https://aider.chat/docs/>（repo map 专页：<https://aider.chat/docs/repomap.html>）
