export interface ChatKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
}

export interface ChatKeyContext {
  inputEmpty: boolean
  streaming: boolean
  waitingConfirm: boolean
}

export type ChatKeyAction = 'stop' | 'reject-confirm' | 'fill-last-user' | 'search'

export function interpretChatKey(event: ChatKeyEvent, ctx: ChatKeyContext): ChatKeyAction | null {
  if (event.key === 'Escape') {
    if (ctx.waitingConfirm) return 'reject-confirm'
    if (ctx.streaming) return 'stop'
    return null
  }
  if (event.key === 'ArrowUp' && ctx.inputEmpty) return 'fill-last-user'
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') return 'search'
  return null
}
