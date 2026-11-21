import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "@ig/router";
import { Send, Square } from "lucide-react";
import { Markdown } from "@ig/components/Markdown";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ig/components/ui/card";
import { Textarea } from "@ig/components/ui/textarea";
import { useContent } from "@ig/content/useContent";
import type { Scores } from "@ig/content/types";
import { localDateKey } from "@ig/lib/dates";
import { buildLookup } from "@ig/state/lookup";
import { useArena } from "@ig/state/store";
import { BackLink } from "@ig/features/practice/components/Runner";
import { ScoreBadgeGrid } from "@ig/features/interviewer/components/ScoreBadgeGrid";
import { chatCompletion } from "@ig/features/interviewer/lib/providers";
import type { ChatMessage } from "@ig/features/interviewer/lib/providers";
import {
  buildInterviewMessages,
  buildScoreRequest,
  parseScoreReply,
} from "@ig/features/interviewer/lib/prompts";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
}

type Status = "idle" | "streaming" | "awaiting" | "scored";

// 单题追问官：AI 扮演面试官连续追问 N 轮 → 结构化评分 → 落掌握度体系
export function InterviewSession() {
  const content = useContent();
  const { qid } = useParams() as { qid: string };
  const decoded = qid ? decodeURIComponent(qid) : "";
  const lookup = useMemo(() => buildLookup(content), [content]);
  const entry = lookup.get(decoded);
  const question = entry?.question;

  const providers = useArena((s) => s.providers);
  const defaultProviderId = useArena((s) => s.defaultProviderId);
  const rounds = useArena((s) => s.interviewRounds);
  const recordAttempt = useArena((s) => s.recordAttempt);
  const addInterviewRecord = useArena((s) => s.addInterviewRecord);

  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [askedCount, setAskedCount] = useState(0);
  const [score, setScore] = useState<{ scores: Scores; comment: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const provider = providers.find((p) => p.id === defaultProviderId) ?? providers[0];
  const busy = status === "streaming";

  if (!entry || !question) {
    return (
      <div className="space-y-3">
        <BackLink to="/interview" label="AI 面试官" />
        <p className="text-sm text-muted-foreground">找不到题目：{decoded}</p>
      </div>
    );
  }

  function scrollBottom() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }

  // 追加一条助手消息并流式填充；返回完整文本，中止/失败返回 undefined
  async function streamAssistant(next: ChatMessage[]): Promise<string | undefined> {
    if (!provider) {
      setError("还没有配置模型，先到设置页添加服务商并填 Key。");
      return undefined;
    }
    setStatus("streaming");
    setError("");
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const full = await chatCompletion(provider, next, {
        signal: controller.signal,
        onDelta: (delta) => {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last.role !== "assistant") return prev;
            copy[copy.length - 1] = { ...last, content: last.content + delta };
            return copy;
          });
          scrollBottom();
        },
      });
      setStatus("awaiting");
      return full;
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setStatus("awaiting");
        return undefined;
      }
      setError((e as Error).message || "请求失败");
      setMessages((prev) => (prev[prev.length - 1]?.content === "" ? prev.slice(0, -1) : prev));
      setStatus("awaiting");
      return undefined;
    } finally {
      abortRef.current = null;
    }
  }

  async function start() {
    const full = await streamAssistant(
      buildInterviewMessages(question!, entry!.sectionTitle, rounds),
    );
    if (full !== undefined) {
      setAskedCount(1);
      scrollBottom();
    }
  }

  // 保存 AI 评分：进 attempts（掌握度/统计/导出全打通），同时留一条会话摘要
  function saveScore(parsed: {
    factual: 0 | 1 | 2;
    mechanism: 0 | 1 | 2;
    failure: 0 | 1 | 2;
    expression: 0 | 1 | 2;
    comment: string;
  }) {
    const scores: Scores = {
      factual: parsed.factual,
      mechanism: parsed.mechanism,
      failure: parsed.failure,
      expression: parsed.expression,
    };
    setScore({ scores, comment: parsed.comment });
    recordAttempt({
      qid: decoded,
      date: localDateKey(),
      ts: Date.now(),
      kind: "ai",
      scores,
      note: `AI 面试官：${parsed.comment}`,
    });
    addInterviewRecord({
      id: crypto.randomUUID(),
      qid: decoded,
      ts: Date.now(),
      rounds: askedCount,
      providerLabel: provider ? `${provider.label} / ${provider.model}` : "",
      comment: parsed.comment,
    });
    setStatus("scored");
  }

  async function sendAnswer() {
    const text = input.trim();
    if (!text || busy) return;
    const history: ChatMessage[] = [
      ...buildInterviewMessages(question!, entry!.sectionTitle, rounds),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ];
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");

    const willScore = askedCount >= rounds;
    const full = await streamAssistant(willScore ? [...history, buildScoreRequest()] : history);
    if (full === undefined) return;

    if (willScore) {
      const parsed = parseScoreReply(full);
      if (parsed) saveScore(parsed);
      else setError("评分 JSON 解析失败，可点「重新评分」重试。");
    } else {
      setAskedCount((n) => n + 1);
      scrollBottom();
    }
  }

  // 提前结束 / 重试评分：拿当前完整记录再要一次评分
  async function rescore() {
    if (messages.length < 2) return;
    const full = await streamAssistant([
      ...buildInterviewMessages(question!, entry!.sectionTitle, rounds),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      buildScoreRequest(),
    ]);
    if (full === undefined) return;
    const parsed = parseScoreReply(full);
    if (parsed) saveScore(parsed);
    else setError("评分 JSON 仍解析失败；该模型可能不擅长稳定 JSON 输出，建议换模型。");
  }

  const finished = status === "scored";

  return (
    <div className="space-y-4">
      <BackLink to="/interview" label="AI 面试官" />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {entry.title}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {entry.sectionTitle} · 共 {rounds} 轮追问
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            {question.points || question.bodyMd}
          </div>

          {messages.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={start} disabled={busy || !provider}>
                开始面试
              </Button>
              {!provider && (
                <span className="text-sm text-muted-foreground">请先到设置页配置模型。</span>
              )}
            </div>
          ) : (
            <div ref={scrollRef} className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "border bg-background"
                    }`}
                  >
                    {m.role === "assistant" ? <Markdown>{m.content || "…"}</Markdown> : m.content}
                  </div>
                </div>
              ))}
            </div>
          )}

          {score && (
            <Card className="border-primary/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">AI 评分（已计入掌握度与统计）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <ScoreBadgeGrid scores={score.scores} />
                <p className="text-sm text-muted-foreground">{score.comment}</p>
                <Button asChild variant="outline" size="sm">
                  <Link to={`/q/${encodeURIComponent(decoded)}`}>查看题目详情</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {error && (
            <div className="space-y-2">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              {messages.length >= 2 && !finished && (
                <Button variant="outline" size="sm" onClick={rescore} disabled={busy}>
                  重新评分
                </Button>
              )}
            </div>
          )}

          {messages.length > 0 && !finished && (
            <div className="space-y-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sendAnswer();
                  }
                }}
                placeholder="回答面试官的追问……（Ctrl+Enter 发送）"
                rows={3}
                disabled={busy}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={sendAnswer} disabled={busy || !input.trim()}>
                  <Send className="size-4" /> 发送（第 {Math.min(askedCount, rounds)}/{rounds} 轮）
                </Button>
                {busy ? (
                  <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                    <Square className="size-4" /> 停止
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={rescore}
                    disabled={messages.length < 3}
                  >
                    提前结束并评分
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
