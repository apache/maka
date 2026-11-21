/**
 * chat SSE 流水线（自 Fastify 路由迁入 Next route handler）。
 * 原逻辑保真：七步流水线、写前确认、断线 flush（Q22）、MAX_TOOL_ROUNDS 轮数上限。
 * 差异仅在传输层：reply.hijack() → ReadableStream Response。
 */

import OpenAI from "openai";
import {
  ChatRequestSchema,
  ConfirmRequestSchema,
  ApiError,
  encodeSseEvent,
  type ApprovalStatus,
  type SseEvent,
  type ToolAction,
} from "@ggbdpq/console-shared/todo";
import {
  createConversation,
  getConversation,
  insertMessage,
  recentMessages,
  touchConversation,
} from "./db/repo-conversations";
import type { ChatMessage, LlmClient, ToolCall } from "./agent/llm";
import { buildSystemPrompt } from "./agent/prompt";
import { executeTool, summarizeToolResult, toolNeedsApproval } from "./agent/tools";
import type { ApprovalRegistry } from "./agent/approvals";
import { parseBody } from "./http";
import type { TodoDeps } from "./connection";

/** 单次对话内工具循环轮数上限：超过后不再提供 tools，模型自然文本收尾 */
const MAX_TOOL_ROUNDS = 5;

/** messages 表 → 模型消息数组（铁律①：模型所见必可从日志重建） */
function toChatMessages(rows: ReturnType<typeof recentMessages>): ChatMessage[] {
  return rows
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "assistant") {
        const toolCalls = m.rawJson && "toolCalls" in m.rawJson ? m.rawJson.toolCalls : undefined;
        return toolCalls?.length
          ? {
              role: "assistant" as const,
              content: m.content,
              toolCalls: toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                args: tc.args,
              })),
            }
          : { role: "assistant" as const, content: m.content };
      }
      if (m.role === "tool" && m.rawJson && "toolCallId" in m.rawJson) {
        return {
          role: "tool" as const,
          toolCallId: (m.rawJson as { toolCallId: string }).toolCallId,
          content: m.content,
        };
      }
      return { role: "user" as const, content: m.content };
    });
}

function truncateTitle(message: string): string {
  const t = message.trim().replace(/\s+/g, " ");
  return t.length > 20 ? `${t.slice(0, 20)}…` : t;
}

/** SSE 响应头 */
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * POST /api/chat 主体：返回 SSE Response。
 * 语义与 Fastify 版一致：校验失败(400)/会话不存在(404)在流建立前抛 ApiError，
 * 由调用方转 JSON 封套；流建立后的错误走 error 事件。
 */
