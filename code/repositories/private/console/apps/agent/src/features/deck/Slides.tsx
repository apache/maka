// 由原始单文件 HTML 机械转换而来，类名与源站 CSS 一一对应；仅把 class→className、style 串→对象、svg 属性转驼峰。
// 内容改动请直接改这里的 JSX。

function S01() {
  return (
    <>

  <div className="eyebrow">Builder Club，2026，上海</div>
  <h1>如何 <span className="hl">Harness</span> 我的大模型</h1>
  <div className="sub2">Harness 的演进和未来</div>
  <div className="who"><b>OpenCLI</b> 作者 · <b>Apache Maka (incubating)</b> 作者</div>

    </>
  );
}

function S02() {
  return (
    <>

  <div className="eyebrow">目录</div>
  <h2>今天讲六件事</h2>
  <p className="sub">从「什么是 Harness」出发，到你如何定义自己的 Harness。</p>
  <div className="agenda">
    <div className="card"><div className="num">01</div><h3>什么是 Harness</h3><p>把聊天引擎变成执行工具的那一层</p></div>
    <div className="card c-cyan"><div className="num">02</div><h3>Context Engineering</h3><p>上下文是怎么组织的，为什么会腐化</p></div>
    <div className="card c-violet"><div className="num">03</div><h3>Skill 将死<br />方法论永生</h3><p>一个名词，激活一整套原理</p></div>
    <div className="card c-blue"><div className="num">04</div><h3>Long-running Agent<br />与 Agent Team</h3><p>富集上下文，再用 Swarm / Graph / Team 分工</p></div>
    <div className="card"><div className="num">05</div><h3>人是最好的编排者</h3><p>蒸馏、方法论、高质量数据从哪来</p></div>
    <div className="card c-amber"><div className="num">06</div><h3>定义自己的 Harness</h3><p>管上下文、沉淀 Workflow、设计 AX</p></div>
  </div>

    </>
  );
}

function S03() {
  return (
    <>

  <div className="eyebrow">01 什么是 Harness</div>
  <h2>Harness：管理和增强 Agent 的<em>工程化运行时框架</em></h2>
  <p className="sub">它把记忆、工具调用、任务规划这些「工程能力」附加到基础大模型上，把模型从单纯的聊天引擎，变成能可靠完成复杂任务的执行工具。</p>
  <div className="two" style={{ marginTop: "14px" }}>
    <div className="ring">
      <div className="orbit"></div>
      <div className="core">大模型<small>CHAT ENGINE</small></div>
      <div className="node n1"><small>MEMORY</small>长期记忆<br />上下文管理</div>
      <div className="node n2"><small>TOOLS</small>工具调用<br />环境交互</div>
      <div className="node n3"><small>PLANNING</small>任务规划<br />与分解</div>
      <div className="node n4"><small>OPS</small>审批策略<br />可观测性</div>
    </div>
    <div className="side" style={{ paddingTop: "30px" }}>
      <div className="note"><b>一个类比：</b>Harness 是给 Agent 配备的「装备和控制系统」。模型负责思考和提出 action，Harness 负责让它能记住、能动手、能被看见。</div>
      <div className="note"><b>没有 Harness：</b>模型只能回答，回答完就忘。</div>
      <div className="note"><b>有了 Harness：</b>模型会执行代码、读写文件、跨会话记住项目，并且每一步都留下可检查的痕迹。</div>
    </div>
  </div>

    </>
  );
}

function S04() {
  return (
    <>

  <div className="eyebrow">01 什么是 Harness</div>
  <h2>Harness 让「只会聊天」的模型多出四种能力</h2>
  <div className="grid g4 body">
    <div className="card">
      <div className="t">记忆</div><h3>长期记忆与上下文管理</h3>
      <p>支持跨会话的记忆存储和检索。上下文过长时自动压缩，避免超出模型窗口，让 Agent 能「记住」过往的交互。</p>
    </div>
    <div className="card c-cyan">
      <div className="t">工具</div><h3>工具调用与环境交互</h3>
      <p>这是让 Agent 能「动手」的关键。Harness 驱动 Agent 按需调用外部工具：执行代码、网络搜索、读写文件，完成实际任务。</p>
    </div>
    <div className="card c-violet">
      <div className="t">规划</div><h3>任务规划与分解</h3>
      <p>面对「对比 Python 和 Go 的适用场景」这类任务，先制定分步计划再执行，避免一次处理全部信息导致混乱。不同 Harness 提供 <span className="k">Plan-Execute</span>、<span className="k">Orchestrator</span> 等模式。</p>
    </div>
    <div className="card c-amber">
      <div className="t">工程化</div><h3>工程化与可观测性</h3>
      <p>审批策略（工具调用需人工确认）、<span className="k">OpenTelemetry</span> 可观测性（监控 Agent 内部状态）。让 Agent 的行为更可控、更容易调试。</p>
    </div>
  </div>
  <div className="foot"><strong>模型决定想做什么，Harness 决定能做什么、做过什么。</strong>后面几个部分，都围绕这四种能力展开。</div>

    </>
  );
}

