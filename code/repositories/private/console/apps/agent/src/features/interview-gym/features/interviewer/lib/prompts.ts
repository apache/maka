import { z } from "zod";
import type { Question } from "@ig/content/types";
import type { ChatMessage } from "./providers";

const FOUR_DIM_RULE = `四维评分口径（0 说不清 / 1 有概念缺证据 / 2 机制、边界与验证完整）：
- factual 事实准确：有无事实错误、张冠李戴或过度声明
- mechanism 技术机制：机制本身是否讲清、有无关键遗漏
- failure 失败路径：是否主动给出失败路径、反例或边界条件
- expression 表达结构：是否结构化、有取舍、有条理`;

// 追问链沿用《综合模拟面试》的面试官视角
export function buildInterviewMessages(
  question: Question,
  sectionTitle: string,
  rounds: number,
): ChatMessage[] {
  const material = [
    `【分区】${sectionTitle}`,
    `【题目】${question.title}`,
    question.tags.length ? `【标签】${question.tags.join("、")}` : "",
    question.points ? `【参考要点（仅面试官可见，不要直接透露）】${question.points}` : "",
    question.acceptance ? `【验收标准】${question.acceptance}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    "你是一位一线互联网公司的资深面试官，语气专业、克制、不客套。",
    "你将围绕给定题目对候选人进行口头面试式追问。规则：",
    `1. 每轮只提一个问题（可含一个简短引导句），优先从「你本人做哪一段」「为什么这样做」「失败如何表现」「有哪些替代方案」「怎样证明完成」中选取角度。`,
    `2. 结合候选人上一轮回答深挖，答对的细节就换角度，含糊的就钉住追问。`,
    `3. 共进行 ${rounds} 轮追问。第 ${rounds} 轮得到候选人回答后，不再提问，直接给出评分。`,
    "4. 评分时输出且只输出一个 JSON 对象，不要 markdown 代码块、不要多余文字：",
    '{"factual":0,"mechanism":0,"failure":0,"expression":0,"comment":"200字内的总评，指出最该补的一处证据或机制"}',
    FOUR_DIM_RULE,
    "",
    "【题目材料】",
    material,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "面试官你好，请开始提问。" },
  ];
}

export function buildScoreRequest(): ChatMessage {
  return {
    role: "user",
    content: "练习到此为止，请立即按系统提示输出评分 JSON，只输出 JSON 本身。",
  };
}

const scoreSchema = z.object({
  factual: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  mechanism: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  failure: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  expression: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  comment: z.string(),
});

export interface ParsedScore {
  factual: 0 | 1 | 2;
  mechanism: 0 | 1 | 2;
  failure: 0 | 1 | 2;
  expression: 0 | 1 | 2;
  comment: string;
}

// 模型可能把 JSON 包在代码块或前后闲话里：抽第一个平衡花括号块再校验
export function parseScoreReply(text: string): ParsedScore | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    const parsed = scoreSchema.safeParse(JSON.parse(text.slice(start, end)));
    return parsed.success ? (parsed.data as ParsedScore) : null;
  } catch {
    return null;
  }
}
