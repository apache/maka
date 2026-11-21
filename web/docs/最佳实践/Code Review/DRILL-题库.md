# Review DRILL 题库

> 配套文件：答案键用《React-Code-Review-规则速查表》（含 R65-R67 补遗）；记录写《Review-DRILL.md》。

## 使用说明

1. 一题一次 session：5 分钟计时，脱稿（不开速查表、不开手册），口头说或打字写发现了什么问题，每个问题尽量走四段式：问题 / 原则 / 后果 / 修法。
2. 计时结束才能看答案键。逐条打分：命中记 R 编号；漏了记漏因，只有三类：A 没认出 / B 认出了说不清 / C 说得清但顺序乱。A 补知识，B 补口述，C 补扫描顺序。
3. 代码里故意埋了"写对的片段"（key、disabled、stopPropagation 之类）。指出来也算命中；把对的报成问题要记教训。辨析力是 review 的一半。
4. 顺序：第一次必做题 0 冷启动，之后题 1 → 题 2，再往后按文末方式出新题。

## 扫描顺序（考前 10 秒过一遍）

职责边界 → 状态与数据流 → 渲染与交互 → 副作用与异步 → 性能/安全/体验。

---

## 题 0：用户卡片列表（原题，冷启动重考）

```jsx
import React, { useState, useEffect } from 'react';

// 用户卡片组件：展示用户信息，点击可展开详情
const UserCard = ({ user, onSelect }) => {
  const [detail, setDetail] = useState(null);
  const [expanded, setExpanded] = useState(false);

  // 展开时请求详情
  useEffect(() => {
    if (expanded) {
      fetch(`/api/users/${user.id}`)
        .then(res => res.json())
        .then(data => setDetail(data));
    }
  }, [expanded]);

  const cardStyle = {
    border: '1px solid #ccc',
    padding: 16,
    marginBottom: 12,
    borderRadius: 4,
    cursor: 'pointer',
  };

  return (
    <div style={cardStyle} onClick={() => setExpanded(!expanded)}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{user.name}</span>
        <span style={{ color: user.status == 'active' ? 'green' : 'red' }}>
          {user.status}
        </span>
      </div>
      {expanded && detail && (
        <div style={{ marginTop: 8 }}>
          <p>邮箱：{detail.email}</p>
          <p>部门：{detail.department}</p>
          <p dangerouslySetInnerHTML={{ __html: detail.bio }} />
          <button onClick={() => onSelect(user)}>选择该用户</button>
        </div>
      )}
    </div>
  );
};

// 用户列表
const UserList = ({ users }) => {
  const [selected, setSelected] = useState([]);

  const handleSelect = (user) => {
    selected.push(user);
    setSelected(selected);
  };

  return (
    <div>
      <h3>已选择：{selected.length && selected.map(u => u.name).join(', ')}</h3>
      {users.map(user => (
        <UserCard user={user} onSelect={handleSelect} />
      ))}
    </div>
  );
};
```

### 打分方式

对照你半年前的 17 条自评（Downloads《从一道React笔试题去掌握Review代码.md》），R 编号映射：

| 原题 17 条 | R 编号 |
|---|---|
| 1. push 直接改 state | R03 |
| 2. 选中无去重 | R67（补遗，原 64 条无精确对应） |
| 3. selected 存整个对象 | R04 / R06 |
| 4. 列表缺 key | R25 |
| 5. 按钮冒泡串扰 | R10 |
| 6. `length &&` 渲染出 0 | R66（补遗） |
| 7. div 可点无语义 | R50 / R54 |
| 8. effect 依赖缺 user.id | R12 |
| 9. 重复请求无缓存 | R17（客户端缓存，Vercel `client-swr-dedup`） |
| 10. 无 .catch | R18 / R19 |
| 11. 无 loading | R14 / R18 |
| 12. 无 res.ok 校验 | R18 |
| 13. 无取消 / 竞态 | R20 |
| 14. XSS | R49 |
| 15. `==` 判断 | P3 |
| 16. 内联样式 | P3 |
| 17. 重渲粒度 | R06 / R36 |

---

## 题 1：搜索列表页

```jsx
import React, { useState, useEffect } from 'react';

// 用户搜索页：顶部搜索 + 用户列表 + 行点击看详情
const UserSearchPage = () => {
  const [keyword, setKeyword] = useState('');
  const [departments, setDepartments] = useState([]);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);

  // 初始化：先拿部门列表，再拿用户列表
  useEffect(() => {
    setLoading(true);
    fetch('/api/departments')
      .then(res => res.json())
      .then(async (deps) => {
        setDepartments(deps);
        const users = await fetch('/api/users').then(r => r.json());
        setList(users);
        setLoading(false);
      });
  }, []);

  // 输入即搜索
  useEffect(() => {
    fetch(`/api/users?kw=${keyword}`)
      .then(res => res.json())
      .then(data => setList(data));
  }, [keyword]);

  // 在职人数
  const activeCount = list.filter(u => u.status === 1).length;
  const [cachedCount, setCachedCount] = useState(0);
  useEffect(() => {
    setCachedCount(activeCount);
  }, [activeCount]);

  return (
    <div>
      <input
        value={keyword}
        placeholder="搜索用户"
        onChange={e => setKeyword(e.target.value)}
      />
      <button onClick={() => { setKeyword(''); setList([]); }}>重置</button>
      <p>在职：{cachedCount} 人</p>

      {list.map(u => (
        <div
          key={u.id}
          style={{ padding: 8, borderBottom: '1px solid #eee', cursor: 'pointer' }}
          onClick={() => {
            fetch(`/api/users/${u.id}/detail`)
              .then(r => r.json())
              .then(setDetail);
          }}
        >
          {u.name}
        </div>
      ))}

      {detail && (
        <div className="detail-panel">
          <p>{detail.name}</p>
          <div dangerouslySetInnerHTML={{ __html: detail.remark }} />
        </div>
      )}
    </div>
  );
};
```