function S05() {
  return (
    <>

  <div className="eyebrow">02 Context Engineering</div>
  <h2>Harness 的上下文是怎么组织的</h2>
  <p className="sub">每次调用模型，进入窗口的是四层拼装起来的 token，「一段对话」只是其中一层。<span className="mono" style={{ color: "var(--dim)" }}>→ 按方向键逐层展开</span></p>
  <div className="ctx">
    <div className="stack">
      <div className="layer l-sys frag" data-f="1">
        <div className="tag">L1 · 注意力最高</div>
        <div className="lt">System Prompt</div>
        <div className="ln">系统提示词</div>
        <div className="ld">base instructions + AGENTS.md + memory + 环境信息（cwd、git、日期）。最稳定，走 prompt cache。</div>
      </div>
      <div className="layer l-tool frag" data-f="2">
        <div className="tag">L2 · 稳定</div>
        <div className="lt">Tool Definitions</div>
        <div className="ln">工具描述层</div>
        <div className="ld">name / description / JSON schema；MCP tools；Skills 只放索引，用到时再读全文。</div>
      </div>
      <div className="layer l-conv frag" data-f="3">
        <div className="tag">L3 · 每轮增长</div>
        <div className="lt">Conversation</div>
        <div className="ln">对话层</div>
        <div className="msgs">
          <span className="msg u old">user</span><span className="msg old">assistant · reasoning</span><span className="msg old">tool_use</span><span className="msg r old">tool_result</span>
          <span className="msg old">tool_use</span><span className="msg r old">tool_result</span><span className="msg old">assistant</span>
          <span className="msg u g">user</span><span className="msg g">tool_use</span><span className="msg r g">tool_result · 12k tokens</span><span className="msg g">tool_use</span><span className="msg r g">tool_result</span><span className="msg g">assistant</span>
        </div>
        <div className="summary">▣ compaction summary · 架构决策 / 未解决的 bug / 改过的文件 —— 替换掉上面被划掉的历史</div>
      </div>
      <div className="layer l-state frag" data-f="4">
        <div className="tag">L4 · 动态注入</div>
        <div className="lt">Runtime State</div>
        <div className="ln">Agent 状态栏</div>
        <div className="ld">system-reminder 注入：todo 状态、context 使用率、hooks 输出、文件被外部修改的提醒。</div>
      </div>
    </div>
    <div className="sub-stack">
      <div className="fork">fork 出去</div>
      <div className="cap">Sub-agent：全新的 L1–L4</div>
      <div className="layer l-sys"><div className="ln">System Prompt</div></div>
      <div className="layer l-tool"><div className="ln">Tools</div></div>
      <div className="layer l-conv" style={{ minHeight: "0" }}><div className="ln">自己的对话</div></div>
      <div className="layer l-state"><div className="ln">State</div></div>
      <div className="ret">只回传 1–2k token 的结论</div>
    </div>
    <div className="side">
      <div className="caps">
        <div className="note" data-f="0"><span className="idx">开始</span><b>先看空白的窗口。</b>Harness 每一轮都要决定：把什么放进去。</div>
        <div className="note" data-f="1"><span className="idx">L1 · System Prompt</span><b>你能控制的最高优先级。</b>通过 <span className="k">AGENTS.md</span> 定制。模型对开头的注意力最高，所以这一层要好好设计。</div>
        <div className="note" data-f="2"><span className="idx">L2 · Tools</span><b>工具描述是模型唯一能看到的说明书。</b>它决定模型会不会选对工具、传对参数。Skills 只放索引，用时再读。</div>
        <div className="note" data-f="3"><span className="idx">L3 · Conversation</span><b>对话层占掉绝大多数 token。</b>每一次 tool_use 都带回一份 tool_result，旧的结果很快就没人再看。</div>
        <div className="note" data-f="4"><span className="idx">L4 · Runtime State</span><b>状态栏是 Harness 替模型「记着」的东西。</b>不靠模型回忆，而是每轮直接告诉它现在在哪。</div>
        <div className="note" data-f="5"><span className="idx">再跑一轮</span><b>再跑一轮：</b>L1、L2 不变，L3 又长了一截。窗口就是这样一轮一轮被吃掉的。</div>
        <div className="note" data-f="6"><span className="idx">Compaction</span><b>窗口快满 → 压缩。</b>只压 L3：旧历史被一段摘要替换，L1、L2 原样保留，所以它们要写得稳定。</div>
        <div className="note" data-f="7"><span className="idx">Sub-agent</span><b>分治上下文。</b>子 Agent 拿一份干净的 L1–L4 去深挖，主线只收到一两千 token 的结论。无关信息从头就进不来。</div>
      </div>
      <div className="frag" data-f="4">
        <div className="budget"><i className="b1"></i><i className="b2"></i><i className="b3"></i><i className="b4"></i></div>
        <div className="legend">L1 system · L2 tools · L3 conversation · L4 state，一次典型长任务里的大致占比</div>
      </div>
    </div>
  </div>

    </>
  );
}

function S06() {
  return (
    <>

  <div className="eyebrow">02 Context Engineering</div>
  <h2>System Prompt：注意力最高的一层，用 <em>AGENTS.md</em> 定制</h2>
  <p className="sub">它每一轮都在，模型对它的注意力最高，也最容易被写坏。</p>
  <div className="grid g3 body">
    <div className="card">
      <div className="t">高度</div><h3>找对抽象高度</h3>
      <p>两个失败极端：写成一堆 if-else 式的硬规则（脆、难维护），或者写得太笼统、假设模型知道你没说的背景。<b>正确高度：具体到能指导行为，又给模型留判断空间。</b></p>
    </div>
    <div className="card c-cyan">
      <div className="t">原则</div><h3>原则比禁令有效</h3>
      <p>禁令「不许用 X」可以被绕过；原则「为什么这样做」能泛化到你没枚举的场景。<b>先交代为什么，再给判断标准，最后才让它出方案。</b></p>
    </div>
    <div className="card c-violet">
      <div className="t">迭代</div><h3>最小 prompt 起步</h3>
      <p>用最强模型 + 最小 prompt 先跑，按暴露出来的失败模式逐条补指令和示例。<b>一条关键原则胜过十条无效规则，堆砌会稀释注意力。</b></p>
    </div>
  </div>
  <div className="foot"><strong>AGENTS.md 是活的。</strong>验证过的规则沉淀进去；被模型训练进去的东西，就从里面删掉。</div>

    </>
  );
}

function S07() {
  return (
    <>

  <div className="eyebrow">02 Context Engineering</div>
  <h2>窗口大小 ≠ 真实有效的上下文</h2>
  <p className="sub">不同模型的窗口差好几倍。但上下文是稀疏的：token 越多，模型从中准确回忆信息的能力越差。</p>
  <div className="two body" style={{ gridTemplateColumns: "760px 1fr" }}>
    <div>
      <div className="bars">
        <div className="bar"><div className="name">Qwen 3.7 Plus<small>context window</small></div><div className="track"><div className="fill" style={{ width: "25.6%" }}></div></div><div className="val">256K</div></div>
        <div className="bar"><div className="name">Claude<small>context window</small></div><div className="track"><div className="fill" style={{ width: "100%" }}></div></div><div className="val">1M</div></div>
        <div className="bar"><div className="name">有效上下文<small>effective，任何模型</small></div><div className="track"><div className="fill eff" style={{ width: "100%" }}></div></div><div className="val" style={{ color: "var(--pink)" }}>递减</div></div>
      </div>
      <div className="curve">
        <svg viewBox="0 0 760 230" preserveAspectRatio="none">
          <defs><linearGradient id="g1" x1="0" x2="1"><stop offset="0" stopColor="#4fd8ff"/><stop offset="1" stopColor="#ff3d7f"/></linearGradient></defs>
          <line x1="40" y1="200" x2="740" y2="200" stroke="rgba(255,255,255,.2)"/>
          <line x1="40" y1="20" x2="40" y2="200" stroke="rgba(255,255,255,.2)"/>
          <path d="M40,40 C260,42 420,90 560,140 S700,190 740,196" fill="none" stroke="url(#g1)" strokeWidth="3"/>
          <text x="48" y="32" fill="#9aa3c7" fontSize="13">recall 准确率</text>
          <text x="600" y="222" fill="#9aa3c7" fontSize="13" fontFamily="monospace">tokens in window →</text>
          <text x="400" y="80" fill="#ff7aa8" fontSize="14" fontFamily="monospace">context rot</text>
        </svg>
      </div>
    </div>
    <div className="side" style={{ paddingTop: "10px" }}>
      <div className="note"><b>为什么会衰减：</b>注意力是 n² 的两两关系，越长越被摊薄；训练数据里短序列占多数，超长依赖见得少。所有模型都有，只是坡度不同。</div>
      <div className="note"><b>要问的问题是：</b>在我的任务里，塞到多少 token 之后它开始漏东西。「窗口多大」回答不了这个。</div>
      <div className="note"><b>推论：</b>上下文是有限的 attention budget，边际收益递减。目标是「能达成结果的最小高信号 token 集合」。</div>
    </div>
  </div>

    </>
  );
}

function S08() {
  return (
    <>

  <div className="eyebrow">02 Context Engineering</div>
  <h2>怎么避免上下文腐化：<em>信息密集 + 分治</em></h2>
  <p className="sub">前提只有一条：不要让无关的信息汇集到同一个 Agent / session 里。</p>
  <div className="grid g3 body">
    <div className="card">
      <div className="t">Compaction</div><h3>压缩</h3>
      <p>窗口将满时，让模型把历史总结成摘要，带着摘要开新窗口。保留架构决策、未解决的 bug、改过的文件；丢掉冗余的工具输出。最轻量的一招是直接清掉旧的 <span className="k">tool_result</span>。</p>
    </div>
    <div className="card c-cyan">
      <div className="t">Notes</div><h3>窗口外的笔记</h3>
      <p>把进度、决定、待办写进窗口外的持久文件（NOTES.md、memory），之后按需拉回。上下文里只留一个「标识符」，需要时再用工具读全文。</p>
    </div>
    <div className="card c-violet">
      <div className="t">Sub-agent</div><h3>分治上下文</h3>
      <p><b>Sub-agent 就是一种分治。</b>主 Agent 只做高层协调；子 Agent 用一份干净的小上下文深挖一个问题，只回传一两千 token 的结论。无关信息从一开始就进不了主线。</p>
    </div>
  </div>
  <div className="foot"><strong>三招的共同点：</strong>都在缩小「每一轮真正进入模型」的 token 集合，而不是把窗口撑大。</div>

    </>
  );
}

