import { describe, expect, it } from "vitest";
import type { Question } from "@ig/content/types";
import { buildInterviewMessages, parseScoreReply } from "./prompts";

const question: Question = {
  id: "P0-必背/闭包",
  sectionId: "P0-必背",
  title: "闭包",
  tags: ["JS基础"],
  points: "词法环境。",
  acceptance: "举反例。",
  bodyMd: "",
};

describe("buildInterviewMessages", () => {
  it("系统提示包含题目材料与轮数", () => {
    const messages = buildInterviewMessages(question, "P0-必背", 3);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("3 轮");
    expect(messages[0].content).toContain("【题目】闭包");
    expect(messages[0].content).toContain("参考要点");
  });
});

describe("parseScoreReply", () => {
  it("解析纯 JSON", () => {
    const parsed = parseScoreReply(
      '{"factual":2,"mechanism":1,"failure":0,"expression":2,"comment":"ok"}',
    );
    expect(parsed).toEqual({ factual: 2, mechanism: 1, failure: 0, expression: 2, comment: "ok" });
  });

  it("解析包在代码块/闲话里的 JSON", () => {
    const text =
      '好的，以下是评分：\n```json\n{"factual":1,"mechanism":1,"failure":1,"expression":1,"comment":"一般"}\n```\n请注意查收。';
    expect(parseScoreReply(text)?.comment).toBe("一般");
  });

  it("字段越界或缺失返回 null", () => {
    expect(
      parseScoreReply('{"factual":5,"mechanism":1,"failure":1,"expression":1,"comment":"x"}'),
    ).toBeNull();
    expect(parseScoreReply("没有 JSON")).toBeNull();
  });
});
