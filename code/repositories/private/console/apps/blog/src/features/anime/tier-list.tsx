"use client"

import { useCallback, useEffect, useMemo, useState, type DragEvent, type MouseEvent } from "react"
import {
  PAGE_SIZE,
  TIER_COLORS,
  TIER_STORAGE_KEY,
  type AnimeItem,
  type TierContainers,
  type ZoneKey,
  cloneContainers,
  createDefaultContainers,
  moveItem,
  parseStoredState,
  toPersistable,
} from "@/features/anime/storage"
import "./tier-list.css"

const TIERS = ["S", "A", "B", "C", "D"] as const
const MAX_HISTORY = 50

export function AnimeTierList() {
  const [containers, setContainers] = useState<TierContainers>(createDefaultContainers)
  const [history, setHistory] = useState<TierContainers[]>(() => [createDefaultContainers()])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [page, setPage] = useState(1)
  const [dragOver, setDragOver] = useState<ZoneKey | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; item: AnimeItem } | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
  }, [])

  useEffect(() => {
    if (!toast) return
    const hide = window.setTimeout(() => setToast(null), 2000)
    return () => window.clearTimeout(hide)
  }, [toast])

  const commit = useCallback((next: TierContainers, message?: string) => {
    setContainers(next)
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1)
      trimmed.push(cloneContainers(next))
      if (trimmed.length > MAX_HISTORY) trimmed.shift()
      setHistoryIndex(trimmed.length - 1)
      return trimmed
    })
    if (message) showToast(message)
  }, [historyIndex, showToast])

  const undo = useCallback(() => {
    if (historyIndex <= 0) {
      showToast("没有可撤销的操作")
      return
    }
    const nextIndex = historyIndex - 1
    setHistoryIndex(nextIndex)
    setContainers(cloneContainers(history[nextIndex]))
    showToast(`已撤销 (${nextIndex + 1}/${history.length})`)
  }, [history, historyIndex, showToast])

  const redo = useCallback(() => {
    if (historyIndex >= history.length - 1) {
      showToast("没有可重做的操作")
      return
    }
    const nextIndex = historyIndex + 1
    setHistoryIndex(nextIndex)
    setContainers(cloneContainers(history[nextIndex]))
    showToast(`已重做 (${nextIndex + 1}/${history.length})`)
  }, [history, historyIndex, showToast])

  const save = useCallback(() => {
    localStorage.setItem(TIER_STORAGE_KEY, JSON.stringify(toPersistable(containers)))
    showToast("已保存到本地")
  }, [containers, showToast])

  const load = useCallback(() => {
    const raw = localStorage.getItem(TIER_STORAGE_KEY)
    if (!raw) {
      showToast("没有保存的状态")
      return
    }
    const snapshot = parseStoredState(raw)
    if (!snapshot) {
      showToast("加载失败")
      return
    }
    setContainers(snapshot.containers)
    setHistory([cloneContainers(snapshot.containers)])
    setHistoryIndex(0)
    setPage(1)
    showToast("已加载保存的状态")
  }, [showToast])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === "z" && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if (event.key === "y" || (event.key === "z" && event.shiftKey)) {
        event.preventDefault()
        redo()
      } else if (event.key === "s") {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo, save])

  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [])

  const totalPages = Math.max(1, Math.ceil(containers.pool.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const visiblePool = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return containers.pool.slice(start, start + PAGE_SIZE)
  }, [containers.pool, currentPage])

  const onDrop = (zone: ZoneKey, beforeId?: string | null) => (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDragOver(null)
    const itemId = event.dataTransfer.getData("text/plain")
    if (!itemId) return
    const next = moveItem(containers, itemId, zone, beforeId)
    if (next) commit(next)
  }

  const moveToPool = (item: AnimeItem) => {
    const next = moveItem(containers, item.id, "pool")
    if (next) commit(next)
  }

  const deleteItem = (item: AnimeItem) => {
    if (!window.confirm("确定要删除这张图片吗？")) return
    const next = cloneContainers(containers)
    for (const key of Object.keys(next) as ZoneKey[]) {
      next[key] = next[key].filter((entry) => entry.id !== item.id)
    }
    commit(next)
  }

  const clearTiers = () => {
    if (!window.confirm("确定要清空所有层级吗？")) return
    const next = cloneContainers(containers)
    next.pool = [...next.S, ...next.A, ...next.B, ...next.C, ...next.D, ...next.pool]
    next.S = []
    next.A = []
    next.B = []
    next.C = []
    next.D = []
    commit(next, "已清空所有层级")
    setPage(1)
  }

  const addImage = () => {
    const url = window.prompt(
      "请输入图片链接（支持本地路径或网络URL）：\n例如：/anime/12.jpg 或 https://example.com/image.jpg",
    )
    if (!url || !url.trim()) return
    const alt = window.prompt("请输入图片名称（可选）：", "新图片") || "新图片"
    const item: AnimeItem = {
      id: `custom-${Date.now()}`,
      src: url.trim(),
      alt,
    }
    const next = cloneContainers(containers)
    next.pool = [...next.pool, item]
    commit(next, "图片已添加")
    setPage(Math.ceil(next.pool.length / PAGE_SIZE))
  }

  return (
    <div className="anime-tier-root">
      <div className="container">
        <h1>动漫评分 Tier List</h1>

        <div className="tier-container">
          {TIERS.map((tier) => (
            <div className="tier-row" key={tier}>
              <div
                className="tier-label"
                contentEditable
                suppressContentEditableWarning
                draggable={false}
                style={{ backgroundColor: TIER_COLORS[tier] }}
                onDragStart={(event) => event.preventDefault()}
              >
                {tier}
              </div>
              <DropZone
                zone={tier}
                items={containers[tier]}
                active={dragOver === tier}
                onDragOverZone={() => setDragOver(tier)}
                onDragLeaveZone={() => setDragOver((current) => (current === tier ? null : current))}
                onDropZone={onDrop(tier)}
                onDropItem={(beforeId) => onDrop(tier, beforeId)}
                onDoubleClick={moveToPool}
                onDelete={deleteItem}
                onContextMenu={(event, item) => {
                  event.preventDefault()
                  setMenu({ x: event.clientX, y: event.clientY, item })
                }}
              />
            </div>
          ))}
        </div>

        <div className="image-pool-section">
          <div className="pool-header">
            <h2>待选动漫</h2>
            <div className="toolbar">
              <button type="button" onClick={undo} disabled={historyIndex <= 0} title="撤销 (Ctrl+Z)">
                撤销
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={historyIndex >= history.length - 1}
                title="重做 (Ctrl+Y)"
              >
                重做
              </button>
              <button type="button" onClick={save} title="保存 (Ctrl+S)">
                保存
              </button>
              <button type="button" onClick={load} title="加载">
                加载
              </button>
              <button type="button" onClick={clearTiers} title="清空所有层级">
                清空
              </button>
              <button type="button" onClick={addImage} title="添加图片">
                添加图片
              </button>
              {containers.pool.length > PAGE_SIZE ? (
                <>
                  <span id="pageInfo" style={{ margin: "6px 8px", color: "var(--muted-foreground)" }}>
                    {currentPage} / {totalPages}
                  </span>
                  <button type="button" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    下一页
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <DropZone
            zone="pool"
            className="image-pool"
            items={visiblePool}
            active={dragOver === "pool"}
            onDragOverZone={() => setDragOver("pool")}
            onDragLeaveZone={() => setDragOver((current) => (current === "pool" ? null : current))}
            onDropZone={onDrop("pool")}
            onDropItem={(beforeId) => onDrop("pool", beforeId)}
            onDoubleClick={moveToPool}
            onDelete={deleteItem}
            onContextMenu={(event, item) => {
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY, item })
            }}
          />
        </div>
      </div>

      {menu ? (
        <div className="context-menu" style={{ position: "fixed", left: menu.x, top: menu.y }}>
          <div
            className="context-menu-item"
            onClick={() => {
              moveToPool(menu.item)
              setMenu(null)
            }}
          >
            移回图片池
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              deleteItem(menu.item)
              setMenu(null)
            }}
          >
            删除图片
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}

