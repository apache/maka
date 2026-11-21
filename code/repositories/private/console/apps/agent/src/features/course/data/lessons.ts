// 16 节课的目录元数据（自源站 bundle 原样抽取）
export interface Lesson {
  id: string;
  group: string;
  icon: string;
  title: string;
  titleLines?: string[];
  kicker: string;
  summary: string;
  question: string;
  takeaways: string[];
  visual?: string;
}

export const LESSONS: Lesson[] = [
  {
    "id": "training-data",
    "group": "基础原理",
    "icon": "01",
    "title": "AI 的“食物”：训练数据",
    "kicker": "基础原理",
    "summary": "模型不是凭空长出知识，而是在大量文本、代码、图片与反馈中，学习语言与世界的统计规律。",
    "question": "如果训练材料有偏差，模型会学到什么？",
    "takeaways": [
      "数据决定能力边界，也带来偏见边界",
      "高质量、覆盖广、合规的数据更重要",
      "模型并不会“背诵整本互联网”"
    ],
    "visual": "data"
  },
  {
    "id": "train-infer",
    "group": "基础原理",
    "icon": "02",
    "title": "训练 vs 推理：两个完全不同的过程",
    "titleLines": [
      "训练 vs 推理：",
      "两个完全不同的过程"
    ],
    "kicker": "基础原理",
    "summary": "很多人以为 AI 每次回答都在“学习”——实际上完全不是这么回事。",
    "question": "为什么一次聊天不会直接改变模型本身？",
    "takeaways": [
      "训练：反复计算误差并更新权重",
      "推理：读取权重、生成结果",
      "把两者分开，才能理解成本与速度"
    ],
    "visual": "traininfer"
  },
  {
    "id": "moe",
    "group": "基础原理",
    "icon": "03",
    "title": "MoE：让模型按需激活专家",
    "kicker": "基础原理",
    "summary": "Mixture of Experts（MoE）把容量拆到多个专家网络中：每个 Token 只由 Router 选出的少数专家处理，因此总参数可以很大，单次计算不必等比例变贵。",
    "question": "总参数变大时，为什么每个 Token 不必调用全部参数？",
    "takeaways": [
      "Router 根据当前 Token 选择 Top-K 专家",
      "总参数、激活参数和实际计算量是三件不同的事",
      "负载均衡决定专家能否真正学出不同模式",
      "MoE 增加容量，不替代数据、训练或事实验证"
    ],
    "visual": "moe"
  },
  {
    "id": "vocabulary",
    "group": "基础原理",
    "icon": "04",
    "title": "词表与训练",
    "kicker": "基础原理",
    "summary": "模型看到的不是“字”或“词”，而是 Token。词表决定它如何切分世界，训练决定它如何连接这些 Token。",
    "question": "同一句话切成不同 Token，会影响什么？",
    "takeaways": [
      "Token 是模型处理语言的最小单位",
      "中文、英文、代码的切分方式不同",
      "Token 数量直接占用上下文窗口"
    ],
    "visual": "tokens"
  },
  {
    "id": "cot",
    "group": "基础原理",
    "icon": "05",
    "title": "CoT：让模型写出中间步骤",
    "titleLines": [
      "CoT：让模型",
      "写出中间步骤"
    ],
    "kicker": "基础原理",
    "summary": "Chain of Thought（CoT）不是让模型多想一层“秘密”，而是用可见的中间 Token 把复杂问题拆成可检查、可纠正的推理轨迹。",
    "question": "为什么多写几个中间步骤，可能让复杂任务更可靠？",
    "takeaways": [
      "中间 Token 会成为后续 Token 的新条件",
      "CoT 适合多步计算、约束规划与结构化推导",
      "高风险场景要验证中间结果，不能把“写得像推理”当作正确证据"
    ],
    "visual": "cot"
  },
  {
    "id": "chat-template",
    "group": "从补全到对话",
    "icon": "06",
    "title": "Chat Template + SFT",
    "kicker": "从补全到对话",
    "summary": "Base 模型只会续写文本。Chat Template 把角色与轮次编码成结构，SFT 则让模型学会按这个结构回应。",
    "question": "“你是助手”为什么不是一句普通的开场白？",
    "takeaways": [
      "Chat Template 是模型实际读到的对话格式",
      "SFT 用示例对齐有帮助、守规则的回答",
      "角色、轮次、工具消息都是上下文的一部分"
    ],
    "visual": "dialogue"
  },
  {
    "id": "context-window",
    "group": "从补全到对话",
    "icon": "07",
    "title": "上下文窗口是关键",
    "kicker": "从补全到对话",
    "summary": "模型每次只能看见有限长度的 Token 序列。它的短期记忆、当前任务、工具结果都挤在同一个窗口里。",
    "question": "对话越长，为什么回答未必越好？",
    "takeaways": [
      "窗口装的是当前可见信息，不是永久记忆",
      "输入与输出共享容量",
      "上下文质量常比“多塞材料”更重要"
    ],
    "visual": "context"
  },
  {
    "id": "completion-to-chat",
    "group": "从补全到对话",
    "icon": "08",
    "title": "Base 模型：Token 推 Token 机器",
    "titleLines": [
      "Base 模型：Token",
      "推 Token 机器"
    ],
    "kicker": "基础原理",
    "summary": "训练结束后得到的 Base 模型只做一件事：根据前面所有 Token，预测下一个最可能出现的 Token。",
    "question": "模型是在“理解答案”，还是在重复预测下一个 Token？",
    "takeaways": [
      "前文 Token → 概率分布 → 采样 → 新 Token → 循环",
      "Base 模型不会天然以助理身份回答问题",
      "简单的 Token 循环是一切大模型能力的底层引擎"
    ],
    "visual": "dialogue"
  },
  {
    "id": "hallucination",
    "group": "幻觉与应对",
    "icon": "09",
    "title": "大模型幻觉（Hallucination）",
    "titleLines": [
      "大模型幻觉",
      "（Hallucination）"
    ],
    "kicker": "幻觉与应对",
    "summary": "模型优化的是“合理地续写”，不天然等于“事实为真”。它会在证据不足时生成看似自信的内容。",
    "question": "一句话听起来很像真的，为什么仍然不可信？",
    "takeaways": [
      "幻觉是生成机制的风险，不只是模型“笨”",
      "缺信息、任务模糊、长链推理都会放大风险",
      "重要结论需要来源、工具或人工复核"
    ],
    "visual": "hallucination"
  },
  {
    "id": "prompt-engineering",
    "group": "幻觉与应对",
    "icon": "10",
    "title": "Prompt 工程",
    "kicker": "幻觉与应对",
    "summary": "Prompt 工程不是咒语，而是把任务、边界、材料与输出格式变成模型能执行的清晰规格。",
    "question": "怎样让模型在“不知道”时停下来？",
    "takeaways": [
      "给足任务背景与成功标准",
      "明确格式、约束与不可编造的规则",
      "把可验证步骤交给工具或拆成子任务"
    ],
    "visual": "prompt"
  },
  {
    "id": "agent",
    "group": "Agent 工程",
    "icon": "11",
    "title": "Agent：能干活的 AI",
    "kicker": "Agent 工程",
    "summary": "Agent 是把模型、上下文、工具和循环组合起来的运行系统：不止回答，还能观察结果并继续推进。",
    "question": "聊天机器人和 Agent 的差别在哪里？",
    "takeaways": [
      "Agent 有目标、状态和行动能力",
      "模型负责判断，环境负责给反馈",
      "可靠性来自系统设计，不只来自更大模型"
    ],
    "visual": "react"
  },
  {
    "id": "tool-calling",
    "group": "Agent 工程",
    "icon": "12",
    "title": "工具调用的秘密",
    "kicker": "Agent 工程",
    "summary": "Tool calling 不是模型真的“执行代码”，而是模型按 schema 生成结构化请求；宿主程序执行后再把结果放回上下文。",
    "question": "工具执行权究竟在模型手里吗？",
    "takeaways": [
      "模型输出意图与参数",
      "应用负责校验、授权和实际执行",
      "工具结果成为下一轮推理的证据"
    ],
    "visual": "tools"
  },
  {
    "id": "short-memory",
    "group": "Agent 工程",
    "icon": "13",
    "title": "短期记忆 = 上下文窗口",
    "kicker": "Agent 工程",
    "summary": "Agent 的短期记忆不是一个神秘数据库，而是每轮请求重新组织后放进上下文窗口的有效信息。",
    "question": "为什么 Agent 会“忘记”刚才做过的事？",
    "takeaways": [
      "窗口有限，历史会被截断或压缩",
      "只保留下一步真正需要的信息",
      "长期记忆是额外系统，不等于聊天记录"
    ],
    "visual": "context"
  },
  {
    "id": "compression",
    "group": "Agent 工程",
    "icon": "14",
    "title": "上下文压缩：四层防线",
    "kicker": "Agent 工程",
    "summary": "先少放、再筛选、后压缩、必要时外置检索：把上下文当作稀缺预算，持续保留决定下一步的信息。",
    "question": "压缩的目标是省 Token，还是保留决策能力？",
    "takeaways": [
      "第一层：源头减量",
      "第二层：相关性筛选",
      "第三层：摘要与状态折叠",
      "第四层：检索式按需取回"
    ],
    "visual": "context"
  },
  {
    "id": "react-loop",
    "group": "Agent 工程",
    "icon": "15",
    "title": "ReAct 循环：思考 → 行动 → 观察",
    "titleLines": [
      "ReAct 循环：",
      "思考 → 行动 → 观察"
    ],
    "kicker": "Agent 工程",
    "summary": "ReAct 把推理与行动交替：先决定下一步，再调用工具，最后根据观察结果更新计划。",
    "question": "为什么一次“完美计划”不如一个能纠错的循环？",
    "takeaways": [
      "Thought：判断当前缺什么",
      "Action：执行一个可验证操作",
      "Observation：把环境反馈带回模型",
      "循环直到满足停止条件"
    ],
    "visual": "react"
  },
  {
    "id": "skills",
    "group": "Agent 工程",
    "icon": "16",
    "title": "Skill 的本质",
    "kicker": "Agent 工程",
    "summary": "Skill 是可复用的工作说明书：告诉 Agent 何时使用什么工具、按什么步骤做、怎样判断完成。",
    "question": "为什么一个 Skill 能让同一模型突然更稳定？",
    "takeaways": [
      "把隐性的经验外化为可调用流程",
      "减少每次从零规划的成本",
      "边界、验证与失败处理同样是 Skill 的一部分"
    ],
    "visual": "skills"
  }
];

export type LessonGroup = { group: string; lessons: Lesson[] };

export const GROUPS: LessonGroup[] = Array.from(new Set(LESSONS.map((l) => l.group))).map(
  (group) => ({ group, lessons: LESSONS.filter((l) => l.group === group) })
);