### 题 1 答案键（先做完再看）

1. [P0] 初始化瀑布：departments 和 users 相互独立却串行 await → R65（补遗）/ Vercel `async-parallel` → Promise.all 并行。
2. [P0] loading 不对称：只有初始化 set true，departments 失败无 catch，loading 永久 true → R18 → catch + try/finally。
3. [P1] 搜索竞态：快速输入旧请求后返回覆盖新列表 → R20 → AbortController 或版本戳。
4. [P1] 重复请求：挂载时 `[keyword]` 的 effect 以 kw='' 再跑一次，和初始化 /api/users 重复 → R17 → 跳过首次或统一请求入口。
5. [P2] 输入无防抖：一个字符一个请求 → R37 邻域 / Vercel `useDeferredValue` → 防抖或 defer。
6. [P1] 派生状态反模式：activeCount 能现算却用 state+effect 存一份 cachedCount → R02 → 直接渲染 activeCount，删掉 state 和 effect。
7. [P2] 重置不完整：只清 keyword 和 list，没按空关键词重拉全量，detail 残留 → R28 → 重置纳入统一请求模型。
8. [P1] 行点击详情：无 loading、无错误处理、无竞态保护，快速点多行旧覆盖新 → R14 / R18 / R20。
9. [P0] XSS：remark 直接 dangerouslySetInnerHTML → R49 → DOMPurify 或后端清洗。
10. [P3] keyword 未 encodeURIComponent，特殊字符破坏 query → 规范。
11. 写对的：`key={u.id}`。把它报成问题记教训。

---

## 题 2：编辑弹窗

```jsx
import React, { useState, useEffect } from 'react';

// 编辑弹窗：打开拉详情，Esc/点遮罩关闭，保存回调父组件
const EditDialog = ({ visible, id, onClose, onSaved }) => {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && id) {
      fetch(`/api/items/${id}`)
        .then(res => res.json())
        .then(setForm);
    }
    setForm({});
  }, [visible, id]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await fetch(`/api/items/${id}`, {
      method: 'PUT',
      body: JSON.stringify(form),
    });
    setSaving(false);
    onSaved(form);
    onClose();
  };

  const tags = form.tags || [];
  const sortedTags = tags.slice().sort((a, b) => a.name.localeCompare(b.name));

  if (!visible) return null;

  return (
    <div className="mask" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>编辑条目</h3>
        <input
          value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })}
        />
        <ul>
          {sortedTags.map((t, i) => (
            <li key={i}>{t.name}</li>
          ))}
        </ul>
        <button disabled={saving} onClick={handleSave}>保存</button>
        <button onClick={onClose}>取消</button>
      </div>
    </div>
  );
};
```

### 题 2 答案键（先做完再看）

1. [P1] effect 职责混装 + 竞态：同一个 effect 既发请求又无条件 `setForm({})`，清空与返回时序不定，打开弹窗可能被清空或旧响应覆盖 → R11 / R20 → 请求与重置分开，回写前确认仍归属当前 id。
2. [P0] Esc 监听泄漏 + 语义错位：没 cleanup（R13）；组件常驻只是不渲染，弹窗关着按 Esc 仍触发 onClose 改父组件状态；依赖 `[]` 引用 onClose 有闭包旧值风险（R12）→ visible 时才挂监听并 cleanup。
3. [P0] handleSave 无异常闭环：fetch 一抛错，`setSaving(false)` 永不执行，保存按钮永久禁用 → R18 → try/finally。
4. [P1] 保存无校验无反馈：name 为空也提交（R67 业务约束）；成功失败都只是关弹窗，用户无感知（R14 / R55）；没查 res.ok，404/500 走成功分支。
5. [P2] 保存中可被 Esc / 遮罩关闭：saving 状态被绕过，半提交状态不明 → 交互边界 → saving 时禁用关闭或先中断。
6. [P2] 受控 input 断裂：form 初始 `{}`，form.name 是 undefined，输入框先非受控、输入后变受控（React 警告）→ `value={form.name ?? ''}`。
7. [P1] 可排序列表用 index 当 key：排序后顺序变化，diff 错位状态串位 → R25 → 用 t.id。
8. [P3] PUT 缺 Content-Type header → 规范。
9. 辨析题：sortedTags 每渲染重排——标签通常个位数，加 useMemo 属形式优化 → R40，不改。写对的：`disabled={saving}` 防重复提交、遮罩 onClick + stopPropagation 分层关闭。

---

## 出新题的方式

让 AI：把题 X 改出 N 个新坑，保留 2 处正确写法，坑覆盖状态 / 交互 / 副作用 / 异步 / 安全各至少一个，答案键给 R 编号。判停：连续 2 次同一题命中 ≥80% 且漏因无 A 类，才加新题，不重刷旧题。
