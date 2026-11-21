export const TIER_STORAGE_KEY = "tierListState"
export const PAGE_SIZE = 10

export type ZoneKey = "S" | "A" | "B" | "C" | "D" | "pool"

export type AnimeItem = {
  id: string
  src: string
  alt: string
}

export type TierContainers = Record<ZoneKey, AnimeItem[]>

export type TierSnapshot = {
  timestamp: number
  containers: TierContainers
}

export const ZONE_KEYS: ZoneKey[] = ["S", "A", "B", "C", "D", "pool"]

export const TIER_COLORS: Record<Exclude<ZoneKey, "pool">, string> = {
  S: "#ff7f7f",
  A: "#ffbf7f",
  B: "#ffdf7f",
  C: "#ffff7f",
  D: "#bfff7f",
}

/** 把旧站绝对路径、image/ 相对路径归一成站点内 /anime/NN.jpg */
export function normalizeAnimeSrc(src: string): string {
  let value = src.trim()
  try {
    value = decodeURI(value)
  } catch {
    // 保持原串
  }

  const fileMatch = value.match(/(\d{2})\.jpe?g(?:\?.*)?$/i)
  if (!fileMatch) return src

  const n = Number(fileMatch[1])
  if (n < 1 || n > 11) return src
  return `/anime/${fileMatch[1]}.jpg`
}

export function createDefaultContainers(): TierContainers {
  const pool: AnimeItem[] = Array.from({ length: 11 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0")
    return {
      id: `anime-${n}`,
      src: `/anime/${n}.jpg`,
      alt: `动漫${i + 1}`,
    }
  })
  return { S: [], A: [], B: [], C: [], D: [], pool }
}

function asItemList(raw: unknown, zone: ZoneKey): AnimeItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return []
    const record = item as { src?: unknown; alt?: unknown }
    const src = normalizeAnimeSrc(String(record.src ?? ""))
    if (!src) return []
    return [
      {
        id: `${zone}-${index}-${src}`,
        src,
        alt: String(record.alt ?? "新图片"),
      },
    ]
  })
}

export function parseStoredState(raw: string): TierSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as {
      timestamp?: unknown
      containers?: Partial<Record<ZoneKey, unknown>>
    }
    if (!parsed || typeof parsed !== "object" || !parsed.containers) return null

    const containers = {} as TierContainers
    for (const key of ZONE_KEYS) {
      containers[key] = asItemList(parsed.containers[key], key)
    }
    return {
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
      containers,
    }
  } catch {
    return null
  }
}

export function toPersistable(containers: TierContainers): TierSnapshot {
  return {
    timestamp: Date.now(),
    containers: {
      S: containers.S.map(({ src, alt }) => ({ id: src, src, alt })),
      A: containers.A.map(({ src, alt }) => ({ id: src, src, alt })),
      B: containers.B.map(({ src, alt }) => ({ id: src, src, alt })),
      C: containers.C.map(({ src, alt }) => ({ id: src, src, alt })),
      D: containers.D.map(({ src, alt }) => ({ id: src, src, alt })),
      pool: containers.pool.map(({ src, alt }) => ({ id: src, src, alt })),
    },
  }
}

export function cloneContainers(containers: TierContainers): TierContainers {
  return {
    S: [...containers.S],
    A: [...containers.A],
    B: [...containers.B],
    C: [...containers.C],
    D: [...containers.D],
    pool: [...containers.pool],
  }
}

export function findItemZone(containers: TierContainers, itemId: string): ZoneKey | null {
  for (const key of ZONE_KEYS) {
    if (containers[key].some((item) => item.id === itemId)) return key
  }
  return null
}

export function moveItem(
  containers: TierContainers,
  itemId: string,
  toZone: ZoneKey,
  beforeId?: string | null,
): TierContainers | null {
  const fromZone = findItemZone(containers, itemId)
  if (!fromZone) return null

  const item = containers[fromZone].find((entry) => entry.id === itemId)
  if (!item) return null

  const next = cloneContainers(containers)
  next[fromZone] = next[fromZone].filter((entry) => entry.id !== itemId)

  const target = next[toZone].filter((entry) => entry.id !== itemId)
  const insertAt = beforeId ? target.findIndex((entry) => entry.id === beforeId) : -1
  if (insertAt >= 0) {
    target.splice(insertAt, 0, item)
  } else {
    target.push(item)
  }
  next[toZone] = target
  return next
}