function S09() {
  return (
    <>

  <div className="eyebrow">03 方法论</div>
  <div className="q"><span className="a">Skill 将死，</span><span className="b">方法论永生</span></div>
  <div className="why">
    <div className="card">
      <div className="t">为什么 Skill 会不断死亡</div>
      <p>Skill 里的很多信息，会不断被最新的模型放进预训练。之前很流行的头脑风暴 Skill <span className="k">Superpowers</span>，已经被 <span className="k">Grill me</span> 完全取代。Grill me 每个 skill 只有两三行，效果却非常强。</p>
    </div>
    <div className="card c-cyan">
      <div className="t">为什么方法论一句顶一万句</div>
      <p>第一性原理、消融实验、奥卡姆剃刀……它们的整个流程和思维原理已经训练进模型里了。<b>我们只需要一个名词，就能激活模型内部与这套方法论相关的所有参数。</b></p>
    </div>
  </div>

    </>
  );
}

function S10() {
  return (
    <>

  <div className="eyebrow">03 方法论</div>
  <h2>一个名词，激活一整套原理</h2>
  <p className="sub">这些词一句顶一万句，因为它们的流程和思维方式已经训练进了模型。对 Agent 说出这个词，就够了。</p>
  <div className="mgrid">
    <div className="m"><div className="w">第一性原理</div><div className="en">First principles</div><p>复现了吗？修复了吗？红绿了吗？修的是根因，还是在旧结构上打补丁？</p></div>
    <div className="m"><div className="w">对抗式审查</div><div className="en">Adversarial review</div><p>让没参与实现的 Agent 专挑毛病。Prove it, don't tell me.</p></div>
    <div className="m"><div className="w">消融实验</div><div className="en">Ablation</div><p>去掉一个组件再跑一遍。每条规则、每个工具都要证明自己在起作用。</p></div>
    <div className="m"><div className="w">奥卡姆剃刀</div><div className="en">Occam's razor</div><p>能用更少机制解决的方案优先。先做最简单能工作的版本。</p></div>
    <div className="m"><div className="w">列出所有不自信的点</div><div className="en">List every uncertainty</div><p>把「承认不确定」变成任务。全票通过不等于没有风险。</p></div>
    <div className="m"><div className="w">保持独立思考</div><div className="en">Independent thinking</div><p>采纳别人观点前先形成自己的判断。多 Agent 环境里尤其重要。</p></div>
    <div className="m"><div className="w">批判性思维</div><div className="en">Critical thinking</div><p>警惕讲得太顺的解释。不为对齐一张截图去编造不存在的 bug。</p></div>
    <div className="m"><div className="w">高内聚，低耦合</div><div className="en">High cohesion, low coupling</div><p>模块边界清晰，就是在做上下文分片。Agent 要理解的东西更少。</p></div>
  </div>

    </>
  );
}

function S11() {
  return (
    <>

  <div className="eyebrow">04 长活 Agent</div>
  <h2>为什么要有长程 Agent：它会<em>富集上下文</em></h2>
  <p className="sub">一次性的 session 每次从零开始。长程 Agent 持续累积一个项目的所有信息，慢慢长出自己的做事风格和流程。</p>
  <div className="tl">
    <div className="line"></div>
    <div className="pt" style={{ left: "6%" }}></div><div className="pt" style={{ left: "30%" }}></div><div className="pt" style={{ left: "54%" }}></div><div className="pt" style={{ left: "78%" }}></div>
    <div className="lab up" style={{ left: "6%" }}><b>项目信息</b>代码结构、模块怎么协作、数据从哪来到哪去</div>
    <div className="lab down" style={{ left: "30%" }}><b>做事风格</b>我们怎么拆任务、怎么提交、什么算完成</div>
    <div className="lab up" style={{ left: "54%" }}><b>设计准则与流程</b>评审标准、不做的事、发布前要跑什么</div>
    <div className="lab down" style={{ left: "78%" }}><b>像一个人一样</b>积累起可复用的判断，而不只是记录</div>
  </div>
  <div className="foot"><strong>关键区别：</strong>我们不断交给它项目信息、做事风格、设计准则，它把这些变成自己的上下文。它记住的是一套做法，聊天记录只是副产品。</div>

    </>
  );
}