function DropZone({
  zone,
  items,
  active,
  className = "tier-dropzone",
  onDragOverZone,
  onDragLeaveZone,
  onDropZone,
  onDropItem,
  onDoubleClick,
  onDelete,
  onContextMenu,
}: {
  zone: ZoneKey
  items: AnimeItem[]
  active: boolean
  className?: string
  onDragOverZone: () => void
  onDragLeaveZone: () => void
  onDropZone: (event: DragEvent) => void
  onDropItem: (beforeId: string) => (event: DragEvent) => void
  onDoubleClick: (item: AnimeItem) => void
  onDelete: (item: AnimeItem) => void
  onContextMenu: (event: MouseEvent, item: AnimeItem) => void
}) {
  return (
    <div
      className={`${className}${active ? " drag-over" : ""}`}
      data-tier={zone === "pool" ? undefined : zone}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        onDragOverZone()
      }}
      onDragEnter={(event) => {
        event.preventDefault()
        onDragOverZone()
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          onDragLeaveZone()
        }
      }}
      onDrop={onDropZone}
    >
      {items.map((item) => (
        <div className="image-wrapper" key={item.id}>
          <img
            src={item.src}
            alt={item.alt}
            className="anime-image"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move"
              event.dataTransfer.setData("text/plain", item.id)
              event.currentTarget.closest(".image-wrapper")?.classList.add("dragging")
            }}
            onDragEnd={(event) => {
              event.currentTarget.closest(".image-wrapper")?.classList.remove("dragging")
            }}
            onDoubleClick={() => onDoubleClick(item)}
            onContextMenu={(event) => onContextMenu(event, item)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDropItem(item.id)}
          />
          <button
            type="button"
            className="delete-btn"
            title="删除图片"
            onClick={(event) => {
              event.stopPropagation()
              onDelete(item)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
