import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { LlmConnection } from '@maka/core/llm-connections';

export interface DesktopConnectionSnapshot {
  readonly connections: LlmConnection[];
  readonly defaultConnection: string | null;
  readonly chatModelChoices: ChatModelChoice[];
}