function S12() {
  return (
    <>

  <div className="eyebrow">04 长活 Agent，例子</div>
  <h2>例子：Apache Maka 的 <em>Review Agent</em> 就是一个长活 Agent</h2>
  <p className="sub">每个维护者都有若干个 Review Agent。它不是一次性的 session：一直在运行，PR 来了就处理，方法论和记忆越积越多。</p>
  <div className="lr">
    <svg viewBox="0 0 980 250" className="lrd" preserveAspectRatio="xMidYMid meet">
      <defs><marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ff3d7f"/></marker>
      <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4fd8ff"/></marker></defs>
      {/* inputs */}
      <text x="20" y="22" fill="#9aa3c7" fontSize="12" letterSpacing="2">INPUT · 源源不断</text>
      <g fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.18)">
        <rect x="20" y="34" width="170" height="26" rx="5"/><rect x="20" y="66" width="170" height="26" rx="5"/><rect x="20" y="98" width="170" height="26" rx="5"/>
      </g>
      <g fill="#e8ecf8" fontSize="12" fontFamily="monospace"><text x="30" y="51">PR #1201 · fix</text><text x="30" y="83">PR #1202 · feat</text><text x="30" y="115">PR #1203 · refactor …</text></g>
      <rect x="20" y="150" width="170" height="52" rx="6" fill="rgba(255,61,127,.12)" stroke="#ff3d7f"/>
      <text x="105" y="171" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="600">维护者</text>
      <text x="105" y="190" textAnchor="middle" fill="#ffd3e2" fontSize="11">教方法论 · 纠错</text>
      <g stroke="#4fd8ff" strokeWidth="1.5" fill="none" markerEnd="url(#ar3)"><path d="M190,79 L260,79"/></g>
      <g stroke="#ff3d7f" strokeWidth="1.5" fill="none" markerEnd="url(#ar2)"><path d="M190,176 L225,176 L225,140 L260,140"/></g>
      {/* agent */}
      <rect x="262" y="30" width="420" height="190" rx="12" fill="rgba(10,16,40,.75)" stroke="#4fd8ff" strokeWidth="1.5"/>
      <text x="280" y="54" fill="#4fd8ff" fontSize="12" letterSpacing="2">REVIEW AGENT · 一直在运行</text>
      <text x="664" y="54" textAnchor="end" fill="#9aa3c7" fontSize="11">running</text>
      <g fill="rgba(255,61,127,.1)" stroke="rgba(255,61,127,.6)"><rect x="280" y="68" width="122" height="70" rx="6"/></g>
      <g fill="rgba(155,123,255,.1)" stroke="rgba(155,123,255,.6)"><rect x="411" y="68" width="122" height="70" rx="6"/></g>
      <g fill="rgba(255,200,87,.08)" stroke="rgba(255,200,87,.6)"><rect x="542" y="68" width="122" height="70" rx="6"/></g>
      <g fill="#fff" fontSize="13" fontWeight="600" textAnchor="middle"><text x="341" y="90">方法论</text><text x="472" y="90">Memory</text><text x="603" y="90">工具链</text></g>
      <g fill="#9aa3c7" fontSize="10.5" textAnchor="middle">
        <text x="341" y="108">AGENTS.md · skills</text><text x="341" y="124">分级 / 分类 / 流程</text>
        <text x="472" y="108">contributor 画像</text><text x="472" y="124">项目约定 · 历史决定</text>
        <text x="603" y="108">gh · 测试 · 复现</text><text x="603" y="124">CLI / MCP / 脚本</text>
      </g>
      {/* accumulation bar inside agent */}
      <text x="280" y="164" fill="#9aa3c7" fontSize="11">随时间累积 →</text>
      <rect x="280" y="174" width="384" height="10" rx="5" fill="rgba(255,255,255,.06)"/>
      <rect x="280" y="174" width="384" height="10" rx="5" fill="url(#gacc)"/>
      <defs><linearGradient id="gacc" x1="0" x2="1"><stop offset="0" stopColor="#ff3d7f" stopOpacity=".2"/><stop offset="1" stopColor="#4fd8ff"/></linearGradient></defs>
      <g fill="#9aa3c7" fontSize="10.5"><text x="280" y="204">第 1 周：只会照流程跑</text><text x="664" y="204" textAnchor="end">第 N 周：认得人、记得约定、有自己的判断</text></g>
      {/* outputs */}
      <g stroke="#4fd8ff" strokeWidth="1.5" fill="none" markerEnd="url(#ar3)"><path d="M682,125 L750,125"/></g>
      <text x="752" y="22" fill="#9aa3c7" fontSize="12" fontFamily="monospace" letterSpacing="2">OUTPUT</text>
      <g fill="rgba(79,216,255,.08)" stroke="rgba(79,216,255,.5)"><rect x="752" y="34" width="210" height="30" rx="5"/><rect x="752" y="72" width="210" height="30" rx="5"/><rect x="752" y="110" width="210" height="30" rx="5"/><rect x="752" y="148" width="210" height="30" rx="5"/></g>
      <g fill="#e8ecf8" fontSize="12.5"><text x="764" y="54">给 PR 分级、分类</text><text x="764" y="92">识别 Contributor，区别对待</text><text x="764" y="130">定期巡一遍，给 review 意见</text><text x="764" y="168">跑完流程才 approve</text></g>
    </svg>
  </div>
  <div className="flow compact" style={{ marginTop: "12px" }}>
    <div className="step"><div className="n">Fix PR · 第 1 步</div><h3>复现</h3><p>先在本地把问题真实跑出来，不是看描述。</p></div>
    <div className="arrow">→</div>
    <div className="step"><div className="n">第 2 步</div><h3>定位</h3><p>找到根因，确认修的是根因而不是表象。</p></div>
    <div className="arrow">→</div>
    <div className="step"><div className="n">第 3 步</div><h3>评分</h3><p>修复是否符合第一性原理，优雅不短视。</p></div>
    <div className="arrow">→</div>
    <div className="step"><div className="n">第 4 步</div><h3>改进</h3><p>给出具体的修改建议，而不是「看起来没问题」。</p></div>
    <div className="arrow">→</div>
    <div className="step gate"><div className="n">门禁</div><h3>Approve</h3><p>完整跑过这套流程的 PR，我们才会 approve。</p></div>
  </div>

    </>
  );
}

function S13() {
  return (
    <>

  <div className="eyebrow">04 多 Agent</div>
  <h2>Swarm、Graph、Agent Team：<em>面向不同的场景</em></h2>
  <p className="sub">它们都是多 Agent，但解决的是三种不同的协调问题。先看任务之间有没有依赖、要不要长活，再选形态。</p>
  <div className="grid g3 body ma">
    <div className="card">
      <div className="t">Swarm：独立并行</div>
      <svg viewBox="0 0 300 120" className="dg">
        <rect x="120" y="8" width="60" height="26" rx="6" fill="rgba(255,61,127,.18)" stroke="#ff3d7f"/>
        <text x="150" y="26" textAnchor="middle" fill="#fff" fontSize="11">协调者</text>
        <g stroke="rgba(255,61,127,.6)"><line x1="150" y1="34" x2="30" y2="80"/><line x1="150" y1="34" x2="90" y2="80"/><line x1="150" y1="34" x2="150" y2="80"/><line x1="150" y1="34" x2="210" y2="80"/><line x1="150" y1="34" x2="270" y2="80"/></g>
        <g fill="rgba(79,216,255,.15)" stroke="#4fd8ff"><rect x="10" y="80" width="40" height="24" rx="5"/><rect x="70" y="80" width="40" height="24" rx="5"/><rect x="130" y="80" width="40" height="24" rx="5"/><rect x="190" y="80" width="40" height="24" rx="5"/><rect x="250" y="80" width="40" height="24" rx="5"/></g>
        <g fill="#bfefff" fontSize="10" fontFamily="monospace" textAnchor="middle"><text x="30" y="96">A1</text><text x="90" y="96">A2</text><text x="150" y="96">A3</text><text x="210" y="96">…</text><text x="270" y="96">A10</text></g>
      </svg>
      <h3>任务能拆成互不依赖的几份</h3>
      <p>一个<b>协调者 Agent</b> 把任务拆成并行的若干份，分发给若干个 Agent 同时去做，最后汇总。</p>
      <p style={{ marginTop: "8px" }}><b>例：</b>调研 10 个项目，显然可以拆给 10 个 Agent 并行做。</p>
    </div>
    <div className="card c-cyan">
      <div className="t">Graph：有依赖，DAG</div>
      <svg viewBox="0 0 300 120" className="dg">
        <rect x="120" y="6" width="60" height="24" rx="6" fill="rgba(255,61,127,.18)" stroke="#ff3d7f"/>
        <text x="150" y="22" textAnchor="middle" fill="#fff" fontSize="11">主 Agent</text>
        <g stroke="rgba(79,216,255,.7)" fill="none" markerEnd="url(#ar)"><path d="M70,60 L120,60"/><path d="M180,60 L215,60"/><path d="M40,72 L40,88 L215,88 L215,72"/></g>
        <g fill="rgba(79,216,255,.15)" stroke="#4fd8ff"><rect x="10" y="48" width="60" height="24" rx="5"/><rect x="120" y="48" width="60" height="24" rx="5"/><rect x="215" y="48" width="75" height="24" rx="5"/></g>
        <g fill="#bfefff" fontSize="10" textAnchor="middle"><text x="40" y="64">后端</text><text x="150" y="64">前端</text><text x="252" y="64">review·测试</text></g>
        <g stroke="rgba(255,61,127,.35)" strokeDasharray="3 3"><line x1="150" y1="30" x2="40" y2="48"/><line x1="150" y1="30" x2="150" y2="48"/><line x1="150" y1="30" x2="252" y2="48"/></g>
        <text x="150" y="112" textAnchor="middle" fill="#9aa3c7" fontSize="10">拆分 → 划 DAG → 分配 → 推进 → 监督</text>
      </svg>
      <h3>任务之间有前后依赖</h3>
      <p>一个<b>主 Agent</b> 负责拆分任务、划出 DAG（有向无环图）、把节点分配给子 Agent，推进整张图的执行，并监督直到全部完成。</p>
      <p style={{ marginTop: "8px" }}><b>例：</b>前端、后端的开发，和 review、测试是相互 block 的，有先后。</p>
    </div>
    <div className="card c-violet">
      <div className="t">Agent Team：长活，有角色</div>
      <svg viewBox="0 0 300 120" className="dg">
        <rect x="10" y="8" width="280" height="104" rx="10" fill="rgba(155,123,255,.08)" stroke="rgba(155,123,255,.5)" strokeDasharray="4 3"/>
        <text x="22" y="24" fill="#9b7bff" fontSize="10">群聊 · 一直在运行</text>
        <g fill="rgba(155,123,255,.18)" stroke="#9b7bff"><rect x="24" y="40" width="76" height="54" rx="6"/><rect x="112" y="40" width="76" height="54" rx="6"/><rect x="200" y="40" width="76" height="54" rx="6"/></g>
        <g fill="#fff" fontSize="10" textAnchor="middle"><text x="62" y="58">产品经理</text><text x="150" y="58">前端工程师</text><text x="238" y="58">后端工程师</text></g>
        <g fill="#9aa3c7" fontSize="8" fontFamily="monospace" textAnchor="middle"><text x="62" y="74">memory·tools</text><text x="150" y="74">memory·tools</text><text x="238" y="74">memory·tools</text><text x="62" y="86">context</text><text x="150" y="86">context</text><text x="238" y="86">context</text></g>
        <g stroke="rgba(155,123,255,.7)"><line x1="100" y1="67" x2="112" y2="67"/><line x1="188" y1="67" x2="200" y2="67"/></g>
      </svg>
      <h3>若干个彼此独立的长活 Agent</h3>
      <p>每个 Agent 都有<b>自己的 Memory、自己的工具链、自己的上下文</b>，各有角色，相互交流、分配工作。</p>
      <p style={{ marginTop: "8px" }}><b>强依赖长活 Agent：</b>产品经理、前端、后端一直在运行，在一个群聊里并行协作。</p>
    </div>
  </div>
  <svg width="0" height="0" style={{ position: "absolute" }}><defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4fd8ff"/></marker></defs></svg>

    </>
  );
}

