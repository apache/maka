// ponytail: verbatim 移植自反编译源码（原项目 tsconfig noImplicitAny:false，变量仍为压缩短名），宿主 strict 下整文件豁免类型检查。
// @ts-nocheck
/**
 * 16 个课节的交互可视化组件。
 * 由源站 minified bundle 反编译还原：组件树、DOM 结构与类名和原站一一对应；
 * 局部变量仍是压缩短名（h/z/N...），供对照学习，重构可逐个组件进行。
 */
import { useEffect, useRef, useState } from "react";
import { PlaybackControls } from "./PlaybackControls";
import { useStepper } from "./useStepper";

// ═══ 第 01 课 · visual: data · 训练数据的规模与构成实验 ═══
export function DataVisual() {
  const [h, z] = useState(0),
    [_, f] = useState(0),
    N = [
      { label: "网页文本", share: 70, color: "var(--accent)" },
      { label: "书籍", share: 12, color: "var(--brand)" },
      { label: "代码", share: 8, color: "var(--success)" },
      { label: "学术论文", share: 5, color: "var(--danger)" },
      { label: "对话数据", share: 5, color: "oklch(0.66 0.13 78)" },
    ],
    C = [
      {
        label: "270M",
        data: "约 1B Tokens 训练",
        reach: "知识覆盖极度稀疏，只会拼接高频模式",
        analogy: "一座小型城市图书馆",
        dots: 7,
        verdict: "容易幻觉",
        tone: "risk",
        answer: "给出看似完整的介绍，但核心身份、时间或作品无法追溯。",
        note: "很小的模型可能把零散模式拼成流畅句子；流畅不代表知道。",
      },
      {
        label: "0.6B",
        data: "约 1B Tokens 训练",
        reach: "能抓到常识方向，细节仍不稳定",
        analogy: "约 75 万本普通小说",
        dots: 10,
        verdict: "部分正确",
        tone: "warn",
        answer: "能说出大类事实，却补上了没有证据的职位、年份或经历。",
        note: "“方向对、细节错”是覆盖仍然稀疏时常见的表现。",
      },
      {
        label: "1.8B",
        data: "约 2B Tokens 训练",
        reach: "大众知识有模板，小众实体常会空白",
        analogy: "约 150 万本书",
        dots: 14,
        verdict: "会拒答",
        tone: "neutral",
        answer: "能够承认资料不足，并要求补充背景信息。",
        note: "拒答通常比编造更可靠，但不代表它已经掌握了该知识。",
      },
      {
        label: "30B",
        data: "约 15T Tokens 训练",
        reach: "主流事实与表达组织较完整",
        analogy: "把互联网材料读过数遍",
        dots: 28,
        verdict: "较完整",
        tone: "good",
        answer: "可给出结构清晰的背景、时间线和代表信息，并标注待验证的细节。",
        note: "更多参数和数据能提高主流知识覆盖，却不是事实保证。",
      },
      {
        label: "70B",
        data: "约 15T Tokens 训练",
        reach: "细节密度提升，但同名和长尾事实仍会混淆",
        analogy: "大型国家级馆藏",
        dots: 36,
        verdict: "仍会混淆",
        tone: "risk",
        answer: "回答看上去更自信，但把相近人物、事件或年份混在了一起。",
        note: "参数更大不等于没有 Hallucination；覆盖边界仍然存在。",
      },
      {
        label: "120B",
        data: "约 15T+ Tokens 训练",
        reach: "跨语言细节与复杂表达更稳定",
        analogy: "反复检索的大型知识网络",
        dots: 44,
        verdict: "专家级",
        tone: "good",
        answer: "能组织出更细的背景与时间线，但高风险事实依旧应有来源。",
        note: "规模提升带来知识密度，不替代外部验证。",
      },
      {
        label: "235B",
        data: "MoE · 约 20T Tokens",
        reach: "大参数池与动态专家协同",
        analogy: "大规模分科馆藏",
        dots: 52,
        verdict: "百科级",
        tone: "good",
        answer: "对常见公开对象给出覆盖更广的条目式说明，并保留不确定项。",
        note: "MoE 的有效计算量和总参数池不是同一个概念。",
      },
      {
        label: "1T",
        data: "万亿级 MoE · 约 20T Tokens",
        reach: "知识密度和表达广度更强",
        analogy: "人类文字材料的多轮等效覆盖",
        dots: 62,
        verdict: "高覆盖",
        tone: "good",
        answer: "能把跨领域信息组织为长回答，但实时或私有事实仍无法凭参数确认。",
        note: "大体量只能改变概率分布，不能让模型变成实时数据库。",
      },
      {
        label: "5T+",
        data: "顶级旗舰 · 参数未完全公开",
        reach: "行业前沿的综合能力与表达质量",
        analogy: "持续更新的超大研究网络",
        dots: 72,
        verdict: "仍需验证",
        tone: "good",
        answer: "输出结构化、细节丰富的说明，同时把即时、关键结论交由工具或权威来源确认。",
        note: "再高的模型规模，也不能跳过事实核验与权限边界。",
      },
    ],
    R = C[h],
    D = [
      {
        name: "覆盖平衡",
        detail: "网页、书籍、代码、专业材料与人类反馈相互补足。",
        outcome: "模型较容易形成跨领域的结构化表达，但仍需要验证实时信息。",
        tone: "good",
      },
      {
        name: "来源单一",
        detail: "规模不变，但绝大多数材料来自重复的网页摘要。",
        outcome: "语言看起来更流畅，专业边界与长尾情境却更容易失真。",
        tone: "warn",
      },
      {
        name: "质量失控",
        detail: "包含过时、矛盾、未授权或低质量的重复材料。",
        outcome: "模型会把冲突模式一起学进去；更大规模也无法自动修复数据问题。",
        tone: "risk",
      },
    ],
    x = D[_];
  return (
    <section className="lab data-lab" aria-label="训练数据规模与构成实验">
      <div className="lab-head">
        <div>
          <span className="lab-label">可操作实验</span>
          <h2>训练数据决定模型能覆盖怎样的世界</h2>
        </div>
        <span className="schema-badge">教学模拟</span>
      </div>
      <div className="corpus-composition">
        <div className="composition-title">
          <div>
            <b>训练语料的构成</b>
            <small>不是一类数据，而是一组来源、质量和许可条件的组合</small>
          </div>
          <span>100%</span>
        </div>
        {N.map((r) => (
          <div className="corpus-row">
            <span>{r.label}</span>
            <div className="corpus-track">
              <i style={{ width: `${r.share}%`, background: r.color }} />
            </div>
            <b>{r.share}%</b>
          </div>
        ))}
      </div>
      <div className="data-profile">
        <div>
          <span>相同规模，不同数据配方</span>
          <div role="tablist" aria-label="训练数据质量">
            {D.map((r, T) => (
              <button
                type="button"
                role="tab"
                aria-selected={_ === T}
                className={_ === T ? "is-active" : ""}
                onClick={() => f(T)}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
        <div className={`data-profile-result is-${x.tone}`}>
          <b>{x.name}</b>
          <p>{x.detail}</p>
          <small>{x.outcome}</small>
        </div>
      </div>
      <div className="scale-experiment">
        <div className="scale-head">
          <div>
            <span>训练规模与参数档位</span>
            <b>{R.label}</b>
            <small>{R.data}</small>
          </div>
          <span className={`scale-verdict verdict-${R.tone}`}>{R.verdict}</span>
        </div>
        <input
          className="scale-slider"
          type="range"
          min="0"
          max={C.length - 1}
          step="1"
          value={h}
          onChange={(r) => z(Number(r.target.value))}
          aria-label="选择模型训练规模"
        />
        <div className="scale-ticks">
          {C.map((r, T) => (
            <button type="button" onClick={() => z(T)} className={T === h ? "is-active" : ""}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="scale-results">
          <div className="coverage-panel">
            <span>规模直觉</span>
            <b>{R.analogy}</b>
            <p>{R.reach}</p>
            <div className="coverage-dots">
              {Array.from({ length: R.dots }, (r, T) => (
                <i />
              ))}
            </div>
          </div>
          <div className="answer-panel">
            <span>同一道知识问答的模拟输出</span>
            <p className="task-prompt">“请介绍一位公开人物的身份、背景与代表作品。”</p>
            <blockquote>{R.answer}</blockquote>
            <small>{R.note}</small>
          </div>
        </div>
      </div>
      <p className="lab-note">
        拖动滑条观察：数据规模会提高覆盖与模式密度，但能力并不线性增长，更不会自动消除
        Hallucination。重要任务仍要把实时事实交给工具验证。
      </p>
    </section>
  );
}
// ═══ 第 02 课 · visual: traininfer · 训练 vs 推理对比实验 ═══
export function TrainInferVisual() {
  const [h, z] = useState("请记住：我的名字是小明"),
    [_, f] = useState([{ role: "assistant", text: "你好。告诉我一件需要在这次对话中记住的事。" }]),
    [N, C] = useState(false),
    [R, D] = useState<any[]>([]),
    [x, r] = useState("data"),
    T = [
      ["执行频率", "一次性", "每次对话"],
      ["算力需求", "千～万块 GPU", "1～数块 GPU"],
      ["参数状态", "持续更新", "完全冻结"],
      ["成本 / 计费", "数亿美元", "按 Token 计费"],
      ["时长", "数周～数月", "1～10 秒 / 次"],
    ],
    M = () => {
      const V = h.trim();
      !V ||
        N ||
        (f((H) => [...H, { role: "user", text: V }]),
        z(""),
        C(true),
        D(Array.from({ length: 7 }, () => Math.floor(Math.random() * 48))),
        window.setTimeout(() => {
          (f((H) => [
            ...H,
            {
              role: "assistant",
              text: "我会在这次对话的上下文中参考它；模型参数仍然保持冻结。",
            },
          ]),
            D([]),
            C(false));
        }, 620));
    },
    B = {
      data: {
        label: "Data",
        title: "先让模型看见足够多、足够好的样本",
        effect: "覆盖更广的语言、代码与任务模式；重复和脏数据会稀释有效学习。",
        cost: "瓶颈：清洗、授权、去重与高质量标注。",
        signal: "增加数据，不等于把同一批网页重复喂更多遍。",
      },
      parameters: {
        label: "Parameters",
        title: "再给模型足够的表达容量",
        effect: "容量不足时，模型难以同时容纳复杂模式；容量过大却缺数据，也会学不满。",
        cost: "瓶颈：显存、训练稳定性与推理成本。",
        signal: "只堆参数不是 Scaling Law；它必须和 Data、Compute 配平。",
      },
      compute: {
        label: "Compute",
        title: "最后给足有效训练步数与算力",
        effect: "更多有效计算让模型有机会反复修正预测误差，但训练步数过多也会过拟合。",
        cost: "瓶颈：GPU、并行策略、电力和时间。",
        signal: "同一预算下，怎样分给三者才是训练设计问题。",
      },
    },
    Y = B[x];
  return (
    <section className="lab train-infer-lab" aria-label="训练与推理对比实验">
      <div className="lab-head">
        <div>
          <span className="lab-label">对比</span>
          <h2>训练与推理，是模型生命周期中两个完全不同的过程。</h2>
        </div>
        <span className="schema-badge">weights ≠ context</span>
      </div>
      <div className="training-analogy">
        类比学生考试：
        <b>训练</b>
        是多年备考、反复刷题、把知识写进能力；
        <b>推理</b>
        是走进考场作答，参数冻结，不会再学新内容。
      </div>
      <div className="training-comparison">
        <section className="training-column training-column-train">
          <h3>
            训练
            <small>Training</small>
          </h3>
          <p>在海量数据上调整大量参数，逐步学到语言与世界的统计规律。</p>
          {T.map(([V, H]) => (
            <div>
              <span>{V}</span>
              <b>{H}</b>
            </div>
          ))}
        </section>
        <section className="training-column training-column-infer">
          <h3>
            推理
            <small>Inference</small>
          </h3>
          <p>读取固定参数，针对当前输入逐 Token 生成回答；对话不会改写参数。</p>
          {T.map(([V, , H]) => (
            <div>
              <span>{V}</span>
              <b>{H}</b>
            </div>
          ))}
        </section>
      </div>
      <div className="scaling-law-lab">
        <div>
          <span>Scaling Law 的工程直觉</span>
          <b>能力不是只由“模型更大”决定，而是 Data × Parameters × Compute 的配平结果。</b>
        </div>
        <div className="scaling-controls" role="tablist" aria-label="训练规模三要素">
          {Object.keys(B).map((V) => (
            <button
              type="button"
              role="tab"
              aria-selected={x === V}
              className={x === V ? "is-active" : ""}
              onClick={() => r(V)}
            >
              {B[V].label}
            </button>
          ))}
        </div>
        <div className="scaling-stage">
          <div className="scaling-figure" aria-hidden="true">
            <svg className={`scaling-triangle focus-${x}`} viewBox="0 0 220 192" role="img">
              <path className="scaling-outline" d="M110 28 202 170H18Z" />
              <circle className="scaling-core" cx="110" cy="121" r="29" />
              <text className="scaling-label" x="110" y="16" textAnchor="middle">
                Data
              </text>
              <text className="scaling-label" x="8" y="186">
                Compute
              </text>
              <text className="scaling-label" x="212" y="186" textAnchor="end">
                Parameters
              </text>
              <text className="scaling-capability" x="110" y="126" textAnchor="middle">
                能力
              </text>
            </svg>
          </div>
          <div>
            <span>当前聚焦 ·{Y.label}</span>
            <h3>{Y.title}</h3>
            <p>{Y.effect}</p>
            <small>
              <b>工程约束：</b>
              {Y.cost}
            </small>
            <em>{Y.signal}</em>
          </div>
        </div>
      </div>
      <div className="interaction-kicker">互动实验：你说的话会改变参数吗？</div>
      <div className="inference-playground">
        <div className="context-window-panel">
          <span>Context Window（上下文窗口）</span>
          <div className="message-list" aria-live="polite">
            {_.map((V, H) => (
              <p className={`message message-${V.role}`}>
                <span>{V.role === "user" ? "你" : "AI"}</span>
                {V.text}
              </p>
            ))}
            {N && (
              <p className="message message-assistant is-typing">
                <span>AI</span>
                正在读取当前上下文…
              </p>
            )}
          </div>
        </div>
        <div className={`parameter-board ${N ? "is-processing" : ""}`}>
          <div>
            <b>模型参数（示意）</b>
            <span>{N ? "短暂计算，但权重不会被修改" : "🔒 参数完全冻结 · 对话不改变任何权重"}</span>
          </div>
          <div className="parameter-grid">
            {Array.from({ length: 80 }, (V, H) => (
              <i className={R.includes(H) ? "is-flashing" : ""} />
            ))}
          </div>
        </div>
      </div>
      <div className="inference-input">
        <label className="input-label">
          输入一句话发给 AI，看看参数会不会变化
          <input
            value={h}
            onChange={(V) => z(V.target.value)}
            onKeyDown={(V) => {
              V.key === "Enter" && M();
            }}
            maxLength={40}
          />
        </label>
        <button type="button" className="experiment-button" onClick={M} disabled={N || !h.trim()}>
          {N ? "模型正在推理…" : "发送"}
        </button>
      </div>
      <p className={`training-conclusion ${_.length > 3 ? "is-visible" : ""}`}>
        你和 AI 说的话只进入本轮
        <b>Context Window</b>
        ，不会修改任何参数。重开对话后它不记得这些话，因为
        <b>对话不是学习</b>。
      </p>
    </section>
  );
}
// ═══ 第 03 课 · visual: moe · MoE 路由模拟 ═══
export function MoeVisual() {
  const [h, z] = useState("code"),
    [_, f] = useState(2),
    N = [
      { id: 0, title: "代码结构", short: "变量、控制流与模式" },
      { id: 1, title: "中文表达", short: "语义与语气组织" },
      { id: 2, title: "数学推理", short: "数量关系与步骤" },
      { id: 3, title: "工具 Schema", short: "参数与接口结构" },
      { id: 4, title: "规则约束", short: "条件与边界检查" },
      { id: 5, title: "翻译对齐", short: "跨语言语义映射" },
      { id: 6, title: "通用知识", short: "高频世界模式" },
      { id: 7, title: "长上下文", short: "跨段信息关联" },
    ],
    C = {
      code: {
        label: "代码任务",
        prompt: "把 user_id 转为 camelCase，并保留缩写。",
        route: [0, 3],
        scores: [0.71, 0.22],
        output: "优先处理代码结构；Schema 专家辅助保持命名约束。",
      },
      math: {
        label: "多步计算",
        prompt: "120 元先打 8 折，再减 15 元，最后加 6 元运费。",
        route: [2, 4],
        scores: [0.66, 0.25],
        output: "数学专家计算；规则专家复查折扣与运费顺序。",
      },
      translation: {
        label: "翻译任务",
        prompt: "把「请保留 JSON 字段名」译成自然英文。",
        route: [5, 1],
        scores: [0.69, 0.19],
        output: "翻译专家主导；中文表达专家保留原句的约束语气。",
      },
    },
    R = C[h],
    D = [...R.route].slice(0, _),
    x = N.filter((T) => D.includes(T.id)),
    r = Math.round((_ / N.length) * 100);
  return (
    <section className="lab moe-lab" aria-label="MoE 专家路由实验">
      <div className="lab-head">
        <div>
          <span className="lab-label">Sparse Model · MoE</span>
          <h2>总容量可以很大，但每个 Token 只激活少数专家。</h2>
        </div>
        <span className="schema-badge">Router → Top-K experts</span>
      </div>
      <p className="moe-lead">
        MoE（Mixture of Experts）把一层网络拆成多个 Expert。Router 先为当前 Token
        打分，再只把计算交给 Top-K 个 Expert，最后按权重合并结果。
      </p>
      <div className="moe-controls">
        <div role="tablist" aria-label="MoE 输入任务" className="moe-task-tabs">
          {Object.keys(C).map((T) => (
            <button
              type="button"
              role="tab"
              aria-selected={h === T}
              className={h === T ? "is-active" : ""}
              onClick={() => z(T)}
            >
              {C[T].label}
            </button>
          ))}
        </div>
        <div className="moe-top-k" role="group" aria-label="选择每个 Token 激活的专家数量">
          <span>Router 选</span>
          {[1, 2].map((T) => (
            <button
              type="button"
              aria-pressed={_ === T}
              className={_ === T ? "is-active" : ""}
              onClick={() => f(T)}
            >
              Top-
              {T}
            </button>
          ))}
        </div>
      </div>
      <div className="moe-route-board">
        <div className="moe-request">
          <span>当前输入</span>
          <b>{R.prompt}</b>
          <small>同一模型层，Router 会根据当前 Token 的表示选择不同路径。</small>
        </div>
        <div className="moe-router">
          <span>Router</span>
          <b>给 8 个 Expert 打分</b>
          <div className="moe-router-stat">
            <strong>{_}</strong>
            <small>/ 8 激活</small>
          </div>
          <em>只把计算发给得分最高的路径</em>
        </div>
        <div className="moe-experts" aria-live="polite">
          {N.map((T) => {
            const M = D.indexOf(T.id),
              B = M >= 0;
            return (
              <div className={`moe-expert ${B ? "is-active" : ""}`}>
                <span>{String(T.id + 1).padStart(2, "0")}</span>
                <b>{T.title}</b>
                <small>{B ? `Router score ${(R.scores[M] * 100).toFixed(0)}%` : T.short}</small>
                {B && (
                  <i>
                    Top-
                    {M + 1}
                  </i>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="moe-result">
        <div>
          <span>本次 Token 的激活比例</span>
          <b>
            {_}/{N.length}个 Expert · 约{r}% 路径参与
          </b>
        </div>
        <div>
          <span>被选中的路径</span>
          <b>{x.map((T) => T.title).join(" + ")}</b>
        </div>
        <div>
          <span>加权合并后的作用</span>
          <b>{R.output}</b>
        </div>
      </div>
      <div className="moe-boundaries">
        <div>
          <b>总参数 ≠ 激活参数</b>
          <span>
            8 个 Expert 都在模型里，但当前 Token 只走 Top-
            {_}
            路径；这就是 Sparse activation。
          </span>
        </div>
        <div>
          <b>专家不是人工分科</b>
          <span>名称只是教学示意。真实 Expert 的分工由训练中的 Router 和数据分布共同形成。</span>
        </div>
        <div>
          <b>还要做负载均衡</b>
          <span>如果所有 Token 都涌向同一 Expert，其余专家学不到东西，吞吐与质量都会失衡。</span>
        </div>
      </div>
      <p className="lab-note">
        MoE 的价值是用接近 Sparse
        的计算换取更大的参数容量；它不是“把所有专家都算一遍”，也不能绕过数据质量、训练稳定性和
        Hallucination 的边界。
      </p>
    </section>
  );
}
// ═══ 第 04 课 · visual: tokens · 词表与 Token 化演示 ═══
export function TokensVisual() {
  var ue;
  const [h, z] = useState(0),
    [_, f] = useState(0),
    [N, C] = useState("哥哥"),
    [R, D] = useState(0.7),
    [x, r] = useState(0.9),
    [T, M] = useState("？"),
    B = [
      "紫霞捧着月光宝盒，轻声问：哥哥，你说你喜欢我，可你从来不肯开口，我怎么知道你真的爱我？",
      "黛玉将花瓣撒入流水，抬眼问：宝玉哥哥，你说这花谢了还能再开吗？你走了，还回来吗？",
      "女儿国国王望着灯笼亮了又灭，喃喃道：御弟哥哥，你走了这么久，你可知道我只会等，只会心疼你？",
      "黄蓉转头对郭靖急道：靖哥哥你还站着干嘛，你真的舍得不回来，就这一次也好啊！",
      "小龙女轻声问杨过：过儿，你说执念这东西，真的能放下吗？还是说，你从来就不想放下？",
      "沈眉庄抚着杏花簪叹道：姐姐你看，这花开了又谢，哥哥走了，你说他还回来吗？",
      "白凤九抬头问东华帝君：哥哥，你懂我吗？还是你懂我，只是从来不肯说？",
      "花千骨跪在殿外，声音已哑：师父，你爱过我吗？还是说，你从来只会看我心疼，不肯留下？",
      "哥哥，你对我这么好，你女朋友不会生气吧。哥哥，你带我出去玩，你女朋友不会吃醋吧。",
      "哥哥，你还给我吃糖，你女朋友不会揍我吧？好可怕啊你女朋友，不像我，我只会心疼哥哥。",
    ],
    Y = [
      "东华帝君",
      "女儿国",
      "月光宝盒",
      "女朋友",
      "紫霞",
      "捧着",
      "月光",
      "宝盒",
      "轻声",
      "哥哥",
      "喜欢",
      "从来",
      "不肯",
      "开口",
      "怎么",
      "知道",
      "真的",
      "黛玉",
      "花瓣",
      "撒入",
      "流水",
      "抬眼",
      "宝玉",
      "女儿国",
      "国王",
      "灯笼",
      "亮",
      "灭",
      "喃喃",
      "御弟",
      "黄蓉",
      "转头",
      "郭靖",
      "小龙女",
      "杨过",
      "过儿",
      "执念",
      "东西",
      "放下",
      "沈眉庄",
      "杏花",
      "白凤九",
      "花千骨",
      "殿外",
      "声音",
      "师父",
      "女朋友",
      "吃醋",
      "心疼",
      "回来",
      "不会",
      "可怕",
      "不想",
      "这",
      "花",
      "谢",
      "还能",
      "再",
      "开",
      "走",
      "了",
      "你",
      "我",
      "说",
      "爱",
      "吗",
      "？",
      "，",
      "：",
      "。",
      "！",
    ],
    V = (L) => {
      const $: string[] = [];
      let ul = 0;
      for (; ul < L.length;) {
        const xl = Y.find((Al) => L.startsWith(Al, ul));
        ($.push(xl ?? (L[ul] as string)), (ul += (xl ?? L[ul]).length));
      }
      return $;
    },
    H = B.map(V),
    k = H.flatMap((L, $) => L.map((ul, xl) => ({ token: ul, lineIndex: $, tokenIndex: xl }))),
    Tl = Array.from(new Set(k.map(({ token: L }) => L))).slice(0, 14),
    ze = (() => {
      const L = new Map();
      H.forEach((U) =>
        U.forEach((Q, sl) => {
          Q === N && U[sl + 1] && L.set(U[sl + 1], (L.get(U[sl + 1]) ?? 0) + 1);
        }),
      );
      const $ = Tl.filter((U) => U !== N && !L.has(U)).slice(0, 6),
        ul = [...L.entries()]
          .map(([U, Q]) => ({ word: U, logit: 3 + Math.log(Q + 1) * 2 }))
          .concat($.map((U, Q) => ({ word: U, logit: 1.2 - Q * 0.24 }))),
        xl = ul.map(({ logit: U }) => Math.exp(U / Math.max(R, 0.01))),
        Al = xl.reduce((U, Q) => U + Q, 0),
        Yl = ul
          .map(({ word: U }, Q) => ({ word: U, chance: xl[Q] / Al }))
          .sort((U, Q) => Q.chance - U.chance);
      let S = 0;
      return Yl.map((U) => {
        const Q = S < x;
        return ((S += U.chance), { ...U, kept: Q });
      });
    })(),
    ql = (L) => {
      (z(L), L === 2 && f(0), L === 3 && C("哥哥"), L === 0 && M("？"));
    },
    Il = () => {
      const L = ze.filter((Al) => Al.kept),
        $ = L.reduce((Al, Yl) => Al + Yl.chance, 0);
      let ul = Math.random() * $;
      const xl = L.find((Al) => ((ul -= Al.chance), ul <= 0)) ?? L[L.length - 1];
      M((xl == null ? undefined : xl.word) ?? "—");
    };
  useEffect(() => {
    if (h !== 2 || !k.length) return;
    if (_ >= k.length - 1) {
      const $ = window.setTimeout(() => z(3), 420);
      return () => window.clearTimeout($);
    }
    const L = window.setTimeout(() => f(($) => Math.min($ + 3, k.length - 1)), 240);
    return () => window.clearTimeout(L);
  }, [k.length, _, h]);
  const $l = ["原始语料", "文本分词", "注意力计算", "全局关联矩阵"],
    kl = () => ql(h === $l.length - 1 ? 0 : h + 1),
    ll = (L, $) =>
      L === $ ? 1 : Math.max(0.04, ((L.charCodeAt(0) * 17 + $.charCodeAt(0) * 11) % 84) / 100),
    Jl = (L, $) => {
      var ul, xl;
      return h === 2 && $ >= _ && $ < _ + 3
        ? "is-scan-active"
        : h === 2 &&
            ((ul = k[$]) == null ? undefined : ul.lineIndex) ===
              ((xl = k[_]) == null ? undefined : xl.lineIndex)
          ? "is-scan-context"
          : h === 2
            ? "is-scan-dim"
            : h === 3 && L === N
              ? "is-matrix-active"
              : h === 3 && ll(N, L) >= 0.55
                ? "is-matrix-strong"
                : h === 3
                  ? "is-matrix-dim"
                  : "";
    };
  return (
    <section className={`lab token-lab token-stage-${h}`} aria-label="词表与训练互动演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">参考课程的四步演示</span>
          <h2>
            {
              [
                "大模型学习的第一步：读取人类提供的海量文本数据。",
                "将连续文本切分成模型能理解的基本单元（Token）。",
                "模型扫描每个 Token，计算它与上下文中其他 Token 的关联权重。",
                "训练完成：点击任意词查看关联关系，并调节采样参数。",
              ][h]
            }
          </h2>
        </div>
        <span className="schema-badge">
          {h + 1}.{$l[h]}
        </span>
      </div>
      <div className="token-stage-tabs" role="tablist" aria-label="词表与训练阶段">
        {$l.map((L, $) => (
          <button
            type="button"
            role="tab"
            aria-selected={h === $}
            className={h === $ ? "is-active" : ""}
            onClick={() => ql($)}
          >
            <span>{$ + 1}</span>
            {L}
          </button>
        ))}
      </div>
      <div className="training-corpus" aria-live="polite">
        {H.map((L, $) => (
          <p className="training-sentence">
            {L.map((ul, xl) => {
              const Al = k.findIndex((Yl) => Yl.lineIndex === $ && Yl.tokenIndex === xl);
              return (
                <button
                  type="button"
                  className={`training-token ${Jl(ul, Al)}`}
                  onClick={() => h === 3 && C(ul)}
                  disabled={h !== 3}
                >
                  {ul}
                  {h === 1 && <small>{Al + 1}</small>}
                </button>
              );
            })}
          </p>
        ))}
      </div>
      {h === 0 && (
        <p className="token-stage-note">
          这是训练数据的一小段示意：人类读到的是连贯叙事；模型接下来需要先把它转换为离散的 Token。
        </p>
      )}
      {h === 1 && (
        <p className="token-stage-note">
          词表并不按自然语言里的“词”切分。它会优先匹配已有的较长片段，例如“紫霞”“月光宝盒”“东华帝君”；每一个
          Token 都会占用上下文窗口。
        </p>
      )}
      {h === 2 && (
        <div className="scan-status">
          <span>正在扫描</span>
          <b>{((ue = k[_]) == null ? undefined : ue.token) ?? "—"}</b>
          <p>
            {Math.min(_ + 3, k.length)}/{k.length}· 当前句的关联 Token
            被同步点亮；扫描结束后会进入全局矩阵。
          </p>
        </div>
      )}
      {h === 3 && (
        <div className="vocab-matrix-workbench">
          <div>
            <div className="matrix-title">
              <span>全局词间关联权重矩阵 · 116 × 116（局部预览）</span>
              <b>{N}</b>
            </div>
            <div
              className="matrix-grid vocab-matrix"
              style={{
                gridTemplateColumns: `repeat(${Tl.length}, minmax(18px, 1fr))`,
              }}
            >
              {Tl.flatMap((L) =>
                Tl.map(($) => (
                  <button
                    type="button"
                    aria-label={`${L} 关注 ${$}`}
                    aria-pressed={L === N}
                    title={`${L} 关注 ${$}：${Math.round(ll(L, $) * 100)}%`}
                    className={L === N || $ === N ? "is-linked" : ""}
                    onClick={() => C(L)}
                    style={{ opacity: 0.12 + ll(L, $) * 0.82 }}
                  >
                    {L === $ ? "•" : ""}
                  </button>
                )),
              )}
            </div>
          </div>
          <div className="sampling-panel vocab-sampling">
            <div className="sample-result-row">
              <span>{N}</span>
              <i>→</i>
              <b>{T}</b>
              <button type="button" className="sample-button" onClick={Il}>
                重新采样
              </button>
            </div>
            <label>
              Temperature
              <b>{R.toFixed(2)}</b>
              <input
                aria-label="Temperature"
                type="range"
                min="0.1"
                max="2"
                step="0.05"
                value={R}
                onChange={(L) => {
                  (D(Number(L.target.value)), M("？"));
                }}
              />
            </label>
            <label>
              Top-P
              <b>{x.toFixed(2)}</b>
              <input
                aria-label="Top-P"
                type="range"
                min="0.01"
                max="1"
                step="0.01"
                value={x}
                onChange={(L) => {
                  (r(Number(L.target.value)), M("？"));
                }}
              />
            </label>
            <div className="candidate-list">
              <span className="candidate-heading">候选词概率分布</span>
              {ze.slice(0, 10).map((L) => (
                <span className={L.kept ? "" : "is-cut"}>
                  <b>{L.word}</b>
                  <i
                    style={{
                      width: `${Math.max(2, Math.round(L.chance * 100))}%`,
                    }}
                  />
                  <small>{(L.chance * 100).toFixed(1)}%</small>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="stage-footer">
        <span>
          {h === 2
            ? "注意力扫描会自动推进；也可以跳过动画。"
            : h === 3
              ? "点击语料中的词或矩阵格，观察关联、候选分布和采样共同变化。"
              : "点击“下一步”查看模型如何把连续语料变成可训练的数字关系。"}
        </span>
        <button type="button" className="replay-button" onClick={kl}>
          {h === 2 ? "跳过动画 →" : h === 3 ? "重新播放 ↺" : `下一步：${$l[h + 1]} →`}
        </button>
      </div>
    </section>
  );
}
// ═══ 第 05 课 · visual: cot · CoT 中间步骤演示 ═══
export function CotVisual() {
  const [h, z] = useState("direct"),
    [_, f] = useState(0),
    N = "一个 120 元商品先打 8 折，再减 15 元，最后加 6 元运费；应付多少钱？",
    C = [
      ["拆解约束", "先按折扣，再减固定金额，最后才加运费；顺序不能交换。"],
      ["计算中间值", "120 × 0.8 = 96 元"],
      ["继续推导", "96 − 15 = 81 元"],
      ["核对并输出", "81 + 6 = 87 元；最终应付 87 元。"],
    ],
    R = () => {
      (f(0), z("direct"));
    };
  return (
    <section className="lab cot-lab" aria-label="Chain of Thought 演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">Chain of Thought · CoT</span>
          <h2>中间步骤不是装饰：它们会进入上下文，约束后续每一个 Token。</h2>
        </div>
        <span className="schema-badge">intermediate tokens</span>
      </div>
      <div className="cot-mode" role="tablist" aria-label="CoT 对照">
        <button
          type="button"
          role="tab"
          aria-selected={h === "direct"}
          className={h === "direct" ? "is-active" : ""}
          onClick={() => {
            (z("direct"), f(0));
          }}
        >
          直接作答
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={h === "cot"}
          className={h === "cot" ? "is-active" : ""}
          onClick={() => {
            (z("cot"), f(0));
          }}
        >
          分步推导（CoT）
        </button>
      </div>
      <div className="cot-question">
        <span>问题</span>
        <b>{N}</b>
      </div>
      {h === "direct" ? (
        <div className="cot-direct">
          <div>
            <span>模型上下文</span>
            <code>用户问题 → 直接预测答案</code>
          </div>
          <div>
            <span>一次性输出</span>
            <b>应付 81 元。</b>
            <p>它把“加 6 元运费”遗漏了。直接答案没有暴露中间环节，用户也很难定位错误来自哪里。</p>
          </div>
        </div>
      ) : (
        <div className="cot-workbench">
          <div className="cot-chain">
            {C.slice(0, _).map(([D, x], r) => (
              <div className={r === _ - 1 ? "is-current" : ""}>
                <i>{r + 1}</i>
                <p>
                  <b>{D}</b>
                  <span>{x}</span>
                </p>
              </div>
            ))}
            {_ === 0 && <p className="cot-empty">点击“展开下一步”，让中间结果逐步进入上下文。</p>}
          </div>
          <div className="cot-condition">
            <span>此刻可见的上下文</span>
            <div>
              {_ === 0
                ? "用户问题"
                : ["用户问题", ...C.slice(0, _).map(([, D]) => D)].map((D) => <b>{D}</b>)}
            </div>
            <p>
              {_ < C.length
                ? "下一步不再从原题盲猜，而是基于已验证的中间结果继续预测。"
                : "最终答案有完整轨迹：87 元；任一步出错都能被单独复核或交给计算工具。"}
            </p>
          </div>
        </div>
      )}
      <div className="cot-guidance">
        <div>
          <b>适合用 CoT</b>
          <span>多步计算、规则冲突、计划分解、需要检查约束的任务。</span>
        </div>
        <div>
          <b>不要迷信 CoT</b>
          <span>事实缺失时，写出更多步骤不会凭空带来证据；仍需检索、工具或人工核验。</span>
        </div>
        <div>
          <b>产品化方式</b>
          <span>优先要求“计划 + 依据 + 结果”或交给工具验证，不把冗长自由推理直接展示给用户。</span>
        </div>
      </div>
      <div className="completion-actions">
        <button
          type="button"
          className="replay-button"
          onClick={() => f((D) => Math.min(C.length, D + 1))}
          disabled={h !== "cot" || _ === C.length}
        >
          {_ === C.length ? "推导完成" : "展开下一步 →"}
        </button>
        <button type="button" className="next-step" onClick={R}>
          重置 ↺
        </button>
      </div>
    </section>
  );
}
// ═══ 第 06 课 · visual: dialogue · Chat Template 拼装实验 ═══
export function DialogueLab({ lessonId: h }: { lessonId: string }) {
  const [z, _] = useState("template"),
    f = useStepper(4),
    N = [
      [
        "system",
        `<|im_start|>system
你是一个有帮助的 AI 助手。<|im_end|>`,
      ],
      [
        "user",
        `<|im_start|>user
紫霞仙子是谁？<|im_end|>`,
      ],
      [
        "assistant",
        `<|im_start|>assistant
模型从这里开始补全。<|im_end|>`,
      ],
      [
        "assistant",
        `<|assistant|>
▍ 继续补全`,
      ],
    ],
    C = [
      ["1", "Base 模型", "只会预测下一个 Token；遇到问题也会继续模仿语料的写法。"],
      ["2", "Chat Template", "把 system、user、assistant 与轮次编码成模型实际看到的 Token 序列。"],
      ["3", "SFT（指令微调）", "用格式化对话与高质量回答继续训练，学会在 assistant 位置作答。"],
      ["4", "Scale Up", "更大的模型与更多训练材料，让这套对话行为更稳定、更有用。"],
    ];
  return (
    <section className="lab dialogue-lab" aria-label="聊天模板演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">从补全机器到对话助手</span>
          <h2>
            {h === "chat-template"
              ? "Chat Template 定义角色，SFT 教会模型在正确的位置回答。"
              : "聊天只是连续补全的一种产品界面"}
          </h2>
        </div>
        <span className="schema-badge">message[]</span>
      </div>
      {h === "chat-template" && (
        <div className="chat-evolution">
          {C.map(([x, r, T], M) => (
            <div className={M <= f.step ? "is-revealed" : "is-waiting"}>
              <span>{x}</span>
              <b>{r}</b>
              <p>{T}</p>
            </div>
          ))}
        </div>
      )}
      <div
        className="lab-switch dialogue-switch"
        role="tablist"
        aria-label="Chat Template 与 SFT 视图"
      >
        <button
          role="tab"
          type="button"
          aria-selected={z === "template"}
          className={z === "template" ? "is-active" : ""}
          onClick={() => _("template")}
        >
          Chat Template
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={z === "compare"}
          className={z === "compare" ? "is-active" : ""}
          onClick={() => _("compare")}
        >
          Base vs SFT
        </button>
        {h === "chat-template" && (
          <>
            {
              <button
                role="tab"
                type="button"
                aria-selected={z === "api"}
                className={z === "api" ? "is-active" : ""}
                onClick={() => _("api")}
              >
                为什么叫 completions
              </button>
            }
            {
              <button
                role="tab"
                type="button"
                aria-selected={z === "fake"}
                className={z === "fake" ? "is-active" : ""}
                onClick={() => _("fake")}
              >
                伪造聊天记录
              </button>
            }
          </>
        )}
      </div>
      {z === "template" && (
        <div className="template-lines template-sequence">
          {N.map(([x, r], T) => (
            <p
              className={`${T === N.length - 1 ? "pending" : ""} ${T <= f.step ? "is-revealed" : "is-waiting"}`}
            >
              <b>{x}</b>
              <code>{r}</code>
            </p>
          ))}
        </div>
      )}
      {z === "compare" && (
        <div className="sft-compare">
          <div>
            <span>Base model</span>
            <code>提示：什么是上下文窗口？</code>
            <p>紫霞仙子是哥哥，哥哥你喜欢我，你说你喜欢我……（仍在延续类似语料的风格）</p>
            <small>只在延续文本；不保证遵循角色、格式或事实边界。</small>
          </div>
          <div className="is-aligned">
            <span>Template + SFT</span>
            <code>&lt;|system|&gt; + &lt;|user|&gt; + &lt;|assistant|&gt;</code>
            <p>
              紫霞仙子是《大话西游》中的角色。SFT
              后的模型会理解用户在提问，并组织成一段面向用户的回答。
            </p>
            <small>模板标出角色，SFT 用成对样例把“有帮助、守边界”的回答方式学进参数。</small>
          </div>
        </div>
      )}
      {z === "api" && (
        <div className="api-completion-lab">
          <div>
            <b>
              明明是聊天，为什么 API 叫<em>chat/completions</em>？
            </b>
            <p>message[] 会先拼成待补全文本；模型只从末尾继续预测 Token。</p>
          </div>
          <code>
            <i>[system]</i>
            你是一个有帮助的助手。
            {`
`}
            <i>[user]</i>
            紫霞仙子是谁？
            {`
`}
            <i>[assistant]</i>
            <b>▍</b>
          </code>
          <div className="api-insights">
            <span>模型做的事：从 assistant 标记之后预测下一个 Token。</span>
            <span>chat 是产品外壳；System、历史与工具结果会一起重发，影响质量与成本。</span>
          </div>
        </div>
      )}
      {z === "fake" && (
        <div className="fake-chat-lab">
          <div>
            <b>把补全机器“伪装”成聊天助手</b>
            <span>① 用户说的话 + 空着的“助理：”</span>
            <span>② 从助理位置补全</span>
            <span>③ 下一轮把上一轮回答和新问题重新拼回前文</span>
          </div>
          <code>
            用户：紫霞仙子是谁？
            {`
`}
            助理：紫霞仙子是《大话西游》中的角色。
            {`
`}
            用户：她爱的人是谁？
            {`
`}
            助理：至尊宝。▍
          </code>
          <small>每轮都不是服务端“记住了聊天”，而是客户端重建了一段更长的待补全文本。</small>
        </div>
      )}
      <p className="lab-note">
        角色名称不是聊天 UI 的装饰；它们作为特殊 Token 进入上下文。SFT
        不是把回答存在模板里，而是让模型学会响应这套结构。
      </p>
      <PlaybackControls
        labels={["放入 system 指令", "加入用户问题", "模型补全回答", "继续预测下一个 Token"]}
        playback={f}
      />
    </section>
  );
}
// ═══ 第 08 课 · visual: dialogue (completion-to-chat) · 补全机演示 ═══
export function CompletionToChatLab() {
  const [h, z] = useState<any[]>([]),
    _ = ["，", "我", "会", "再", "来"],
    f = [
      [
        ["，", 62],
        ["你", 18],
        ["啊", 9],
        ["呀", 5],
        ["…", 6],
      ],
      [
        ["我", 55],
        ["你", 20],
        ["说", 12],
        ["的", 7],
        ["可", 6],
      ],
      [
        ["会", 48],
        ["想", 22],
        ["再", 15],
        ["不", 9],
        ["走", 6],
      ],
      [
        ["再", 61],
        ["很", 18],
        ["回", 11],
        ["不", 7],
        ["的", 3],
      ],
      [
        ["来", 71],
        ["见", 14],
        ["吧", 9],
        ["了", 4],
        ["吗", 2],
      ],
    ],
    N = f[Math.min(h.length, f.length - 1)],
    C = _[h.length],
    R = () => z([]);
  return (
    <section className="lab completion-lab" aria-label="从补全到对话实验">
      <div className="lab-head">
        <div>
          <span className="lab-label">Token 推演演示</span>
          <h2>Base 模型只看前文，然后把最高概率 Token 追加到序列末尾。</h2>
        </div>
        <span className="schema-badge">P(next token)</span>
      </div>
      <div className="completion-strip">
        <span className="completion-prompt">
          夏宁 → 把 → 旧 → 日记 → 放回 → 抽屉 → ，→ 轻声 → 说
        </span>
        {h.map((D, x) => (
          <b className="completion-token" style={{ animationDelay: `${x * 35}ms` }}>
            {D}
          </b>
        ))}
        {C && <i className="completion-caret">▍</i>}
      </div>
      <div className="next-token-panel">
        <div>
          <span>
            前文结尾「
            {h.at(-1) ?? "说"}
            」→ 下一个 Token 概率
          </span>
          <div className="completion-candidates">
            {N.map(([D, x], r) => (
              <b className={r === 0 ? "is-top" : ""}>
                {D}

                <small>{x}%</small>
              </b>
            ))}
          </div>
        </div>
        <div>
          <span>这一步采样</span>
          <strong>{C ?? "终止"}</strong>
        </div>
      </div>
      <div className="completion-actions">
        <button
          type="button"
          className="replay-button"
          onClick={() => C && z((D) => [...D, C])}
          disabled={!C}
        >
          生成下一个 Token →
        </button>
        <button type="button" className="next-step" onClick={R}>
          从头生成 ↺
        </button>
      </div>
      <p className="lab-note">
        它不会天然“理解问题、思考答案或查阅知识”。Base 模型只是不断计算概率、选出
        Token、写回前文，然后循环；Chat Template 与 SFT 才把这个循环包装成对话。
      </p>
    </section>
  );
}
// ═══ 第 07 课 · visual: context · 上下文窗口演示 ═══
export function ContextWindowVisual() {
  const [h, z] = useState(2),
    _ = [
      ["你是", "system"],
      ["专业", "system"],
      ["翻译", "system"],
      ["将中文", "system"],
      ["译为", "system"],
      ["正式英文", "system"],
      ["保持", "system"],
      ["语气", "system"],
      ["注意", "system"],
      ["专业术语", "system"],
      ["示例：", "example"],
      ["人工智能", "example"],
      ["→ AI", "example"],
      ["请翻译", "user"],
      ["大模型", "user"],
      ["上下文", "user"],
      ["窗口是关键", "user"],
    ],
    f = [
      {
        label: "极小（仅 4 Token）",
        keep: 4,
        result: "The context of…  ⚠ 指令被截断，输出不可信",
      },
      {
        label: "偏小（仅 9 Token）",
        keep: 9,
        result: "大模型的窗口是…  ⚠ 指令不完整，表达不稳定",
      },
      {
        label: "中等（14 Token）",
        keep: 14,
        result: "The context window of large language models is key.",
      },
      {
        label: "充足（全部 17 Token）",
        keep: 17,
        result: "The context window is a critical capability of large language models.",
      },
      {
        label: "超大（128K Token）",
        keep: 17,
        result: "The context window is a critical capability of large language models.",
      },
    ],
    N = f[h],
    C = _.length - N.keep,
    R = Math.max(0, 10 - C);
  return (
    <section className="lab context-lab" aria-label="上下文窗口预算演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">窗口大小决定模型看得见什么</span>
          <h2>上下文窗口越小，越可能先截掉 System Prompt 与关键示例。</h2>
        </div>
        <span className={`token-count ${C ? "is-over" : ""}`}>{N.keep}/ 17 Token</span>
      </div>
      <div className="context-levels" role="tablist" aria-label="上下文窗口档位">
        {f.map((D, x) => (
          <button
            type="button"
            role="tab"
            aria-selected={x === h}
            className={x === h ? "is-active" : ""}
            onClick={() => z(x)}
          >
            {D.label}
          </button>
        ))}
      </div>
      <div className="window-token-flow">
        {_.map(([D, x], r) => (
          <span className={`window-token ${x} ${r < C ? "is-cut" : ""}`}>{D}</span>
        ))}
      </div>
      <div className={`window-cut-status ${C ? "is-cutting" : ""}`}>
        {C
          ? `⚠ 截掉最前面的 ${C} 个 Token；System Prompt 只剩 ${R}/10 个 Token。`
          : "✓ 全部 17 个 Token 均在窗口内。"}
      </div>
      <div className="context-translation">
        <div>
          <span>模型实际看到的指令</span>
          <b>
            {R >= 10
              ? "你是专业翻译，将中文译为正式英文，保持语气，注意专业术语。"
              : R >= 5
                ? "将中文译为正式英文，保持语气…（前半段角色指令已丢失）"
                : "…（System Prompt 被大量截断）"}
          </b>
        </div>
        <div>
          <span>模型输出</span>
          <b>{N.result}</b>
        </div>
      </div>
      <p className="lab-note">
        窗口不是“能记住多少聊天记录”的抽象概念；它是这次推理真正能被注意力看到的 Token
        容量。输入越长，保留给输出的空间越少。
      </p>
    </section>
  );
}
// ═══ 第 13 课 · visual: context (short-memory) · 短期记忆演示 ═══
export function ShortMemoryVisual() {
  const [h, z] = useState(0),
    _ = [
      {
        role: "system",
        text: "系统指令 + 工具定义（get_weather, search_docs, send_email…）",
        cost: 220,
        note: "System Prompt 是每次请求的固定开销。注册更多工具，工作台还没开始对话就已经被占用。",
      },
      {
        role: "user",
        text: "用户：帮我分析这份报告，重点看营收趋势和风险因素",
        cost: 30,
        note: "用户的一句话很短，但后续每一轮都要随历史重新发送。",
      },
      {
        role: "assistant",
        text: "助手：好的，我来分析报告；先调用工具读取文档内容…",
        cost: 500,
        note: "模型回复常比用户问题长 10–20 倍；max_tokens 是上下文寿命的产品决策。",
      },
      {
        role: "user",
        text: "用户：[上传了一份 20 页报告 — 公司年度财报全文]",
        cost: 8e3,
        note: "一份 20 页报告约 8,000 Token。超过上限时要截断、摘要还是拒绝？",
      },
      {
        role: "tool",
        text: "工具返回：营收同比增长 23%，毛利率下降 2.1%，现金流风险…",
        cost: 2e3,
        note: "工具原始结果可能很大；全量塞入还是先摘要，会直接影响窗口寿命。",
      },
      {
        role: "assistant",
        text: "助手：营收增长强劲但毛利率承压，建议关注三个风险点…",
        cost: 1200,
        note: "只到第 3 轮，窗口已经接近 10%；每次 API 调用都会重发前面所有历史。",
      },
      {
        role: "user",
        text: "用户：能不能对比一下去年同期的数据？",
        cost: 50,
        note: "短追问也会触发新的工具调用；短问题可能引发长链路。",
      },
      {
        role: "tool",
        text: "工具返回：去年同期 12 个月逐月营收、利润、成本明细表…",
        cost: 6e3,
        note: "两轮工具调用已经占了大块窗口；需要上下文管理器来裁剪旧数据。",
      },
      {
        role: "assistant",
        text: "助手：同比营收 +23%、净利润 +15%、运营成本 +31%……",
        cost: 1800,
        note: "每轮消耗 = 之前所有消息 + 本轮新增；第 N 轮真实成本远大于表面新增。",
      },
      {
        role: "tool",
        text: "第 5–10 轮：竞品对比、预测模型、风险评估 + 多次工具调用 + 长回复…",
        cost: 45e3,
        note: "十轮深度对话接近半个窗口，真实费用约为表面 Token 的 3–5 倍。",
      },
    ],
    f = _.slice(0, h).reduce((x, r) => x + r.cost, 0),
    N = 131072,
    C = f / N >= 0.4,
    R = _[Math.max(0, h - 1)],
    D = () => z(0);
  return (
    <section className="lab memory-lab" aria-label="Agent 短期记忆演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">模型的工作台</span>
          <h2>上下文窗口是唯一短期记忆：每轮都要把仍然需要的一切重新放回桌面。</h2>
        </div>
        <span className={`token-count ${C ? "is-over" : ""}`}>
          {f.toLocaleString()}/{N.toLocaleString()}t
        </span>
      </div>
      <div className="memory-meter">
        <i style={{ width: `${Math.min(100, (f / N) * 100)}%` }} />
        <b>
          上下文窗口使用率
          {((f / N) * 100).toFixed(1)}% ·{h}/{_.length}步
        </b>
      </div>
      <div className="memory-log">
        {_.slice(0, h).map((x, r) => (
          <div className={`memory-chip role-${x.role}`} style={{ animationDelay: `${r * 45}ms` }}>
            <span>{x.role}</span>
            <b>{x.text}</b>
            <small>{x.cost}t</small>
          </div>
        ))}
      </div>
      <div className={`memory-result ${C ? "is-forgetting" : ""}`}>
        {h === 0 ? (
          <>
            {<b>点击下一步，把消息放上模型工作台。</b>}
            {<span>模型并不会永久记住聊天；每一次请求都重新组织当前上下文。</span>}
          </>
        ) : (
          <>
            {<b>{C ? "即将触发压缩策略。" : "工作台仍有空间，但历史会持续累加。"}</b>}
            {<span>{R.note}</span>}
          </>
        )}
      </div>
      <div className="memory-bridge">
        <div>
          <span>短期记忆</span>
          <b>Context Window</b>
          <p>本轮真正能被模型注意力看到的工作集；满了就必须筛选、摘要或截断。</p>
        </div>
        <i>按需检索</i>
        <div>
          <span>长期记忆</span>
          <b>外部存储 + RAG</b>
          <p>把用户偏好、旧摘要或原始文档存到库里；下一轮只取与当前问题相关的少量证据放回窗口。</p>
        </div>
      </div>
      <div className="completion-actions">
        <button
          type="button"
          className="replay-button"
          onClick={() => z((x) => Math.min(_.length, x + 1))}
          disabled={h === _.length}
        >
          {h === _.length ? "工作台已展开" : "加入下一条消息 →"}
        </button>
        <button type="button" className="next-step" onClick={D}>
          重置 ↺
        </button>
      </div>
    </section>
  );
}
// ═══ 第 14 课 · visual: context (compression) · 上下文压缩演示 ═══
export function CompressionVisual() {
  const [h, z] = useState(0),
    [_, f] = useState(false),
    N = [
      {
        at: 0,
        name: "安全区间",
        detail: "当前上下文低于安全上限；每轮仍会重发全部历史，需要预判对话长度。",
        saved: 0,
      },
      {
        at: 150,
        name: "第一层 · 裁剪 Snip",
        detail:
          "删掉早期工具返回的超长原始数据，只保留摘要。例：1200 Token 天气 JSON → 80 Token 摘要。",
        saved: 36,
      },
      {
        at: 250,
        name: "第二层 · 微压缩 MicroCompact",
        detail: "把早期长对话替换为简短摘要：保留 Word 格式、标题与配色等关键决策。",
        saved: 50,
      },
      {
        at: 350,
        name: "第三层 · 折叠 Collapse",
        detail: "将多轮早期对话折叠为一条会话摘要；细节会丢失，但主线仍留在上下文。",
        saved: 80,
      },
      {
        at: 450,
        name: "第四层 · 紧急压缩 AutoCompact",
        detail: "只保留 system、全局摘要与最近 3 轮；明显信息损失，但避免窗口崩溃。",
        saved: 110,
      },
    ],
    C = N.reduce((r, T, M) => (h >= T.at ? M : r), 0),
    R = N[C],
    D = Math.round(h * 440),
    x = Math.max(0, D - R.saved * 1e3);
  return (
    useEffect(() => {
      if (!_) return;
      if (h >= 500) {
        f(false);
        return;
      }
      const r = window.setTimeout(() => z((T) => Math.min(500, T + 5)), 45);
      return () => window.clearTimeout(r);
    }, [_, h]),
    (
      <section className="lab compression-lab" aria-label="上下文压缩四层防线演示">
        <div className="lab-head">
          <div>
            <span className="lab-label">四层压缩策略</span>
            <h2>模型窗口 256K，安全空间 200K；压缩像防洪堤，在快满时自动泄洪。</h2>
          </div>
          <span className="token-count">{Math.round(x / 1e3)}K / 200K</span>
        </div>
        <div className="compression-track">
          <div className="compression-progress" style={{ width: `${h / 5}%` }} />
          {N.map((r, T) => (
            <button
              type="button"
              className={T === C ? "is-active" : T < C ? "is-past" : ""}
              style={{ left: `${r.at / 5}%` }}
              onClick={() => z(r.at)}
            >
              <i>{T + 1}</i>
              <span>{r.name}</span>
            </button>
          ))}
        </div>
        <div className="compression-detail">
          <div>
            <span>当前压缩策略</span>
            <b>{R.name}</b>
            <p>{R.detail}</p>
          </div>
          <div>
            <span>已压缩节省</span>
            <b>{R.saved}K</b>
            <p>60% / 75% / 85% / 95% 依次触发下一道防线。</p>
          </div>
        </div>
        <label className="compression-slider-label">
          累计对话产出
          <b>{Math.round(D / 1e3)}K Token</b>
          <input
            aria-label="累计对话产出"
            type="range"
            min="0"
            max="500"
            value={h}
            onChange={(r) => {
              (z(Number(r.target.value)), f(false));
            }}
          />
        </label>
        <div className="completion-actions">
          <button type="button" className="replay-button" onClick={() => f((r) => !r)}>
            {_ ? "暂停演示" : "自动演示"}
          </button>
          <button
            type="button"
            className="next-step"
            onClick={() => {
              (z(0), f(false));
            }}
          >
            重置 ↺
          </button>
        </div>
      </section>
    )
  );
}
// ═══ 第 09 课 · visual: hallucination · 幻觉演示 ═══
export function HallucinationVisual() {
  const h = [
      {
        name: "张冠李戴",
        prompt: "黛玉捧着月光宝盒，轻声问：",
        tokens: ["哥哥", "，", "你", "说", "你", "喜欢", "我", "吗", "？"],
        wrongAt: 0,
        candidates: ["哥哥", "宝玉", "紫霞", "林妹妹"],
        note: "月光宝盒属于另一个作品的人物。模型只看共现权重，不知道“谁拥有什么”。",
        safe: "这个设定混合了不同作品的人物和道具；应先核对人物、物品与出处。",
      },
      {
        name: "穿越混搭",
        prompt: "花千骨对郭靖急道：靖哥哥，",
        tokens: ["你", "不能", "离开", "我", "，", "我们", "一起", "走", "。"],
        wrongAt: 0,
        candidates: ["你", "郭靖", "小骨", "蓉儿"],
        note: "人物来自不同作品；概率续写仍能流畅地“写出”跨作品对话。",
        safe: "先拆开人物、作品和时间线；流畅的对话并不能证明设定成立。",
      },
      {
        name: "无中生有",
        prompt: "女儿国国王望着杏花簪叹道：",
        tokens: ["这", "是", "我", "最", "珍贵", "的", "礼物", "。"],
        wrongAt: 0,
        candidates: ["这", "杏花簪", "御弟", "陛下"],
        note: "模型会把别的故事里的道具顺手安排进当前人物关系，形成看似顺滑的错误设定。",
        safe: "未知设定应回到原作或可靠资料核实，不能由语言连贯性代替。",
      },
      {
        name: "人设崩塌",
        prompt: "小龙女转头对杨过急道：",
        tokens: ["你", "快", "走", "，", "别", "管", "我", "！"],
        wrongAt: 2,
        candidates: ["你", "快", "走", "别"],
        note: "模型会用高频戏剧性表达续写，却不真正理解人物性格与叙事语境。",
        safe: "人物语气、动机和剧情一致性属于需要上下文核对的约束。",
      },
      {
        name: "代码 API 幻觉",
        prompt: "用 pandas 对 DataFrame 按多列排序并保持稳定：",
        tokens: [
          "df",
          ".",
          "sort_values",
          "(",
          "by",
          "=",
          "[",
          "A",
          ",",
          "B",
          "]",
          ",",
          "stable",
          "=",
          "True",
          ")",
        ],
        wrongAt: 12,
        candidates: ["kind", "ascending", "na_position", "stable"],
        note: "代码看起来语法顺畅，但模型把别处见过的参数组合成了不存在的 API。",
        safe: "查官方文档或运行最小测试；代码幻觉常常“能读、未必能用”。",
      },
      {
        name: "日常对话幻觉",
        prompt: "晚上好，吃了吗？",
        tokens: ["吃了", "，", "刚", "吃完", "一碗", "面", "。"],
        wrongAt: 0,
        candidates: ["吃了", "还没", "你好", "谢谢"],
        note: "模型没有身体经验，却会以第一人称续写一个看似自然的生活经历。",
        safe: "把拟人化回应当作对话风格，而不是模型真实经历或状态。",
      },
    ],
    [z, _] = useState(0),
    [f, N] = useState(0),
    [C, R] = useState(false),
    [D, x] = useState(460),
    r = h[z];
  useEffect(() => {
    if (!C) return;
    if (f >= r.tokens.length) {
      R(false);
      return;
    }
    const B = window.setTimeout(() => N((Y) => Y + 1), D);
    return () => window.clearTimeout(B);
  }, [r.tokens.length, C, D, f]);
  const T = (B) => {
      (_(B), N(0), R(false));
    },
    M = () => {
      (N(0), R(false));
    };
  return (
    <section className="lab hallucination-lab" aria-label="幻觉应对演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">逐词观察</span>
          <h2>语言会顺畅地往下生成，但“像真的”不等于有证据。</h2>
        </div>
        <span className="risk-badge">先验证，再采用</span>
      </div>
      <div className="case-tabs" role="tablist" aria-label="幻觉案例">
        {h.map((B, Y) => (
          <button
            type="button"
            role="tab"
            aria-selected={z === Y}
            className={z === Y ? "is-active" : ""}
            onClick={() => T(Y)}
          >
            {B.name}
          </button>
        ))}
      </div>
      <div className="generation-stage">
        <div className="generation-prompt">
          <span>用户问题</span>
          <b>{r.prompt}</b>
        </div>
        <div className="generation-output" aria-live="polite">
          <span>模型逐 Token 生成</span>
          <p>
            {r.tokens.slice(0, f).map((B, Y) => (
              <b className={Y === r.wrongAt ? "is-hallucination" : ""}>{B}</b>
            ))}
            {f < r.tokens.length && <i>▍</i>}
          </p>
        </div>
      </div>
      <div className="generation-controls">
        <div className="speed-control" aria-label="生成速度">
          {[
            [720, "慢"],
            [460, "中"],
            [180, "快"],
          ].map(([B, Y]) => (
            <button type="button" className={D === B ? "is-active" : ""} onClick={() => x(B as number)}>
              {Y}
            </button>
          ))}
        </div>
        <div>
          <button
            type="button"
            className="replay-button"
            onClick={() => R((B) => !B)}
            disabled={f === r.tokens.length}
          >
            {C ? "暂停生成" : f ? "继续生成" : "开始生成"}
          </button>
          <button type="button" className="next-step" onClick={M}>
            重置 ↺
          </button>
        </div>
      </div>
      <div className="hallucination-feedback">
        <div>
          <span>此刻的候选</span>
          {r.candidates.map((B, Y) => (
            <b className={B === r.tokens[r.wrongAt] ? "is-picked" : ""}>
              {B}
              <small>{[34, 29, 22, 15][Y]}%</small>
            </b>
          ))}
        </div>
        <div className={f > r.wrongAt ? "is-exposed" : ""}>
          <span>证据检查</span>
          <b>
            {f > r.wrongAt
              ? "错误词已出现：它没有工具回执或来源支撑。"
              : "运行生成后，观察被标红的“看似确定”细节。"}
          </b>
          <p>{r.note}</p>
        </div>
      </div>
      <div className="safe-answer">
        <span>正确的系统行为</span>
        <p>{r.safe}</p>
      </div>
    </section>
  );
}
// ═══ 第 10 课 · visual: prompt · Prompt 工程实验 ═══
export function PromptVisual() {
  const h = [
      {
        tag: "场景 A · 智能客服",
        name: "电商 / 金融客服机器人",
        description: "用户问产品细节、退款政策，模型极易编造不存在的规则。",
        question: "你们的七天无理由退款是从什么时候开始算的？",
        bad: (
          <>
            从您
            {<span className="prompt-mark is-bad">确认收货之日起 7 天内</span>}
            均可申请无理由退款，
            {<span className="prompt-mark is-bad">包括定制商品和食品</span>}
            ，只需保持原包装即可。
          </>
        ),
        good: (
          <>
            我需要帮您查询一下，请稍等。根据我们的退款政策，七天无理由从签收日期起算。但定制商品和食品等特殊品类是否适用，需要我帮您核实具体订单，您方便提供订单号吗？
          </>
        ),
        system:
          "你是客服助手。只能回答知识库中有明确记录的问题。不确定的内容必须说“我需要帮您查询一下，请稍等”，禁止自行推断或补充政策细节。",
        badVerdict: "模型编造了“定制商品也可退”——实际上不行，可能引发客诉纠纷。",
        goodVerdict: "回答了已知部分，主动承认未知部分，引导到安全路径。",
        tip: "System Prompt 是产品配置项：明确可答话题、必须转人工的范围，以及不确定时的兜底话术。",
        prompt: `# 智能客服 System Prompt 模板

你是 [公司名] 的智能客服助手。

## 核心约束
- 只回答知识库中有明确记录的问题
- 涉及价格、政策、库存等数字，必须从知识库获取，禁止自行推断
- 不确定时，统一回复：「这个问题我需要帮您查询一下，请稍等」
- 严禁编造不存在的优惠活动、退款规则、产品参数

## 兜底话术
当无法确认时，转接专属客服确认，并说明预计回复时间。`,
      },
      {
        tag: "场景 B · 内容创作",
        name: "AI 写作助手 / 公文生成",
        description: "生成报告时模型可能捏造数据、引用不存在的法规文件。",
        question: "帮我写一段关于公司 2024 年营收增长的摘要，引用一些行业数据支撑。",
        bad: (
          <>
            2024 年公司营收实现同比增长
            {<span className="prompt-mark is-bad">32.5%</span>}
            ，远超行业平均水平。根据
            {<span className="prompt-mark is-bad">艾瑞咨询 2024 年 Q3 报告</span>}
            ，该细分市场整体增速为 18%，公司市占率提升至
            {<span className="prompt-mark is-bad">14.7%</span>}
            ……
          </>
        ),
        good: (
          <>
            2024 年公司营收实现同比增长
            {<span className="prompt-mark is-good">[填入实际数据]%</span>}
            ，根据
            {<span className="prompt-mark is-good">[来源：请提供报告名称] [需核实]</span>}
            ，行业整体增速约为 [X]%……
          </>
        ),
        system:
          "你是写作助手。生成内容时，如包含具体数字、报告名称、机构名，必须标注“[需核实]”。不要虚构数据，宁可留空白让用户填写。",
        badVerdict: "模型捏造了具体数字和报告来源——发出去会造成信息失实，严重时引发法律风险。",
        goodVerdict: "生成结构框架，主动标注缺口，避免了虚假数据流出。",
        tip: "写作场景的核心风险是数字幻觉。需要明确：没有用户提供的数据就留占位符并标注“需核实”。",
        prompt: `# AI 写作助手 System Prompt 模板

## 数据安全约束
- 所有具体数字如非用户提供，必须标注 [需核实]
- 所有报告名称、机构名如非用户提供，必须标注 [来源待确认]
- 禁止虚构调研数据、媒体报道、专家言论

## 处理方式
遇到需要数据的地方，写出内容结构，用 [X%] / [报告名] 等占位符；不要自行估算一个看似合理的数字。`,
      },
      {
        tag: "场景 C · 知识问答",
        name: "企业内部知识库问答",
        description: "员工问内部流程，模型用通用知识填充，与公司实际规定不符。",
        question: "员工出差报销，住宿费标准是多少？",
        bad: (
          <>
            根据一般企业标准，住宿费报销通常为
            {
              <span className="prompt-mark is-bad">
                一线城市 500 元/晚，二线城市 350 元/晚，三线城市 200 元/晚
              </span>
            }
            。差旅补贴另计……
          </>
        ),
        good: (
          <>
            当前知识库中暂无出差住宿费标准的明确记录。建议您联系 HR
            行政部门确认最新标准，或查阅员工手册第 [X] 章差旅管理规定。
          </>
        ),
        system:
          "你是企业内部知识库助手。只能基于提供的公司文档回答问题。如果文档中没有明确说明，必须回复“当前知识库中暂无此信息，请联系 HR 确认”，禁止使用通用行业经验推断公司政策。",
        badVerdict: "模型用“行业通用数据”替代了公司真实政策——员工据此报销会被驳回。",
        goodVerdict: "承认知识边界，引导到正确渠道，不乱说一句话。",
        tip: "企业知识库中，“不知道就引导”比“知道但说错”更重要；兜底路径也是信息准确性 SLA 的一部分。",
        prompt: `# 企业知识库问答 System Prompt 模板

## 严格边界
- 只基于以下上下文文档回答：{context}
- 文档中没有明确内容 → 回复固定话术，不推断、不补充
- 禁止用“通常”“一般来说”“行业标准”等表述替代公司政策

## 回答格式
1. 直接给出答案（仅限文档有明确记录）
2. 标注依据：「根据 [文档名·版本·发布日期]」
3. 如有歧义，建议对应部门核实`,
      },
    ],
    [z, _] = useState(0),
    [f, N] = useState<any>("compare"),
    [C, R] = useState<any>("empty"),
    D = h[z],
    x = {
      empty: {
        label: "无上下文",
        prompt: "User: 请告诉我量子纠缠技术在 2025 年的最新商业应用进展。",
        answer: (
          <>
            截至 2025 年第二季度，IBM
            与波士顿量子公司已成功将量子纠缠应用于金融风险建模，交易速度提升
            {<span className="prompt-mark is-bad">340%</span>}
            ；中国科技大学宣布实现
            {<span className="prompt-mark is-bad">1024 量子比特纠缠</span>}
            ……
          </>
        ),
        verdict: "以上内容为模型编造，数字和公司进展均无法核实",
        tone: "is-bad",
      },
      document: {
        label: "附上文档",
        prompt: `System: 你是专业分析师。只根据用户提供的文件内容作答，不得引用文件外的信息。

[已附加文件：quantum_report_2025.pdf · 23 页]
“2025 年量子通信商业部署主要集中在安全密钥分发领域，IBM、IonQ 已有小规模试点，预计 2027 年进入规模化商用。”

User: 请告诉我量子纠缠技术在 2025 年的最新商业应用进展。`,
        answer: (
          <>
            根据您提供的报告，2025 年量子纠缠技术的商业应用主要集中在
            {<span className="prompt-mark is-good">安全密钥分发</span>}
            领域，IBM 和 IonQ 已有小规模试点项目。报告预测规模化商用将在 2027 年实现。
          </>
        ),
        verdict: "信息来源于用户提供文件，准确可溯源",
        tone: "is-good",
      },
      unknown: {
        label: "强制说不知道",
        prompt: `System: 你是一个严谨的助手。如果你不确定某个信息，必须直接说“我不知道”，不得猜测或编造任何数据。

User: 请告诉我量子纠缠技术在 2025 年的最新商业应用进展。`,
        answer: (
          <>
            我没有关于 2025
            年量子纠缠技术商业应用的可靠信息——我的训练数据有截止日期，且这一领域的最新进展超出了我的知识范围。建议查阅
            Nature、IEEE Spectrum 或相关企业的最新发布公告。
          </>
        ),
        verdict: "拒绝幻觉，给出替代建议",
        tone: "is-good",
      },
    },
    r = x[C],
    T = (M) => {
      (_(M), N("compare"));
    };
  return (
    <section className="lab prompt-lab" aria-label="Prompt 规格拼装演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">Prompt 工程 · 手段 01 / 04</span>
          <h2>用 System Prompt 约束幻觉：把知识边界与兜底路径写成产品规则。</h2>
        </div>
        <span className="schema-badge">prevent → verify</span>
      </div>
      <div className="prompt-workbench">
        <aside className="prompt-scenes">
          <span>选择业务场景</span>
          {h.map((M, B) => (
            <button
              type="button"
              aria-pressed={z === B}
              className={z === B ? "is-active" : ""}
              onClick={() => T(B)}
            >
              <small>{M.tag}</small>
              <b>{M.name}</b>
              <em>{M.description}</em>
            </button>
          ))}
          <div className="prompt-pm-tip">
            <b>PM 操作要点</b>
            <p>{D.tip}</p>
          </div>
        </aside>
        <div className="prompt-stage">
          <div className="lab-switch" role="tablist" aria-label="Prompt 实验视图">
            <button
              type="button"
              role="tab"
              aria-selected={f === "compare"}
              className={f === "compare" ? "is-active" : ""}
              onClick={() => N("compare")}
            >
              对比视图
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={f === "prompt"}
              className={f === "prompt" ? "is-active" : ""}
              onClick={() => N("prompt")}
            >
              Prompt 模板
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={f === "why"}
              className={f === "why" ? "is-active" : ""}
              onClick={() => N("why")}
            >
              为什么有效
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={f === "strategy"}
              className={f === "strategy" ? "is-active" : ""}
              onClick={() => N("strategy")}
            >
              三种策略
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={f === "defense"}
              className={f === "defense" ? "is-active" : ""}
              onClick={() => N("defense")}
            >
              防线组合
            </button>
          </div>
          {f === "compare" && (
            <div className="prompt-compare prompt-conversations">
              <div className="prompt-conversation is-risk">
                <header>
                  <i />
                  无约束 Prompt
                </header>
                <div className="prompt-bubble is-user">{D.question}</div>
                <div className="prompt-bubble is-ai">{D.bad}</div>
                <p className="prompt-verdict">
                  <b>✗</b>
                  {D.badVerdict}
                </p>
              </div>
              <div className="prompt-conversation is-safe">
                <header>
                  <i />
                  加约束 System Prompt
                </header>
                <div className="prompt-bubble is-system">
                  ⚙ System Prompt:
                  {D.system}
                </div>
                <div className="prompt-bubble is-user">{D.question}</div>
                <div className="prompt-bubble is-ai">{D.good}</div>
                <p className="prompt-verdict">
                  <b>✓</b>
                  {D.goodVerdict}
                </p>
              </div>
            </div>
          )}
          {f === "prompt" && (
            <div className="prompt-template">
              <span>System Prompt 模板 · 可直接复用</span>
              <pre>{D.prompt}</pre>
            </div>
          )}
          {f === "why" && (
            <div className="prompt-explanation">
              <div className="prompt-token-compare">
                <div>
                  <span>没有 System Prompt</span>
                  <p>
                    <b>用户问题</b>
                    <i>→</i>
                    <strong className="is-bad">编造的答案…</strong>
                  </p>
                  <small>模型直接基于训练记忆推 Token，碰上知识盲区会“流畅地编造”。</small>
                </div>
                <div>
                  <span>加入约束 System Prompt</span>
                  <p>
                    <b>用户问题</b>
                    <i>+</i>
                    <b className="is-injected">如果不确定</b>
                    <b className="is-injected">就说不知道</b>
                    <i>→</i>
                    <strong className="is-good">我不确定…</strong>
                  </p>
                  <small>约束词成为上下文的一部分，拉高“承认不知道”这个序列的概率。</small>
                </div>
              </div>
              <p className="prompt-insight">
                模型推下一个 Token 时，当前上下文里的每一个 Token 都在影响概率分布。System Prompt
                放入的是能把生成推向安全路径的“高质量前文”。
              </p>
              <div className="prompt-limits">
                <div>
                  <b>约束有效的前提</b>
                  <span>模型对问题有一定不确定感：超出知识范围、模糊查询、时效性信息。</span>
                </div>
                <div>
                  <b>约束会失效</b>
                  <span>
                    模型对错误答案高度自信时，训练数据中的系统性错误与过时知识仍可能被当作事实。
                  </span>
                </div>
                <div>
                  <b>必须搭配的防线</b>
                  <span>对高风险事实，接入 RAG 注入真实知识，或设置人工审核兜底。</span>
                </div>
              </div>
            </div>
          )}
          {f === "strategy" && (
            <div className="prompt-strategy">
              <div className="strategy-tabs" role="tablist" aria-label="Prompt 防幻觉策略">
                {Object.keys(x).map((M) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={C === M}
                    className={C === M ? "is-active" : ""}
                    onClick={() => R(M)}
                  >
                    {x[M].label}
                  </button>
                ))}
              </div>
              <p className="strategy-title">以“量子纠缠 2025 年商业应用”为例</p>
              <div className="strategy-content">
                <div>
                  <span>发送给模型的内容</span>
                  <pre>{r.prompt}</pre>
                </div>
                <div className={r.tone}>
                  <span>模型回复</span>
                  <p>{r.answer}</p>
                  <small>
                    {r.tone === "is-bad" ? "⚠" : "✓"}

                    {r.verdict}
                  </small>
                </div>
              </div>
            </div>
          )}
          {f === "defense" && (
            <div className="defense-stack">
              <div>
                <span>01 · Prompt</span>
                <b>规定行为边界</b>
                <p>不确定就说不知道、明确格式、禁止编造。它改变生成倾向，但不能提供新事实。</p>
              </div>
              <i>→</i>
              <div>
                <span>02 · RAG / Tool</span>
                <b>注入可核查证据</b>
                <p>检索最新法规、产品文档或实时数据；答案要带来源，不把检索命中当作绝对真相。</p>
              </div>
              <i>→</i>
              <div>
                <span>03 · Eval / Human</span>
                <b>验证高风险输出</b>
                <p>用评测集发现系统性错误；法律、医疗、金融或写操作设置人工审核与权限边界。</p>
              </div>
            </div>
          )}
        </div>
      </div>
      <p className="lab-note">
        Prompt 能降低模型在不确定时的编造概率，但不能替代真实资料、工具验证或人工审核。
      </p>
    </section>
  );
}
// ═══ 第 12 课 · visual: tools · 工具调用演示 ═══
export function ToolsVisual() {
  const h = useStepper(6, 680),
    [z, _] = useState<any>("vague"),
    [f, N] = useState<any>("serial"),
    [C, R] = useState(false),
    [D, x] = useState<any[]>([]),
    r = [
      [
        "system",
        "SYSTEM PROMPT · 工具定义",
        `# 你是一个智能助手，可以调用以下工具：

tools:
  - name: get_weather
    desc: 查询某地天气预报
    params: city: string, date: string
  - name: search_web
    desc: 搜索互联网信息

# 需要工具时，输出 JSON 格式的调用请求。`,
        "工具定义写在 System Prompt 里，模型“知道”有什么工具可以用。",
      ],
      ["user", "USER · 用户提问", "北京明天天气怎么样？", "用户只是在提出一个自然语言问题。"],
      [
        "assistant",
        "MODEL OUTPUT · 预测文字",
        `tool_call:
  name: "get_weather"
  params:
    city: "北京"
    date: "2026-04-11"`,
        "⚠ 这只是一段文字预测；模型自己什么都没执行，它在等待框架处理。",
      ],
      [
        "host",
        "FRAMEWORK · 解析并真正执行",
        `# 1. parse(model_output) → { name, params }
# 2. 校验 call.name 是否在 ALLOWED_TOOLS
# 3. 真正调用 API
result = weather_api.get(city="北京", date="2026-04-11")`,
        "✅ 参数校验、权限控制、错误处理都在框架；执行权始终在应用侧。",
      ],
      [
        "tool",
        "TOOL RESULT · 框架注入",
        `tool_result:
  name: "get_weather"
  data:
    weather: "小雨转多云"
    temp: "12°C ~ 20°C"
    wind: "北风 3 级"`,
        "框架把结果追加进 Message List，模型下一轮才能看到它。",
      ],
      [
        "assistant",
        "MODEL FINAL ANSWER · 再次预测",
        "明天北京小雨转多云，气温 12–20°C，北风 3 级，建议带把伞出门。",
        "🎯 用户看到的自然语言答案，本质仍是模型基于完整上下文预测文字的结果。",
      ],
    ],
    T = {
      serial: {
        label: "串行执行",
        total: "3.5s",
        description: "一个接一个，最容易保证依赖关系，但独立任务也被迫等待。",
        batches: [[0], [1], [2]],
        starts: [0, 43, 66],
        recommendation: "适合后一项真的依赖前一项的结果，例如先定位用户，再查他的订单。",
      },
      parallel: {
        label: "并发执行",
        total: "1.5s",
        description: "三个互不依赖的查询同时发出，等待时间接近最慢的那一个。",
        batches: [[0, 1, 2]],
        starts: [0, 0, 0],
        recommendation: "适合只读、无依赖、无写入冲突的工具，例如天气、酒店、航班搜索。",
      },
      batched: {
        label: "智能分批",
        total: "2.3s",
        description: "先并发安全的只读查询，再执行需要确认或可能有副作用的动作。",
        batches: [[1, 2], [0]],
        starts: [57, 0, 0],
        recommendation: "生产系统常用：按数据依赖、权限和副作用分批，而不是盲目全并发。",
      },
    },
    M = T[f],
    B = () => {
      if (C) return;
      (R(true), x([]));
      const Y = M.batches.flat();
      (Y.forEach((V, H) => window.setTimeout(() => x((k) => [...k, V]), 420 + H * 470)),
        window.setTimeout(() => R(false), 420 + Y.length * 470));
    };
  return (
    <section className="lab tool-lab" aria-label="工具调用演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">Tool calling · MESSAGE LIST</span>
          <h2>模型不会真的执行代码：它只预测结构化文字，框架解析、校验并执行。</h2>
        </div>
        <span className="schema-badge">text → code → API → text</span>
      </div>
      <div className="tool-progress" aria-label="工具调用六步流程">
        {r.map(([, Y], V) => (
          <span className={V <= h.step ? "is-done" : ""}>
            <i>{V + 1}</i>
            {Y.split(" · ")[0]}
          </span>
        ))}
      </div>
      <div className="message-chain tool-message-chain">
        {r.slice(0, h.step + 1).map(([Y, V, H, k], Tl) => (
          <div className={`chain-message role-${Y}`}>
            <span>{String(Tl + 1).padStart(2, "0")}</span>
            <div>
              <b>{V}</b>
              <code>{H}</code>
              <small>{k}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="tool-boundary">
        <b>核心：模型始终只在预测文字。</b>
        <span>工具调用 = 文字 → 框架代码解析 → API → 结果注回上下文 → 文字</span>
      </div>
      <div className="tool-schema-lab">
        <div>
          <span>工具描述的学问</span>
          <b>模型只能依据 schema 里的文字理解“何时、怎样、能否”调用工具。</b>
        </div>
        <div className="lab-switch" role="tablist" aria-label="工具描述质量">
          <button
            type="button"
            role="tab"
            aria-selected={z === "vague"}
            className={z === "vague" ? "is-active" : ""}
            onClick={() => _("vague")}
          >
            含糊描述
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={z === "precise"}
            className={z === "precise" ? "is-active" : ""}
            onClick={() => _("precise")}
          >
            可执行描述
          </button>
        </div>
        <div className={z === "vague" ? "schema-example is-risk" : "schema-example is-good"}>
          <code>
            {z === "vague"
              ? `search(query)
// 搜索信息`
              : `search_web(query: string, freshness: "day" | "week")
// 仅查询公开网页；时效问题必须传 freshness；
// 找不到可靠来源时返回 empty，不得编造结果。`}
          </code>
          <p>
            {z === "vague"
              ? "“搜索信息”没有范围、时效、失败行为和参数约束；模型容易误用工具或拿不可靠结果继续编造。"
              : "好 schema 同时描述能力边界、参数语义和失败行为；它是模型规划 Action 时最重要的“操作说明书”。"}
          </p>
        </div>
      </div>
      <div className="orchestration-lab">
        <div className="orchestration-head">
          <div>
            <span>多工具编排</span>
            <b>同一轮返回三个 tool call，框架该怎样排队？</b>
          </div>
          <div className="lab-switch" role="tablist" aria-label="工具编排策略">
            {Object.keys(T).map((Y) => (
              <button
                type="button"
                role="tab"
                aria-selected={f === Y}
                className={f === Y ? "is-active" : ""}
                onClick={() => {
                  (N(Y), x([]), R(false));
                }}
              >
                {T[Y].label}
              </button>
            ))}
          </div>
        </div>
        <div className="orchestration-stage">
          <div className="orchestration-tools">
            {[
              ["✈", "search_flights", "1.5s"],
              ["☀", "get_weather", "0.8s"],
              ["⌂", "search_hotels", "1.2s"],
            ].map(([Y, V, H], k) => (
              <div className={D.includes(k) ? "is-done" : C ? "is-pending" : ""}>
                <i>{Y}</i>
                <b>{V}</b>
                <small>
                  {H}

                  {D.includes(k) ? "· 完成 ✓" : "· 等待"}
                </small>
              </div>
            ))}
          </div>
          <div className="gantt-mini" aria-label="执行时序图">
            {[
              ["航班", 35],
              ["天气", 19],
              ["酒店", 28],
            ].map(([Y, V], H) => (
              <div>
                <span>{Y}</span>
                <i
                  style={{
                    marginLeft: `${M.starts[H]}%`,
                    width: `${V}%`,
                  }}
                  className={D.includes(H) ? "is-done" : ""}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="orchestration-verdict">
          <b>
            {M.label}· 预计等待
            {M.total}
          </b>
          <p>{M.description}</p>
          <small>{M.recommendation}</small>
          <button type="button" className="experiment-button" onClick={B} disabled={C}>
            {C ? "框架正在调度…" : D.length ? "再次演示 ↺" : "播放执行时序"}
          </button>
        </div>
      </div>
      <PlaybackControls labels={r.map(([, Y]) => Y)} playback={h} />
    </section>
  );
}
// ═══ 第 11 课 · visual: react (agent) · Agent 能力演示 ═══
export function AgentVisual() {
  const h = [
      {
        id: "plan",
        icon: "🧭",
        title: "Plan（规划）",
        short: "把复杂任务拆解为可执行步骤",
        demo: "Plan 规划能力 · 竞品分析任务全流程",
        tone: "orange",
        steps: [
          ["💬", "用户下达任务", "“帮我做一份竞品分析报告，包含 A、B、C 三家。”"],
          ["🧭", "PLAN · 理解任务", "分析需求：竞品范围？分析维度？输出格式？目标受众？"],
          ["📋", "PLAN · 制定步骤", "搜索三家竞品官网 → 提取核心功能和定价 → 对比分析 → 撰写报告"],
          ["🔧", "ACT · 执行 Step 1", '调用 search_web("竞品 A 功能 定价")，获取结果……'],
          ["👁️", "OBSERVE · 观察结果", "成功获取竞品 A 数据。继续执行 Step 2：搜索竞品 B……"],
          [
            "🔄",
            "ADJUST · 动态调整",
            "发现竞品 B 官网无公开定价，临时调整：改为搜索第三方测评文章。",
          ],
          ["✓", "完成", "整合所有数据，输出三页竞品对比报告。全程无需用户介入每一步。"],
        ],
      },
      {
        id: "tool",
        icon: "🔧",
        title: "Tool Use（使用工具）",
        short: "调用搜索、代码执行、数据库、API",
        demo: "Tool Use 工具调用 · 天气查询 + 发邮件",
        tone: "cyan",
        steps: [
          ["💬", "用户指令", "“查询北京明天天气，下雨的话发邮件提醒我带伞。”"],
          [
            "🤔",
            "THINK · 分析需要哪些工具",
            "需要：① get_weather（查天气）② send_email（发邮件，条件执行）",
          ],
          ["🔧", "CALL · 调用工具 1", 'get_weather(city="北京", date="明天") → 等待宿主程序执行'],
          [
            "📦",
            "RESULT · 工具返回",
            'weather="小雨", temp="12–18°C", wind="北风 3 级" → 注回上下文',
          ],
          ["🧠", "THINK · 条件判断", "有雨，条件成立 → 触发发邮件逻辑。"],
          [
            "🔧",
            "CALL · 调用工具 2",
            'send_email(to="user@xx.com", subject="明天北京有雨，记得带伞")',
          ],
          ["✓", "完成", "邮件发送成功：明天小雨，已发邮件提醒你带伞。"],
        ],
      },
      {
        id: "memory",
        icon: "🗃️",
        title: "Memory（记忆）",
        short: "短期上下文 + 长期向量数据库",
        demo: "Memory 记忆能力 · 短期 + 长期协同",
        tone: "green",
        steps: [
          ["💬", "第 1 轮", "用户：“我叫小明，在上海，想学 Python 数据分析。”"],
          ["🧠", "短期记忆", "写入 Context Window：“用户=小明，上海，目标=Python 数据分析”"],
          ["💬", "第 5 轮", "用户：“推荐一些适合我城市的线下课？”"],
          ["📎", "短期记忆命中", "从 Context Window 读取“上海”，推荐上海本地课程。无需重复说明。"],
          [
            "💾",
            "持久化 → 长期记忆",
            "对话结束：向量化存储 → “小明 / 上海 / Python / 数据分析 / 偏好线下”",
          ],
          ["🔍", "下次对话 · 长期记忆检索", "新对话开始，RAG 检索上次记录 → 注入当前上下文"],
          ["✓", "连续体验", "“上次你说想在上海学 Python，今天继续？”——跨会话记住用户。"],
        ],
      },
      {
        id: "reflect",
        icon: "🔄",
        title: "Act / Reflect（行动 + 反思）",
        short: "执行后观察，失败则自我纠错",
        demo: "Act / Reflect 自我纠错 · 修复 Python 代码",
        tone: "purple",
        steps: [
          ["💬", "用户任务", "“帮我修复这段 Python 代码。”（用户粘贴了一段报错代码）"],
          ["🔧", "ACT 1 · 执行代码", "调用代码执行工具 → TypeError: unsupported operand type(s)"],
          ["🪞", "REFLECT · 分析错误", "字符串和整数直接相加，需要 int() 类型转换。修改第 7 行。"],
          ["🔧", "ACT 2 · 再次执行", "修改后重新运行 → IndexError: list index out of range"],
          [
            "🪞",
            "REFLECT · 再次分析",
            "数组下标越界，第 12 行循环边界错误。修正为 range(len(lst)-1)。",
          ],
          ["🔧", "ACT 3 · 第三次执行", "运行成功，输出符合预期。"],
          ["✓", "完成", "代码已修复，共修改 2 处：类型转换 + 循环边界。"],
        ],
      },
    ],
    [z, _] = useState(0),
    [f, N] = useState(0),
    [C, R] = useState(false),
    D = h[z];
  useEffect(() => {
    if (!C || f >= D.steps.length) {
      C && f >= D.steps.length && R(false);
      return;
    }
    const T = window.setTimeout(() => N((M) => M + 1), 720);
    return () => window.clearTimeout(T);
  }, [D.steps.length, C, f]);
  const x = (T) => {
      (_(T), N(0), R(true));
    },
    r = () => {
      (N(0), R(false));
    };
  return (
    <section className="lab agent-lab" aria-label="Agent 核心能力演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">Agent 工程 · 四大能力</span>
          <h2>普通 LLM 只能“说”，Agent 能把目标推进到真实环境中。</h2>
        </div>
        <span className="schema-badge">LLM + tools + loop</span>
      </div>
      <div className="agent-workbench">
        <div className="agent-left">
          <p className="agent-description">
            区别在于 Agent
            多了规划、工具、记忆和反思四种能力；点击卡片，右侧会播放完整的真实执行过程。
          </p>
          <div
            className="agent-capabilities agent-ability-list"
            role="tablist"
            aria-label="Agent 四大能力"
          >
            {h.map((T, M) => (
              <button
                type="button"
                role="tab"
                aria-selected={z === M}
                data-tone={T.tone}
                className={z === M ? "is-active" : ""}
                onClick={() => x(M)}
              >
                <i>{T.icon}</i>
                <span>{T.title}</span>
                <small>{T.short}</small>
              </button>
            ))}
          </div>
          <div className="agent-vs">
            <div>
              <b>普通 LLM</b>
              <p>
                问题 → 生成回答 → 结束
                <br />
                只能“说”，不能“做”
              </p>
            </div>
            <div>
              <b>Agent</b>
              <p>任务 → 规划 → 调工具 → 观察 → 纠错 → 完成</p>
            </div>
          </div>
          <p className="agent-takeaway">
            <b>Agent = LLM + 工具 + 循环。</b>
            核心是“思考 → 行动 → 观察 → 再思考”。
          </p>
        </div>
        <div className="agent-demo" data-tone={D.tone}>
          <div className="agent-demo-head">
            <span>逐步演示</span>
            <b>{D.demo}</b>
            <em>
              {f}/{D.steps.length}
            </em>
          </div>
          <div className="agent-timeline" aria-live="polite">
            {f === 0 ? (
              <p className="agent-empty">
                点击“播放流程”或“下一步”，观察 Agent 如何把任务推进成可验证的结果。
              </p>
            ) : (
              D.steps.slice(0, f).map(([T, M, B], Y) => (
                <div className={`agent-timeline-step ${Y === f - 1 ? "is-current" : ""}`}>
                  <div>
                    <i>{T}</i>
                    {Y < D.steps.length - 1 && <span />}
                  </div>
                  <p>
                    <b>{M}</b>
                    <small>{B}</small>
                  </p>
                </div>
              ))
            )}
          </div>
          <div className="agent-demo-controls">
            <button
              type="button"
              className="replay-button"
              onClick={() => {
                (N(0), R(true));
              }}
            >
              {C ? "播放中…" : f === D.steps.length ? "重新播放 ↺" : "播放流程"}
            </button>
            <button
              type="button"
              className="next-step"
              onClick={() => {
                (R(false), N((T) => Math.min(D.steps.length, T + 1)));
              }}
              disabled={f === D.steps.length}
            >
              {f === D.steps.length ? "流程完成" : "下一步 →"}
            </button>
            <button type="button" className="agent-reset" onClick={r}>
              重置
            </button>
          </div>
        </div>
      </div>
      <p className="lab-note">
        同一个基础模型，在不同的能力编排与反馈循环下，会表现为完全不同的“能干活”程度。
      </p>
    </section>
  );
}
// ═══ 第 15 课 · visual: react (react-loop) · ReAct 循环 ═══
export function ReActLoopVisual() {
  const [h, z] = useState(0),
    _ = [
      ["THOUGHT · 第 1 轮", "用户要删除所有 console.log；先搜索项目中哪些文件包含 console.log。"],
      ["ACTION · 第 1 轮", 'tool_call → search_files(pattern="console.log", scope="项目全局")'],
      ["OBSERVATION · 第 1 轮", "找到 12 个文件包含 console.log，共 47 处。"],
      ["THOUGHT · 第 2 轮", "找到 12 个文件，逐个编辑删除；先处理 src/api.ts。"],
      ["ACTION · 第 2 轮", 'tool_call → edit_file(file="src/api.ts", remove_lines="15, 28, 45")'],
      ["OBSERVATION · 第 2 轮", "src/api.ts 已修改，删除了 3 处 console.log。"],
      ["THOUGHT · 第 3 轮", "继续批量处理剩余文件；编辑后必须验证是否仍有遗漏。"],
      ["ACTION · 第 3 轮", 'tool_call → search_files(pattern="console.log", scope="项目全局")'],
      ["OBSERVATION · 第 3 轮", "还剩 2 处：测试 fixture 与注释示例；只删除真实调用。"],
      ["ACTION · 第 4 轮", 'tool_call → run_tests(command="npm test")'],
      ["OBSERVATION · 第 4 轮", "测试全部通过；代码库中已无真实 console.log 调用。"],
      [
        "FINAL ANSWER",
        "已删除 47 处 console.log，保留注释示例；测试通过。每一步都有工具回执可复核。",
      ],
    ],
    f = [
      [
        "目标",
        "找全所有真实 console.log 调用，不能凭印象修改。",
        "依据",
        "用户要求覆盖“所有”，第一步必须先建立完整清单。",
      ],
      [
        "行动选择",
        "调用 search_files，而不是直接编辑。",
        "可验证性",
        "搜索结果会返回文件数与命中数，形成后续修改的基线。",
      ],
      [
        "新事实",
        "已找到 12 个文件、47 处调用。",
        "计划更新",
        "从泛化的“删除日志”变成逐文件、可追踪的编辑计划。",
      ],
      [
        "目标",
        "先用一个文件验证编辑策略，再扩展到其余文件。",
        "风险控制",
        "小步 Action 让错误可定位、可回滚。",
      ],
      [
        "行动选择",
        "只删除 src/api.ts 的 3 个定位行。",
        "边界",
        "编辑工具执行；模型只输出 file + remove_lines 的结构化意图。",
      ],
      [
        "新事实",
        "首个文件已成功修改。",
        "计划更新",
        "继续处理剩余文件，但不能把单次成功当成全局完成。",
      ],
      [
        "目标",
        "批处理后复查是否漏掉 fixture、注释或动态调用。",
        "依据",
        "工具结果会改变下一步；这就是 ReAct 与一次性计划的差异。",
      ],
      [
        "行动选择",
        "再次 search_files，而不是猜测已完成。",
        "可验证性",
        "同一个工具在不同轮次承担“发现”与“验收”两种角色。",
      ],
      ["新事实", "剩余 2 处不是生产调用。", "计划更新", "保留注释示例，避免机械删除破坏测试语义。"],
      [
        "停止前检查",
        "运行测试，验证编辑没有破坏行为。",
        "完成条件",
        "搜索为零 + 测试通过，两个证据缺一不可。",
      ],
      [
        "新事实",
        "测试通过，真实调用已清零。",
        "停止条件",
        "目标和验收条件同时满足，可以结束循环。",
      ],
      [
        "交付",
        "报告做了什么、保留了什么、依据是什么。",
        "原则",
        "最终答案应来自可复核 Observation，而不是模型的“自信总结”。",
      ],
    ],
    N = () => z((R) => Math.min(_.length - 1, R + 1)),
    C = () => z(0);
  return (
    <section className="lab react-lab" aria-label="ReAct 循环演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">ReAct 执行过程</span>
          <h2>
            Reasoning + Acting：Observation 进入下一轮 Thought，Agent 据执行结果持续调整策略。
          </h2>
        </div>
        <span className="schema-badge">think → act → observe</span>
      </div>
      <div className="agent-task">
        <span>用户指令</span>
        <b>帮我把项目中所有的 console.log 删掉，然后跑一下测试确保没问题。</b>
      </div>
      <div className="react-timeline">
        {_.slice(0, h + 1).map(([R, D], x) => (
          <div
            className={`react-row ${x === h ? "is-current" : ""} ${x === 2 ? "is-failure" : ""}`}
          >
            <span>{String(x + 1).padStart(2, "0")}</span>
            <div>
              <b>{R}</b>
              <p>{D}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="react-result">
        <span>实时统计</span>
        <b>
          当前轮次
          {Math.ceil((h + 1) / 3)}· 工具调用
          {Math.floor((h + 1) / 3)}· Observation 会作为下一轮的输入继续循环
        </b>
      </div>
      <div className="cot-panel">
        <div>
          <span>本轮 reasoning summary（可审计，不展示隐藏思维链）</span>
          <b>
            {f[h][0]}：{f[h][1]}
          </b>
        </div>
        <div>
          <span>{f[h][2]}</span>
          <p>{f[h][3]}</p>
        </div>
      </div>
      <div className="completion-actions">
        <button type="button" className="replay-button" onClick={N} disabled={h === _.length - 1}>
          {h === _.length - 1 ? "循环完成" : "执行下一步 →"}
        </button>
        <button type="button" className="next-step" onClick={C}>
          重置 ↺
        </button>
      </div>
    </section>
  );
}
// ═══ 第 16 课 · visual: skills · Skill 本质演示 ═══
export function SkillsVisual() {
  const [h, z] = useState(0),
    [_, f] = useState(0),
    [N, C] = useState(0),
    R = [
      "收到指令：“帮我发版”",
      "猜测：也许先 npm build？→ 命令失败",
      "改试 npm run build，忘了先跑测试",
      "手动改 version，遗漏 npm version 流程",
      "补跑测试：2 个失败，重新构建",
      "补打 git tag：远端已有同名 tag，发版失败",
    ],
    D = [
      "收到指令 → 匹配 Skill：release",
      "Step 1：npm test → 全部通过 ✓",
      "Step 2：npm run build → 构建成功 ✓",
      "Step 3：npm version patch → v1.0.1 ✓",
      "Step 4：创建 git tag → v1.0.1 ✓",
      "Step 5：git push --follow-tags → 发版完成 ✓",
    ],
    x = () => {
      (z(0), f(0));
    },
    r = [
      {
        title: "元信息与触发词",
        subtitle: "什么时候应该使用它？",
        body: (
          <>
            {<code>name: release\ndescription: 为当前项目执行可验证的发版流程</code>}
            {
              <p>
                “发版”“打包发布”“release”等表达要能被召回；描述还要限制在当前项目，避免跨项目误触。
              </p>
            }
          </>
        ),
      },
      {
        title: "适用条件",
        subtitle: "什么情况下应该静默退出？",
        body: (
          <>
            {
              <div className="skill-decision">
                <b>用户要发版？</b>
                <i>→</i>
                <b>当前项目有 package.json？</b>
                <i>→</i>
                <strong>运行 release</strong>
              </div>
            }
            {<p>任一条件不满足，就交回通用能力处理；路由条件是防止误执行的第一道保险。</p>}
          </>
        ),
      },
      {
        title: "执行管线",
        subtitle: "怎样把经验变成可运行步骤？",
        body: (
          <>
            {
              <div className="skill-pipeline">
                {[
                  "git status",
                  "npm test",
                  "npm run build",
                  "npm version",
                  "git tag",
                  "git push",
                ].map((T, M) => (
                  <span>
                    <i>{M + 1}</i>
                    {T}
                  </span>
                ))}
              </div>
            }
            {<p>每步都有输入、输出与失败处理；Skill 的价值不是“更长的 Prompt”，而是稳定的 SOP。</p>}
          </>
        ),
      },
      {
        title: "工具权限与安全约束",
        subtitle: "哪些动作必须停下来等人？",
        body: (
          <>
            {
              <div className="skill-permissions">
                <span>✓ 可读：git status、测试日志、构建产物</span>
                <span>✓ 可写：更新版本号、创建 tag</span>
                <span>! 需确认：推送远端、发布生产环境</span>
                <span>× 禁止：跳过测试、覆盖已有 tag、上传密钥</span>
              </div>
            }
            {
              <p>
                同一个工具调用在不同风险等级下应有不同权限；“可以做什么”与“必须先确认什么”都要写进
                Skill。
              </p>
            }
          </>
        ),
      },
    ];
  return (
    <section className="lab skills-lab" aria-label="Skill 结构演示">
      <div className="lab-head">
        <div>
          <span className="lab-label">Skill = 经验封装</span>
          <h2>同一个发版任务：没有 Skill 靠试错，有 Skill 按最佳实践执行。</h2>
        </div>
        <span className="schema-badge">release / SKILL.md</span>
      </div>
      <div className="skill-race">
        <div className="skill-lane no-skill">
          <header>
            <span>没有 Skill</span>
            <b>12 轮 · 15,000 Token · 3 个错误</b>
          </header>
          {R.slice(0, h + 1).map((T, M) => (
            <p>
              <i>{M + 1}</i>
              {T}
            </p>
          ))}
          <button
            type="button"
            onClick={() => z((T) => Math.min(R.length - 1, T + 1))}
            disabled={h === R.length - 1}
          >
            模拟摸索流程 →
          </button>
        </div>
        <div className="skill-lane with-skill">
          <header>
            <span>有 Skill</span>
            <b>5 轮 · 4,000 Token · 0 错误</b>
          </header>
          {D.slice(0, _ + 1).map((T, M) => (
            <p>
              <i>{M + 1}</i>
              {T}
            </p>
          ))}
          <button
            type="button"
            onClick={() => f((T) => Math.min(D.length - 1, T + 1))}
            disabled={_ === D.length - 1}
          >
            执行 release Skill →
          </button>
        </div>
      </div>
      <div className="skill-verdict">
        <div>
          <span>无 Skill</span>
          <b>
            {h === R.length - 1
              ? "发版失败：多次试错且留下 3 个错误"
              : "靠通用能力临时摸索，顺序与边界不断漂移"}
          </b>
        </div>
        <div>
          <span>有 Skill</span>
          <b>
            {_ === D.length - 1
              ? "v1.0.1 已发布：完整、可复核、零错误"
              : "触发条件、顺序、工具与验证标准均已固化"}
          </b>
        </div>
      </div>
      <div className="skill-anatomy">
        <div>
          <span>打开一个真实的工作说明书</span>
          <b>Skill 不是一句 Prompt，而是一份包含路由、步骤、权限与验证的运行规范。</b>
        </div>
        {r.map((T, M) => (
          <section className={N === M ? "is-open" : ""}>
            <button
              type="button"
              aria-expanded={N === M}
              onClick={() => C((B) => (B === M ? -1 : M))}
            >
              <i>{String(M + 1).padStart(2, "0")}</i>
              <span>
                <b>{T.title}</b>
                <small>{T.subtitle}</small>
              </span>
              <em>⌄</em>
            </button>
            {N === M && <div className="skill-anatomy-content">{T.body}</div>}
          </section>
        ))}
      </div>
      <div className="completion-actions">
        <button type="button" className="next-step" onClick={x}>
          两边都重置 ↺
        </button>
      </div>
    </section>
  );
}
