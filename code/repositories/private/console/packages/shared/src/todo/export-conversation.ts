export interface ExportableMessage {
  role: string
  text: string
}

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
}

export function exportConversationText(items: ExportableMessage[]): string {
  return items
    .map((item) => `${ROLE_LABEL[item.role] ?? item.role}：${item.text}`)
    .join('\n\n')
}

export function exportConversationJson(items: ExportableMessage[], conversationId: number | null): string {
  return JSON.stringify({ conversationId, messages: items }, null, 2)
}