export function handleChatStream(deps: TodoDeps, body: unknown, signal?: AbortSignal): Response {
  const input = parseBody(ChatRequestSchema, body);
  const { db } = deps;

  // —— 流水线第 1-2 步：会话定位与用户消息落库（流外，保持 JSON 错误语义）——
  let conversationId = input.conversationId;
  if (conversationId != null) {
    if (!getConversation(db, conversationId)) {
      throw new ApiError(404, "NOT_FOUND", `会话 ${conversationId} 不存在`);
    }
  } else {
    const conv = createConversation(db, truncateTitle(input.message));
    conversationId = conv.id;
  }
  const userMessage = insertMessage(db, {
    conversationId,
    role: "user",
    content: input.message,
  });
  touchConversation(db, conversationId);

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: SseEvent) => {
        if (!closed) controller.enqueue(encoder.encode(encodeSseEvent(event)));
      };
      try {
        await runChatSse(deps, { conversationId, userMessageId: userMessage.id }, send, () => {
          closed = true;
          try {
            controller.close();
          } catch {
            // 已关闭
          }
        }, abortController.signal);
      } catch (err) {
        // runChatSse 已把可预期错误写成 error 事件；这里兜底流中断
        if (!abortController.signal.aborted) {
          send({
            type: "error",
            code: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : "未知错误",
          });
        }
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // 已关闭
          }
        }
      }
    },
    cancel() {
      // 消费方断开：触发与请求 abort 相同的清理路径
      abortController.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

async function runChatSse(
  deps: TodoDeps,
  ctx: { conversationId: number; userMessageId: number },
  send: (event: SseEvent) => void,
  closeStream: () => void,
  externalSignal?: AbortSignal,
): Promise<void> {
  const { db, llm, approvals } = deps;
  const conversationId = ctx.conversationId;
  const userMessage = { id: ctx.userMessageId };

  let aborted = false;
  const controller = new AbortController();
  const onAbort = () => {
    // Q22 定案：断线中止上游生成；已生成内容由下方 flush 落库
    aborted = true;
    controller.abort();
    approvals.cancelAll(userMessage.id);
  };
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  send({
    type: "meta",
    conversationId,
    userMessageId: userMessage.id,
    model: llm.model,
  });

  // —— 流水线第 3-4 步：查业务数据（system prompt 注入）+ 组装模型输入 ——
  const systemPrompt = buildSystemPrompt(db, llm.model);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...toChatMessages(recentMessages(db, conversationId, 40)),
  ];

  /** 当前轮已累积但尚未落库的内容（断线时 flush，Q22 定案） */
  type UsageShape = { prompt: number | null; completion: number | null };
  const currentRound: { text: string; usage: UsageShape | null; finishReason: string | null } = {
    text: "",
    usage: null,
    finishReason: null,
  };

  try {
    let round = 0;

    for (;;) {
      const withTools = round < MAX_TOOL_ROUNDS;
      // —— 流水线第 5 步：调大模型（流式）——
      let text = "";
      const toolAcc = new Map<number, { id: string; name: string; argsStr: string }>();
      let usage: { prompt: number | null; completion: number | null } | null = null;
      let finishReason: string | null = null;

      for await (const chunk of llm.streamChat({ messages, withTools, signal: controller.signal })) {
        if (chunk.text) {
          text += chunk.text;
          currentRound.text = text;
          // —— 流水线第 6 步：流式转发（Q14 delta 事件）——
          send({ type: "delta", text: chunk.text });
        }
        for (const tc of chunk.toolCalls ?? []) {
          const acc = toolAcc.get(tc.index) ?? { id: "", name: "", argsStr: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.name) acc.name = tc.name;
          if (tc.argsDelta) acc.argsStr += tc.argsDelta;
          toolAcc.set(tc.index, acc);
        }
        if (chunk.usage) {
          usage = chunk.usage;
          currentRound.usage = usage;
        }
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
          currentRound.finishReason = finishReason;
        }
        if (aborted) break;
      }
      if (aborted) break;

      // 轮尾：assistant 消息落库（含事件溯源载荷）
      const toolCalls: ToolCall[] = [];
      for (const [, acc] of toolAcc) {
        let args: Record<string, unknown>;
        try {
          args = acc.argsStr ? (JSON.parse(acc.argsStr) as Record<string, unknown>) : {};
        } catch {
          args = { __invalidArgs: acc.argsStr };
        }
        if (acc.name) toolCalls.push({ id: acc.id, name: acc.name, args });
      }

      const assistantMessage = insertMessage(db, {
        conversationId,
        role: "assistant",
        content: text,
        rawJson: { model: llm.model, usage, finishReason, toolCalls: toolCalls.length ? toolCalls : undefined },
      });

      if (toolCalls.length === 0) {
        // —— 纯文本收尾：done ——
        send({ type: "done", messageId: assistantMessage.id, usage });
        break;
      }

      // —— 工具回路：写操作过确认门禁（铁律③）——
      messages.push({
        role: "assistant",
        content: text,
        toolCalls,
      });

      for (const tc of toolCalls) {
        let outcome: { approved: boolean; status: ApprovalStatus };
        if (toolNeedsApproval(tc.name)) {
          send({
            type: "tool_confirm",
            messageId: assistantMessage.id,
            toolCallId: tc.id,
            action: tc.name as ToolAction,
            args: tc.args,
          });
          outcome = await approvals.wait(assistantMessage.id, tc.id);
        } else {
          outcome = { approved: true, status: "confirmed" };
        }

        let result: unknown;
        if (outcome.approved) {
          try {
            result = executeTool(db, tc.name, tc.args);
          } catch (err) {
            // Zod 校验失败等：参数不合法作为 tool 结果回给模型，不外抛
            result = { error: err instanceof Error ? err.message : "工具参数不合法" };
          }
        } else {
          result = { skipped: true, reason: outcome.status };
        }

        const summary = outcome.approved
          ? summarizeToolResult(tc.name, result)
          : outcome.status === "timeout"
            ? "等待确认超时，操作未执行"
            : "用户拒绝了该操作";

        insertMessage(db, {
          conversationId,
          role: "tool",
          content: summary,
          rawJson: {
            toolCallId: tc.id,
            approved: outcome.approved,
            status: outcome.status,
            action: tc.name,
            result,
          },
        });
        send({
          type: "tool_result",
          toolCallId: tc.id,
          approved: outcome.approved,
          status: outcome.status,
          summary,
        });
        messages.push({ role: "tool", toolCallId: tc.id, content: JSON.stringify(result) });
      }

      round++;
      // 超过轮数上限后不再提供 tools，模型自然文本收尾（见 withTools）
    }
  } catch (err) {
    if (!aborted) {
      const isLlmError = err instanceof OpenAI.APIError;
      send({
        type: "error",
        code: isLlmError ? "LLM_ERROR" : "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "未知错误",
      });
    }
  } finally {
    // 断线：未落库的部分内容补写（Q22 定案；放 finally 让抛错/break 两条路径都覆盖）
    if (aborted && currentRound.text.trim()) {
      insertMessage(db, {
        conversationId,
        role: "assistant",
        content: currentRound.text,
        rawJson: {
          model: llm.model,
          usage: currentRound.usage,
          finishReason: "aborted",
          toolCalls: undefined,
        },
      });
    }
    touchConversation(db, conversationId);
    if (!aborted) closeStream();
  }
}

/** POST /api/chat/[messageId]/confirm 主体：resolve 写确认。 */
export function handleConfirm(deps: TodoDeps, messageId: number, body: unknown): Response {
  const { approvals } = deps;
  try {
    const parsed = parseBody(ConfirmRequestSchema, body);
    const ok = approvals.resolve(messageId, parsed.toolCallId, parsed.approved);
    if (!ok) {
      throw new ApiError(
        404,
        "CONFIRM_MISMATCH",
        `没有等待确认的操作（消息 ${messageId} / ${parsed.toolCallId}），可能已超时`,
      );
    }
    return Response.json({ accepted: true });
  } catch (err) {
    if (err instanceof ApiError) {
      return Response.json({ code: err.code, message: err.message, details: err.details }, { status: err.statusCode });
    }
    throw err;
  }
}
