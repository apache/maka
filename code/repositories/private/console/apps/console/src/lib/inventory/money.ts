export function formatYuan(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "-";
  return `${(cents / 100).toFixed(2)} 元`;
}
