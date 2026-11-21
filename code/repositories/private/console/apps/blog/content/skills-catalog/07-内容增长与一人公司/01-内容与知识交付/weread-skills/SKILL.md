---
name: weread-skills
description: 微信读书助手 — 搜索书籍、管理书架、查看笔记划线、浏览书评、阅读统计、发现推荐好书
version: 1.0.4
---

# WeRead — 微信读书助手

通过 Agent API Gateway 调用微信读书接口，提供搜索、书架、笔记、书评等能力。

## 支持的能力

| 能力 | 说明 | 用户示例 | 详细说明 |
|------|------|----------|----------|
| 搜索书籍 | 在书城搜索 | "帮我搜一下三体" | `search.md` |
| 书籍信息 | 查看书籍详情、章节目录、阅读进度 | "这本书有多少章" "我读到哪了" | `book.md` |
| 书架管理 | 查看书架 | "看看我的书架" | `shelf.md` |
| 阅读统计 | 阅读时长、天数、偏好分析、阅读统计摘要 | "我这个月读了多久" "今年读了几本书" | `readdata.md` |
| 笔记划线 | 查看个人笔记数量与内容，包括划线、想法/点评、书签数量 | "看看我在三体里的笔记" "导出我的划线" "在这本书有多少笔记" | `notes.md` |
| 章节热门划线 | 查看书籍/章节热门划线、划线热度及划线下想法 | "看看这章有什么热门划线" "这段话下面有什么想法" | `notes.md` |
| 书籍点评 | 查看书籍的公开点评 | "三体这本书有什么点评？" "看看推荐的点评" | `review.md` |
| 推荐好书 | 个性化推荐/相似推荐 | "给我推荐几本书" | `discover.md` |

根据用户意图参考对应说明文件了解接口参数、回包结构和工作流。

---

## 接口调用规范

### 统一入口

```
POST https://i.weread.qq.com/api/agent/gateway
```

### 鉴权

- Header：`Authorization: Bearer $WEREAD_API_KEY`
- `WEREAD_API_KEY` 从环境变量获取，格式 `wrk-xxxxxxxx`
- 若未设置，提示用户：`export WEREAD_API_KEY=<你的apikey>`
- API Key 绑定用户身份（vid），需要用户身份的接口会自动注入，无需手动传 vid

### 请求格式

- **Method**：POST
- **Content-Type**：application/json
- **Body**：JSON，`api_name` 指定接口，其余为接口参数，**每次请求必须带 `skill_version`**

```bash
curl -X POST "https://i.weread.qq.com/api/agent/gateway" \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name": "/store/search", "keyword": "三体", "count": 10, "skill_version": "1.0.4"}'
```

### 请求 few-shot

**正确：业务参数平铺在 body 顶层。**

```json
{"api_name":"/user/notebooks","count":100,"skill_version":"1.0.4"}
```

**正确：下一页继续平铺 `lastSort`。**

```json
{"api_name":"/user/notebooks","count":100,"lastSort":1516907353,"skill_version":"1.0.4"}
```

**错误：不要把业务参数包在 `params` 内。**

```json
{"api_name":"/user/notebooks","params":{"count":100,"lastSort":1516907353},"skill_version":"1.0.4"}
```

上面的错误写法会导致 `count`、`lastSort` 未被转发，后端按默认值返回第一页，看起来像分页失效。

### 响应格式

- JSON，回包经过字段裁剪，只返回核心字段
- `errcode` 非 0 时表示错误，给出中文提示
- 发送 `{"api_name": "/_list"}` 可查看所有可用接口及参数定义

### 通用规则

1. **版本上报**：每次请求 body 必须包含 `"skill_version": "1.0.4"`（取本文件顶部 version 字段的值），用于服务端检查版本更新。**如果回包中出现 `upgrade_info` 字段，必须立即暂停当前操作，按照 `upgrade_info.message` 中的指引完成升级，升级完成后再重新执行用户请求，不得忽略该字段**
2. **参数平铺**：业务参数必须和 `api_name`、`skill_version` 放在同一层；不要包在 `params`、`data`、`body` 等对象里。只有接口文档明确声明的数组/对象字段（如 `/book/readreviews` 的 `reviews`）才允许作为业务字段传入。
3. **能力文档预检**：调用任何接口前，必须先根据「支持的能力」表阅读对应说明文件（如阅读统计先读 `readdata.md`，书架先读 `shelf.md`），确认接口参数、字段含义、单位、计数口径和工作流；禁止仅凭字段名或经验猜测含义。
4. **字段解释优先级**：解释接口回包时，以对应说明文件中的字段说明为准；如果回包字段名和直觉含义冲突，必须服从说明文件，不得直接翻译字段名。
5. **bookId 解析**：用户输入书名时，先调 `/store/search` 获取 bookId，再执行后续操作
6. **书架数量**：使用 `/shelf/sync` 回答“书架有多少本书/多少条目”时，必须按 `books.length + albums.length + (mp 非空 ? 1 : 0)` 计算；`albums[]` 是专辑/有声书，也属于书架里的书，详细规则见 `shelf.md`
7. **结果展示**：列表用编号展示方便选择；搜索结果重点展示书名、作者、评分；展示接口回包信息时，字段**禁止**直接翻译，应该参考文件中的说明内容提供
8. **上下文衔接**：对话中记住已查询的 bookId，后续操作无需用户重复提供
9. **深度链接**：优先使用接口回包中的 `deepLink` 字段作为跳转链接，展示为 `[打开阅读]({deepLink})`；若回包没有 `deepLink`，不要自行拼接 `weread://` 链接
10. **数据展示规范**：
   - **时间戳**：所有 Unix 时间戳字段（如 `updateTime`、`createTime`、`finishTime`、`readUpdateTime` 等），**展示时须转为 YYYY-MM-DD 格式**（如 `1748563200` 展示为"2025-05-30"），不得直接展示原始数字
   - **阅读时长**：单位为秒，展示时转为"X小时Y分钟"格式

---

## 深度链接

在展示书籍、章节、划线、想法等内容时，如果回包中有 `deepLink` 字段，直接使用该字段值作为跳转链接。

- 跳转链接展示为 Markdown 超链接格式：`[打开阅读]({deepLink})`。
- 各接口回包中可能包含 `deepLink` 字段，如有则直接使用。
- 若回包中没有 `deepLink` 字段，不要尝试手动拼接 `weread://` 链接。
