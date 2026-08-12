export function hookMatcherMatches(matcher: string, toolName: string): boolean {
  for (const token of matcher.split('|')) {
    if (token === '*') return true;
    if (token.endsWith('*')) {
      if (toolName.startsWith(token.slice(0, -1))) return true;
      continue;
    }
    if (token === toolName) return true;
  }
  return false;
}
