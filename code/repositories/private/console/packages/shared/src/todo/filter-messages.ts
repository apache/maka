export function filterChatItems<T extends { text: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => item.text.toLowerCase().includes(q))
}

export function lastUserText(items: Array<{ role: string; text: string }>): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === 'user' && items[i].text) return items[i].text
  }
  return null
}
