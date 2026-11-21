import {
  AgentVisual,
  CompressionVisual,
  ContextWindowVisual,
  CotVisual,
  CompletionToChatLab,
  DataVisual,
  DialogueLab,
  HallucinationVisual,
  MoeVisual,
  PromptVisual,
  ReActLoopVisual,
  ShortMemoryVisual,
  SkillsVisual,
  TokensVisual,
  ToolsVisual,
  TrainInferVisual,
} from "./visuals";

/**
 * 课节 → 可视化组件的注册表。
 * kind 是课节元数据里的 visual 字段；同一 kind 下再按课节 id 细分变体。
 */
export function VisualRegistry({ kind, lessonId }: { kind?: string; lessonId: string }) {
  switch (kind) {
    case "data":
      return <DataVisual />;
    case "traininfer":
      return <TrainInferVisual />;
    case "moe":
      return <MoeVisual />;
    case "tokens":
      return <TokensVisual />;
    case "cot":
      return <CotVisual />;
    case "dialogue":
      return lessonId === "completion-to-chat" ? <CompletionToChatLab /> : <DialogueLab lessonId={lessonId} />;
    case "context":
      if (lessonId === "short-memory") return <ShortMemoryVisual />;
      if (lessonId === "compression") return <CompressionVisual />;
      return <ContextWindowVisual />;
    case "hallucination":
      return <HallucinationVisual />;
    case "prompt":
      return <PromptVisual />;
    case "tools":
      return <ToolsVisual />;
    case "react":
      return lessonId === "agent" ? <AgentVisual /> : <ReActLoopVisual />;
    default:
      return <SkillsVisual />;
  }
}