function S14() {
  return (
    <>

  <div className="eyebrow">04 多 Agent，例子：Graph</div>
  <h2>例子：Maka Agent Graph，<em>三权分立</em>推进一张动态 DAG</h2>
  <p className="sub">Agent 的计划没法一次静态写死：探索会发现新分支，子任务失败会改路线。所以 Maka 把 Graph 建成一张在会话里持续演进的 DAG，并把职责拆成三份。</p>
  <div className="two body" style={{ gridTemplateColumns: "900px 1fr", gap: "34px" }}>
    <svg viewBox="0 0 900 300" className="gflow">
      <defs><marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4fd8ff"/></marker></defs>
      {/* main agent */}
      <rect x="10" y="20" width="200" height="70" rx="10" fill="rgba(255,61,127,.14)" stroke="#ff3d7f" strokeWidth="1.5"/>
      <text x="110" y="48" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="700">主 Agent</text>
      <text x="110" y="70" textAnchor="middle" fill="#ffd3e2" fontSize="11">规划蓝图 · 语义决策</text>
      {/* sqlite */}
      <rect x="290" y="20" width="220" height="70" rx="10" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.3)"/>
      <text x="400" y="45" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="600">SQLite 控制面</text>
      <text x="400" y="64" textAnchor="middle" fill="#9aa3c7" fontSize="10.5" fontFamily="monospace">schedule · claims · wakes</text>
      <text x="400" y="80" textAnchor="middle" fill="#9aa3c7" fontSize="10.5">append-only，崩溃不丢</text>
      {/* coordinator */}
      <rect x="590" y="20" width="300" height="70" rx="10" fill="rgba(79,216,255,.12)" stroke="#4fd8ff" strokeWidth="1.5"/>
      <text x="740" y="45" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="700">Coordinator</text>
      <text x="740" y="66" textAnchor="middle" fill="#bfefff" fontSize="10.5">每次从落盘事实重建快照 → 算 Ready</text>
      <text x="740" y="81" textAnchor="middle" fill="#bfefff" fontSize="10.5">确定性 · 不做语义判断</text>
      <g stroke="#4fd8ff" strokeWidth="1.6" fill="none" markerEnd="url(#ag)"><path d="M210,55 L288,55"/><path d="M510,55 L588,55"/></g>
      <text x="249" y="45" textAnchor="middle" fill="#ffd3e2" fontSize="10" fontFamily="monospace">Durable Intent</text>
      <text x="549" y="45" textAnchor="middle" fill="#bfefff" fontSize="10" fontFamily="monospace">reconcile</text>
      {/* claim + runs */}
      <rect x="590" y="125" width="140" height="56" rx="8" fill="rgba(255,200,87,.1)" stroke="rgba(255,200,87,.7)"/>
      <text x="660" y="148" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="600">Conditional Claim</text>
      <text x="660" y="166" textAnchor="middle" fill="#ffe6a8" fontSize="10">一次性原子落盘</text>
      <g stroke="#4fd8ff" strokeWidth="1.6" fill="none" markerEnd="url(#ag)"><path d="M740,90 L740,123"/></g>
      <g fill="rgba(79,216,255,.1)" stroke="rgba(79,216,255,.5)"><rect x="760" y="125" width="130" height="56" rx="8"/></g>
      <text x="825" y="148" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="600">子 AgentRun ×N</text>
      <text x="825" y="166" textAnchor="middle" fill="#bfefff" fontSize="10">并发 · 复用 Session Runtime</text>
      <g stroke="#4fd8ff" strokeWidth="1.6" fill="none" markerEnd="url(#ag)"><path d="M730,153 L758,153"/></g>
      {/* events back */}
      <g fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.3)"><rect x="590" y="215" width="300" height="50" rx="8"/></g>
      <text x="740" y="236" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="600">committed RuntimeEvents</text>
      <text x="740" y="253" textAnchor="middle" fill="#9aa3c7" fontSize="10">下游只消费已提交的产物记录</text>
      <g stroke="#4fd8ff" strokeWidth="1.6" fill="none" markerEnd="url(#ag)"><path d="M825,181 L825,213"/><path d="M590,240 L400,240 L400,92"/></g>
      {/* supervisor wake */}
      <rect x="10" y="125" width="200" height="70" rx="10" fill="rgba(155,123,255,.12)" stroke="#9b7bff" strokeWidth="1.5"/>
      <text x="110" y="153" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="700">Supervisor</text>
      <text x="110" y="175" textAnchor="middle" fill="#d9ccff" fontSize="11">到 Durable Checkpoint 才唤醒</text>
      <g stroke="#9b7bff" strokeWidth="1.6" fill="none" strokeDasharray="5 4" markerEnd="url(#ag)"><path d="M290,70 L230,70 L230,140 L212,140"/><path d="M110,125 L110,92"/></g>
      <text x="110" y="230" textAnchor="middle" fill="#9aa3c7" fontSize="10.5">主 Agent 提交计划后就结束本轮</text>
      <text x="110" y="246" textAnchor="middle" fill="#9aa3c7" fontSize="10.5">图推进到检查点，Host 再叫醒它</text>
      <text x="110" y="262" textAnchor="middle" fill="#9aa3c7" fontSize="10.5">读快照 → 加任务 / 换路线 / 终结</text>
    </svg>
    <div className="side" style={{ paddingTop: "4px" }}>
      <div className="note"><b>主 Agent 只写意图，不推图。</b>只有 Root Session 的主 Agent 能改全局拓扑；子会话没有这个权限。</div>
      <div className="note"><b>Ready 可以反复算，执行只准入一次。</b>就绪是无副作用的投影；真正拉起前先写 Claim，重试和抖动都不会重复跑。</div>
      <div className="note"><b>不造第二套 Runtime。</b>SQLite 只管调度事实，模型调用、工具、权限、事件全复用 Session Runtime。</div>
      <div className="note" style={{ fontFamily: "var(--mono)", fontSize: "14px" }}>github.com/apache/maka · docs/blogs/multi-agent-scheduling.zh-CN.md</div>
    </div>
  </div>

    </>
  );
}

