import type { Db } from './database'
import type {
  AssistantPayload,
  Conversation,
  Message,
  MessageRole,
  ToolPayload,
} from '@ggbdpq/console-shared/todo'

export function createConversation(db: Db, title: string): Conversation {
  const now = new Date().toISOString()
  const result = db
    .prepare('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run(title, now, now)
  return getConversation(db, Number(result.lastInsertRowid))!
}

export function getConversation(db: Db, id: number): Conversation | null {
  const row = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
    .get(id) as unknown as
    | { id: number; title: string; created_at: string; updated_at: string }
    | undefined
  return row ? { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at } : null
}

export function listConversations(db: Db): Conversation[] {
  const rows = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC')
    .all() as unknown as Array<{ id: number; title: string; created_at: string; updated_at: string }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export function touchConversation(db: Db, id: number): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
}

/** 硬删除会话及其全部消息（事务保证原子）。先删 messages 再删父行：FK 已开且无 ON DELETE CASCADE */
export function deleteConversation(db: Db, id: number): boolean {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
    const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    if (result.changes === 0) {
      db.exec('ROLLBACK')
      return false
    }
    db.exec('COMMIT')
    return true
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export interface InsertMessage {
  conversationId: number
  role: MessageRole
  content: string
  rawJson?: AssistantPayload | ToolPayload | null
}

export function insertMessage(db: Db, msg: InsertMessage): Message {
  const result = db
    .prepare(
      'INSERT INTO messages (conversation_id, role, content, raw_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      msg.conversationId,
      msg.role,
      msg.content,
      msg.rawJson ? JSON.stringify(msg.rawJson) : null,
      new Date().toISOString(),
    )
  return getMessageById(db, Number(result.lastInsertRowid))!
}

interface MessageRow {
  id: number
  conversation_id: number
  role: string
  content: string
  raw_json: string | null
  created_at: string
}

function rowToMessage(row: MessageRow): Message {
  let rawJson: Message['rawJson'] = null
  if (row.raw_json) {
    try {
      rawJson = JSON.parse(row.raw_json) as Message['rawJson']
    } catch {
      rawJson = null
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    rawJson,
    createdAt: row.created_at,
  }
}

export function getMessageById(db: Db, id: number): Message | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(id) as unknown as MessageRow | undefined
  return row ? rowToMessage(row) : null
}

/** 倒序取最近 limit 条再正序返回——组 prompt 历史窗口用 */
export function recentMessages(db: Db, conversationId: number, limit: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit) as unknown as MessageRow[]
  return rows.reverse().map(rowToMessage)
}

export function listMessages(db: Db, conversationId: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(conversationId) as unknown as MessageRow[]
  return rows.map(rowToMessage)
}