function S15() {
  return (
    <>

  <div className="eyebrow">04 Agent Team</div>
  <h2>Agent Team 最难：<em>组织架构</em>本身就难</h2>
  <p className="sub">有了长程 Agent，就会有多个长程 Agent，它们之间需要相互交流。先说难点，再看两个产品和我们自己的实战。</p>
  <div className="team">
    <div className="nodes">
      <svg viewBox="0 0 750 380"><g stroke="rgba(255,61,127,.55)" strokeWidth="1.5" fill="none">
        <path d="M375,60 L75,170"/><path d="M375,60 L275,170"/><path d="M375,60 L475,170"/><path d="M375,60 L675,170"/></g>
        <g stroke="rgba(79,216,255,.35)" strokeDasharray="4 4" fill="none"><path d="M150,215 L200,215"/><path d="M350,215 L400,215"/><path d="M550,215 L600,215"/></g></svg>
      <div className="hm">人 · 编排者</div>
      <div className="ag a1">Review<small>context A</small></div>
      <div className="ag a2">Triage<small>context B</small></div>
      <div className="ag a3">Fix<small>context C</small></div>
      <div className="ag a4">Release<small>context D</small></div>
      <div className="ctxbar">agent 数量 = 相互独立的 context 数量。共享同一份上下文的 100 个 Agent，等于 100 个相同的人。</div>
    </div>
    <div className="side">
      <div className="note"><b>Agent Team 的维护难度很高。</b>需要分支上下文，需要人用心管理，需要人用心编排。</div>
      <div className="note"><b>因为组织架构学本身就是一件难事。</b>谁负责什么、谁不负责什么、消息该给谁看，这些对人难，对 Agent 更难。</div>
      <div className="note"><b>人是主线，Agent 是分支。</b>方向、契约、最终判断留在人手里；Agent 之间多一轮讨论，常常不如多跑一次代码。</div>
    </div>
  </div>

    </>
  );
}

function S16() {
  return (
    <>

  <div className="eyebrow">05 人是编排者</div>
  <h2>人是 Agent 最好的<em>编排者</em></h2>
  <p className="sub">现在有个很火的词叫蒸馏：一个强的 Agent 带几个弱的 Agent，给它一个标准范例让它学。人指导 Agent，做的其实是同一件事。</p>
  <div className="two body" style={{ gridTemplateColumns: "720px 1fr", gap: "40px" }}>
    <svg viewBox="0 0 720 300" className="hloop">
      <defs><marker id="ap" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ff3d7f"/></marker>
      <marker id="ac" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4fd8ff"/></marker></defs>
      <rect x="20" y="90" width="150" height="110" rx="12" fill="rgba(255,61,127,.14)" stroke="#ff3d7f" strokeWidth="1.5"/>
      <text x="95" y="135" textAnchor="middle" fill="#fff" fontSize="24" fontWeight="700">人</text>
      <text x="95" y="162" textAnchor="middle" fill="#ffd3e2" fontSize="12">教练 · 质量官</text>
      <text x="95" y="180" textAnchor="middle" fill="#ffd3e2" fontSize="12">价值观来源</text>
      <rect x="550" y="90" width="150" height="110" rx="12" fill="rgba(79,216,255,.12)" stroke="#4fd8ff" strokeWidth="1.5"/>
      <text x="625" y="135" textAnchor="middle" fill="#fff" fontSize="22" fontWeight="700">长活 Agent</text>
      <text x="625" y="162" textAnchor="middle" fill="#bfefff" fontSize="12" fontFamily="monospace">Memory · AGENTS.md</text>
      <text x="625" y="180" textAnchor="middle" fill="#bfefff" fontSize="12" fontFamily="monospace">skills · eval cases</text>
      <g stroke="#ff3d7f" strokeWidth="2" fill="none" markerEnd="url(#ap)"><path d="M170,115 L548,115"/></g>
      <g stroke="#4fd8ff" strokeWidth="2" fill="none" markerEnd="url(#ac)"><path d="M550,175 L172,175"/></g>
      <g fill="rgba(255,61,127,.12)" stroke="rgba(255,61,127,.5)"><rect x="220" y="40" width="280" height="56" rx="8"/></g>
      <text x="360" y="62" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="600">方法论 · 做事规则 · 标准范例</text>
      <text x="360" y="82" textAnchor="middle" fill="#ffd3e2" fontSize="11">什么该做 / 选 A 不选 B / 什么算完成</text>
      <g fill="rgba(79,216,255,.1)" stroke="rgba(79,216,255,.5)"><rect x="220" y="196" width="280" height="56" rx="8"/></g>
      <text x="360" y="218" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="600">结果 · 不确定项 · 影响面</text>
      <text x="360" y="238" textAnchor="middle" fill="#bfefff" fontSize="11">人来纠正、确认、重写、否定</text>
      <g fill="#ffc857" fontSize="12"><text x="360" y="140" textAnchor="middle">每一次纠正 = 一条带意图和判断的对齐数据</text><text x="360" y="158" textAnchor="middle" fill="#9aa3c7">长活 Agent 把它们积累下来</text></g>
      <text x="360" y="285" textAnchor="middle" fill="#9aa3c7" fontSize="12">这个循环跑得越久，Agent 越像「共事三年的下属」</text>
    </svg>
    <div className="side" style={{ paddingTop: "6px" }}>
      <div className="note"><b>蒸馏：</b>强 Agent 带弱 Agent，给标准范例让它学。这条路线叫 <span className="k">OPD · On-Policy Distillation</span>：给的是「标准动作」和「判断依据」，每一步操作让它自己走。</div>
      <div className="note"><b>人指导 Agent，就是在蒸馏方法论。</b>传递的是一套做事规则：什么该做，什么情况下选 A 不选 B，什么算完成，什么错误必须拦。</div>
      <div className="note"><b>人本身就是高质量数据集的生产器。</b>每一次纠正、确认、重写、否定，都带着意图、上下文和判断，比网上爬来的通用语料值钱得多。</div>
      <div className="note"><b>长活 Agent 的价值，</b>就是把这些人机之间的高质量互动积累下来。壁垒在于它知道多少「只有你我知道」的东西，模型本身多强反而其次。</div>
    </div>
  </div>

    </>
  );
}

function S17() {
  return (
    <>

  <div className="eyebrow">05 人是编排者</div>
  <h2>放手执行，<em>不放任方向</em></h2>
  <p className="sub">人不必逐行替 Agent 写代码，但必须保留四样东西。让渡的是「执行路径的选择权」，保留的是「方向的判断权」和「结果的定义权」。</p>
  <div className="grid g4 body">
    <div className="card"><div className="t">保留一</div><h3>目标</h3><p>要解决什么问题、为什么做。<b>目标错了，执行再好也没用。</b></p></div>
    <div className="card c-cyan"><div className="t">保留二</div><h3>契约</h3><p>输入输出、边界条件、不可违反的约束。<b>契约是信任的基础，违约就是事故。</b></p></div>
    <div className="card c-violet"><div className="t">保留三</div><h3>取舍</h3><p>资源有限时优先保什么、牺牲什么。<b>取舍体现价值观，Agent 无法替你排序。</b></p></div>
    <div className="card c-amber"><div className="t">保留四</div><h3>验收</h3><p>什么算「好」、什么算「完成」。<b>验收标准就是人定义的「成功」本身。</b></p></div>
  </div>
  <div className="grid g2" style={{ marginTop: "22px" }}>
    <div className="card" style={{ padding: "20px 24px" }}><div className="t">流水线模型：上限低</div><p>人把任务拆成固定步骤，Agent 只执行其中一环。它永远学不到「为什么」，也不会进化。</p></div>
    <div className="card c-cyan" style={{ padding: "20px 24px" }}><div className="t">师徒模型：上限高</div><p>人给目标、讲原则、看结果、给反馈；Agent 自己探索路径。这才是「编排」，也是前面所有方法论起作用的前提。</p></div>
  </div>

    </>
  );
}

function S18() {
  return (
    <>

  <div className="eyebrow">05 人是编排者</div>
  <h2>蒸馏是双向的，记忆分三层</h2>
  <p className="sub">人在蒸馏 Agent；跑得够久之后，Agent 也在蒸馏你。长活 Agent 该记什么，决定了它能不能被通用模型替代。</p>
  <div className="grid g2 body" style={{ gap: "32px" }}>
    <div className="card">
      <div className="t">反向蒸馏：Agent 也在学你</div>
      <h3>它在大量任务里发现你自己没意识到的规律</h3>
      <ul>
        <li>发现你总是先看数据再看方案 → 它主动先把数据整理好</li>
        <li>发现你对某类错误零容忍 → 它主动加校验、加测试</li>
        <li>发现你这段时间偏好激进策略 → 它调整建议的风格</li>
      </ul>
      <p style={{ marginTop: "12px" }}>所以这是一个<b>双向蒸馏</b>的过程：你教它方法论，它把你的偏好变成默认行为。</p>
    </div>
    <div className="card c-cyan">
      <div className="t">长活 Agent 的三层记忆</div>
      <div className="mem">
        <div className="ml m3"><b>价值观记忆</b><span>冲突时的取舍倾向、你对「好」的定义</span><i>最难替代</i></div>
        <div className="ml m2"><b>方法论记忆</b><span>解决问题的固定套路、决策树、检查清单</span></div>
        <div className="ml m1"><b>事实记忆</b><span>常用工具、路径、格式偏好、项目约定</span><i>最易替代</i></div>
      </div>
      <p style={{ marginTop: "12px" }}>越往上，越难被通用模型替代，也越是你自己的护城河。</p>
    </div>
  </div>
  <div className="foot"><strong>人是 Agent 的教练、质量官和价值观来源，</strong>写代码的活可以让出去。蒸馏做的事，是把人身上难以言传的判断力，变成机器可以执行的方法论。</div>

    </>
  );
}

function S19() {
  return (
    <>

  <div className="eyebrow">04 多 Agent，例子：Team</div>
  <h2>例子：raft.build 与 Grok Bot，<em>群聊里的长活同事</em></h2>
  <p className="sub">两个产品的形态几乎一样：每个 Agent 是一个持久进程，有自己的记忆和工具，人和 Agent 在同一个聊天空间里协作。</p>
  <div className="grid g2 body" style={{ gap: "28px" }}>
    <div className="card">
      <div className="t">raft.build，"where humans and AI agents build together"</div>
      <ul>
        <li><b>Agent 是持久的团队成员，</b>不是一次性工具。每个 Agent 有自己的 memory，是一个 persistent process，能「从上次停下的地方接着做」。</li>
        <li><b>协作发生在 channels、DM、threads 里，</b>人和 Agent 共享同一份上下文。</li>
        <li><b>Agent 自己 claim 任务，并行跑，互相交接，</b>在共享 thread 里互相 review 对方的产出。</li>
        <li><b>跑在你自己的机器上：</b>一个轻量 daemon（它叫 Computer）把 Agent 接到文件、工具和你的 AI 订阅上。</li>
      </ul>
    </div>
    <div className="card c-cyan">
      <div className="t">Grok Bot，SpaceXAI，2026 年 8 月</div>
      <ul>
        <li><b>一个 Bot 是一个有名字的持久 Agent，</b>跑在自己的云端电脑上。你给它一个活和工具权限，合上笔记本它还在干。</li>
        <li><b>只有需要人拍板时才回来找你。</b>其余时间自己推进。</li>
        <li><b>Telegram / Slack 式界面：</b>和每个 Agent 单独 DM，也有多个 Agent 一起的群频道。</li>
        <li><b>典型玩法：</b>一个「Chief of Staff」Bot 带队，把活分给调研、写码、运营等专职 Bot。社区已有上千个团队配置。</li>
      </ul>
    </div>
  </div>
  <div className="foot"><strong>对上前一页的定义：</strong>长活 + 各自独立的 Memory 和工具链 + 群聊里分工协作 + 人做最终决定。这就是 Agent Team，也是它为什么强依赖长活 Agent。</div>

    </>
  );
}

function S20() {
  return (
    <>

  <div className="eyebrow">04 多 Agent，例子：Team，实战</div>
  <h2>实战：Apache Maka 的 Review Agent 团队，就跑在 <em>raft</em> 里</h2>
  <p className="sub">这是我们自己的工作区。左边每个维护者一个 PR-Review 频道，右边这个只读群，是人写给 Agent 看的 Review 规则。</p>
  <div className="shot">
    <div className="frame"><img src="/raft-review.png" alt="raft 工作区截图：Review-Principle 只读群"/></div>
    <div className="side">
      <div className="note"><b>一人一个 Review 频道。</b>PR-Review-Qronos、Kabi、M4n5ter、Leaders……每个维护者带自己的长活 Review Agent，以 owner 的身份对外发言。</div>
      <div className="note"><b>Review-Principle 只读群 = 方法论的沉淀处。</b>人在这里写规则，Agent 在这里读规则。这就是上一节说的「人蒸馏方法论给 Agent」。</div>
      <div className="note"><b>规则长什么样：</b>对外发布不提内部名词；影响大的 PR 先 DM 人类；db schema 变更单独警惕、查 migration；不是所有 PR 都要合并，质量低的标记延后；检查冲突、该不该 rebase。</div>
      <div className="note"><b>为什么是群聊而不是文档：</b>规则在对话里长出来，带着上下文和讨论过程；长活 Agent 一直在群里，新规则立刻生效，不用重新部署。</div>
    </div>
  </div>

    </>
  );
}

function S21() {
  return (
    <>

  <div className="eyebrow">06 定义自己的 Harness</div>
  <h2>如何定义自己的 Harness：<em>两件事</em></h2>
  <p className="sub">不需要从零写一个 Agent 框架。在我看来，定义自己的 Harness 主要就是这两个方面。</p>
  <div className="grid g2 body">
    <div className="card">
      <h3>管理好上下文</h3>
      <ul>
        <li><b>做好上下文的分支：</b>不同任务、不同角色，各自独立的 context，不混在一起。</li>
        <li><b>做好上下文的压缩：</b>什么时候 compact、压缩时保留什么、丢掉什么。</li>
        <li><b>把自己的经验总结成 skill：</b>验证过的做法沉淀进 AGENTS.md、skills、memory，而不是只留在脑子里。</li>
      </ul>
    </div>
    <div className="card c-cyan">
      <h3>沉淀 Workflow 成工具</h3>
      <ul>
        <li><b>把自己的流程用代码具体沉淀下来，</b>变成一个给 Agent 使用的工具。</li>
        <li>一个 <span className="k">CLI</span>、一个 <span className="k">MCP</span>、一段脚本。流程一旦是代码，Agent 每次都走同一条路，不用每次重新想。</li>
        <li><b>Agent 负责探索和决策，Workflow 承担固定步骤和门禁。</b></li>
      </ul>
    </div>
  </div>
  <div className="foot">上下文决定它知道什么，工具决定它能做什么。两边都管住，Harness 就成型了。</div>

    </>
  );
}

function S22() {
  return (
    <>

  <div className="eyebrow">06 AX，Agent Experience</div>
  <h2>CLI、MCP、沉淀成脚本的 Workflow，它们的设计与描述我称之为 <em>AX</em></h2>
  <p className="sub">AX 是给 Agent 做的体验设计，不是给人。人靠视觉和直觉；Agent 只有上下文和文字。人觉得好用的工具，Agent 可能完全抓瞎。AX 的设计会强影响 AI 的表现。</p>
  <div className="axrow"><span>CLI</span><span>MCP</span><span>程序 / 脚本化的 Workflow</span><i>← Agent 能用的三种工具形态，name、description、返回值就是它们的全部界面</i></div>
  <div className="grid g4" style={{ marginTop: "22px" }}>
    <div className="card"><div className="t">原则一</div><h3>Show the state</h3><p>需要的事实直接返回到位，别指望 Agent 在压力下自己推导隐藏信息。</p></div>
    <div className="card c-cyan"><div className="t">原则二</div><h3>Recoverable failures</h3><p>错误信息要说清原因、替代路径和重试条件，别把循环推进死角。</p></div>
    <div className="card c-violet"><div className="t">原则三</div><h3>Measure the interface</h3><p>很多「模型不行」其实是「接口没给好」。同一个模型，只改工具返回格式，结果就不一样。</p></div>
    <div className="card c-amber"><div className="t">检验</div><h3>盲测 UAT</h3><p>找一个没参与实现的 Agent，不给提示，能独立用成功才算工具可用。人觉得好用不算数。</p></div>
  </div>
  <div className="foot"><strong>Agent is the developer.</strong>工具的第一用户是 Agent。name 和 description 就是它唯一能看到的说明书。</div>

    </>
  );
}

function S23() {
  return (
    <>

  <div className="eyebrow">回顾</div>
  <h2>回到开头的问题：怎么 Harness 我的大模型</h2>
  <p className="sub">六个部分，其实是同一件事的六个切面：让模型进入一个能记住、能动手、能被看见、能长期运行的系统。</p>
  <div className="recap">
    <div className="r"><div className="num">01</div><h3>Harness</h3><p>模型决定想做什么，Harness 决定能做什么、做过什么。</p></div>
    <div className="r"><div className="num" style={{ color: "var(--cyan)" }}>02</div><h3>Context</h3><p>窗口大小不等于有效上下文。信息密集，分治，不让无关信息进同一个 session。</p></div>
    <div className="r"><div className="num" style={{ color: "var(--violet)" }}>03</div><h3>方法论</h3><p>Skill 会被训练进模型；一个名词就能激活整套原理。</p></div>
    <div className="r"><div className="num" style={{ color: "var(--blue)" }}>04</div><h3>长活 &amp; 多 Agent</h3><p>长活 Agent 富集上下文；Swarm、Graph、Team 各解决一种协调问题。</p></div>
    <div className="r"><div className="num" style={{ color: "var(--pink)" }}>05</div><h3>人是编排者</h3><p>人蒸馏方法论给 Agent，也是最贵的对齐数据；保留目标、契约、取舍、验收。</p></div>
    <div className="r"><div className="num" style={{ color: "var(--amber)" }}>06</div><h3>自己的 Harness</h3><p>管住上下文，把 Workflow 沉淀成 CLI / MCP / 脚本，用 AX 的标准去设计。</p></div>
  </div>
  <div className="foot"><strong>Apache Maka (incubating)</strong> · github.com/apache/maka &nbsp;&nbsp;·&nbsp;&nbsp; <strong>OpenCLI</strong> · github.com/jackwener/opencli</div>

    </>
  );
}

import type { ReactElement } from "react";

export interface SlideMeta {
  title: string;
  cls: string;
  frags: number;
  Comp: () => ReactElement;
}

export const SLIDES: SlideMeta[] = [
  { title: "如何 Harness 我的大模型", cls: "cover", frags: 0, Comp: S01 },
  { title: "今天讲六件事", cls: "", frags: 0, Comp: S02 },
  { title: "Harness：管理和增强 Agent 的工程化运行时框架", cls: "", frags: 0, Comp: S03 },
  { title: "Harness 让「只会聊天」的模型多出四种能力", cls: "", frags: 0, Comp: S04 },
  { title: "Harness 的上下文是怎么组织的", cls: "", frags: 7, Comp: S05 },
  { title: "System Prompt：注意力最高的一层，用 AGENTS.md 定制", cls: "", frags: 0, Comp: S06 },
  { title: "窗口大小 ≠ 真实有效的上下文", cls: "", frags: 0, Comp: S07 },
  { title: "怎么避免上下文腐化：信息密集 + 分治", cls: "", frags: 0, Comp: S08 },
  { title: "", cls: "quote", frags: 0, Comp: S09 },
  { title: "一个名词，激活一整套原理", cls: "", frags: 0, Comp: S10 },
  { title: "为什么要有长程 Agent：它会富集上下文", cls: "", frags: 0, Comp: S11 },
  { title: "例子：Apache Maka 的 Review Agent 就是一个长活 Age", cls: "", frags: 0, Comp: S12 },
  { title: "Swarm、Graph、Agent Team：面向不同的场景", cls: "", frags: 0, Comp: S13 },
  { title: "例子：Maka Agent Graph，三权分立推进一张动态 DAG", cls: "", frags: 0, Comp: S14 },
  { title: "Agent Team 最难：组织架构本身就难", cls: "", frags: 0, Comp: S15 },
  { title: "人是 Agent 最好的编排者", cls: "", frags: 0, Comp: S16 },
  { title: "放手执行，不放任方向", cls: "", frags: 0, Comp: S17 },
  { title: "蒸馏是双向的，记忆分三层", cls: "", frags: 0, Comp: S18 },
  { title: "例子：raft.build 与 Grok Bot，群聊里的长活同事", cls: "", frags: 0, Comp: S19 },
  { title: "实战：Apache Maka 的 Review Agent 团队，就跑在 raf", cls: "", frags: 0, Comp: S20 },
  { title: "如何定义自己的 Harness：两件事", cls: "", frags: 0, Comp: S21 },
  { title: "CLI、MCP、沉淀成脚本的 Workflow，它们的设计与描述我称之为 AX", cls: "", frags: 0, Comp: S22 },
  { title: "回到开头的问题：怎么 Harness 我的大模型", cls: "", frags: 0, Comp: S23 },
];
