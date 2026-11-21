import { useEffect, useState } from 'react'
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  Check,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  TrashSimple,
  UploadSimple,
  X,
} from '@phosphor-icons/react'
import type { Bookmark, BatchAction, ImportPreview, ImportResult } from '@ggbdpq/console-shared/bookmarks'
import { cn } from '@ggbdpq/console-ui'
import { toast } from 'sonner'
import {
  useBatchBookmarks,
  useBookmarks,
  useCategories,
  useCreateBookmark,
  useDeleteBookmark,
  useDuplicates,
  useImportBookmarks,
  useRestoreBookmark,
  useUpdateBookmark,
} from '@/lib/bookmarks/api/bookmarks'
import { BookmarkEditRow, fieldClass } from './BookmarkEditRow'

type View = 'active' | 'trash' | 'duplicates'

const PAGE_SIZE = 200

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'active', label: '全部' },
  { key: 'trash', label: '回收站' },
  { key: 'duplicates', label: '重复项' },
]

const iconBtn =
  'rounded-sm p-1.5 text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-90'
const iconBtnDanger =
  'rounded-sm p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive active:scale-90'
const primaryBtn =
  'flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.97] disabled:opacity-40'
const secondaryBtn =
  'flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground transition hover:bg-accent active:scale-[0.97] disabled:opacity-40'
const dangerGhostBtn =
  'rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive transition hover:bg-destructive/10 active:scale-[0.97] disabled:opacity-40'
const tinyConfirmBtn =
  'rounded-sm bg-destructive px-2 py-0.5 text-xs text-destructive-foreground transition hover:bg-destructive/90 active:scale-95'

/** 提取 hostname；解析失败回退空串（favicon 据此走首字母兜底） */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 展示用域名；解析失败回退原文 */
function hostOf(url: string): string {
  return hostnameOf(url) || url
}

/** 骨架屏：与最终行布局同形 */
function RowSkeleton() {
  return (
    <li className="flex items-center gap-3 px-1 py-2.5">
      <div className="size-4 animate-pulse rounded bg-muted" />
      <div className="size-5 animate-pulse rounded-sm bg-muted" />
      <div className="h-4 flex-1 animate-pulse rounded bg-muted" style={{ maxWidth: '55%' }} />
    </li>
  )
}

/** favicon 外链图标，加载失败回退域名首字母头像 */
function BookmarkFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  const host = hostnameOf(url)
  if (!host || failed) {
    const letter = host.replace(/^www\./, '').charAt(0).toUpperCase() || '?'
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-muted text-[10px] font-semibold text-muted-foreground">
        {letter}
      </span>
    )
  }
  return (
    <img
      src={`https://favicon.cccyun.cc/${host}`}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-5 shrink-0 rounded-sm"
    />
  )
}

/** 导入卡：选文件 → 解析预览（不落库）→ 确认入库，两段式 */
function ImportCard({ onClose }: { onClose: () => void }) {
  const importM = useImportBookmarks()
  const [fileName, setFileName] = useState('')
  const [html, setHtml] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState('')

  return (
    <div className="mb-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition hover:bg-accent">
          选择书签导出文件（.html）
          <input
            type="file"
            accept=".html,.htm,text/html"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0]
              setPreview(null)
              setError('')
              if (!file) return
              setFileName(file.name)
              file
                .text()
                .then(setHtml)
                .catch(() => setError('读取文件失败'))
            }}
          />
        </label>
        {fileName && <span className="max-w-56 truncate text-xs text-muted-foreground">{fileName}</span>}
        <button
          type="button"
          disabled={!html || importM.isPending}
          onClick={() =>
            importM.mutate(
              { html, confirm: false },
              {
                onSuccess: (d) => setPreview(d as ImportPreview),
                onError: (e) => setError(e instanceof Error ? e.message : '解析失败'),
              },
            )
          }
          className={secondaryBtn}
        >
          解析预览
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-sm text-muted-foreground transition hover:text-foreground"
        >
          收起
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {preview && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-sm text-foreground">
            将导入 <span className="tnum font-semibold">{preview.willImport}</span> 条
            {preview.skipped > 0 && (
              <>
                ，跳过 <span className="tnum">{preview.skipped}</span> 条重复
              </>
            )}
            ，涉及 <span className="tnum">{preview.categories.length}</span> 个分类
          </p>
          {preview.categories.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {preview.categories.map((c) => (
                <span
                  key={c.name}
                  className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {c.name} · {c.count}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={importM.isPending || preview.willImport === 0}
            onClick={() =>
              importM.mutate(
                { html, confirm: true },
                {
                  onSuccess: (d) => {
                    const r = d as ImportResult
                    toast.success(`导入完成：新增 ${r.imported} 条，跳过 ${r.skipped} 条重复`)
                    onClose()
                  },
                  onError: (e) => setError(e instanceof Error ? e.message : '导入失败'),
                },
              )
            }
            className={cn(primaryBtn, 'mt-3')}
          >
            确认导入 {preview.willImport} 条
          </button>
        </div>
      )}
    </div>
  )
}

export function BookmarksPanel() {
  const [view, setView] = useState<View>('active')
  const [searchText, setSearchText] = useState('')
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)
  const [pendingPurgeId, setPendingPurgeId] = useState<number | null>(null)
  const [pendingBatch, setPendingBatch] = useState<'delete' | 'purge' | null>(null)
  const [recatCategory, setRecatCategory] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [nbTitle, setNbTitle] = useState('')
  const [nbUrl, setNbUrl] = useState('')
  const [nbCategory, setNbCategory] = useState('')
  const [nbNote, setNbNote] = useState('')

  // 搜索防抖 300ms；视图/过滤/关键词变化时回到第一页并清空选择
  useEffect(() => {
    const t = setTimeout(() => setQ(searchText.trim()), 300)
    return () => clearTimeout(t)
  }, [searchText])
  useEffect(() => {
    setOffset(0)
    setSelected(new Set())
    setPendingBatch(null)
  }, [q, category, view])

  const list = useBookmarks({
    q,
    category: category || undefined,
    view: view === 'trash' ? 'trash' : 'active',
    limit: PAGE_SIZE,
    offset,
  })
  const categoriesQ = useCategories()
  const duplicatesQ = useDuplicates(view === 'duplicates')

  const createM = useCreateBookmark()
  const updateM = useUpdateBookmark()
  const deleteM = useDeleteBookmark()
  const restoreM = useRestoreBookmark()
  const batchM = useBatchBookmarks()

  const total = list.data?.total ?? 0
  const items = list.data?.items ?? []
  const categoryNames = (categoriesQ.data?.categories ?? []).map((c) => c.name)

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const pageAllSelected = items.length > 0 && items.every((b) => selected.has(b.id))
  const toggleAllPage = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (pageAllSelected) items.forEach((b) => next.delete(b.id))
      else items.forEach((b) => next.add(b.id))
      return next
    })
  }

  const runBatch = (action: BatchAction, extra?: { category?: string }) => {
    batchM.mutate(
      { action, ids: [...selected], ...extra },
      {
        onSuccess: (r) => {
          toast.success(`已处理 ${r.affected} 条`)
          setSelected(new Set())
          setPendingBatch(null)
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : '批量操作失败'),
      },
    )
  }

  const confirmRowDelete = (b: Bookmark) => {
    setPendingDeleteId(null)
    setPendingPurgeId(null)
    if (view === 'trash') deleteM.mutate({ id: b.id, purge: true })
    else deleteM.mutate({ id: b.id })
  }

  const submitNew = (e: React.FormEvent) => {
    e.preventDefault()
    if (!nbTitle.trim() || !nbUrl.trim()) return
    createM.mutate(
      {
        title: nbTitle.trim(),
        url: nbUrl.trim(),
        category: nbCategory.trim() || undefined,
        note: nbNote.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success('已添加书签')
          setNbTitle('')
          setNbUrl('')
          setNbCategory('')
          setNbNote('')
          setShowAdd(false)
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : '添加失败'),
      },
    )
  }

  const renderRow = (b: Bookmark) => {
    if (editingId === b.id) {
      return (
        <li key={b.id} className="px-1 py-2">
          <BookmarkEditRow
            bookmark={b}
            categories={categoryNames}
            onCancel={() => setEditingId(null)}
            onSave={(v) => {
              updateM.mutate(
                { id: b.id, ...v },
                { onError: (err) => toast.error(err instanceof Error ? err.message : '保存失败') },
              )
              setEditingId(null)
            }}
          />
        </li>
      )
    }
    const awaitingConfirm = pendingDeleteId === b.id || pendingPurgeId === b.id
    return (
      <li key={b.id} className="group flex items-center gap-3 px-1 py-2.5">
        <input
          type="checkbox"
          aria-label={`选择「${b.title}」`}
          checked={selected.has(b.id)}
          onChange={() => toggleSelect(b.id)}
          className="size-4 shrink-0 accent-primary"
        />
        <BookmarkFavicon url={b.url} />
        <span className="min-w-0 flex-1">
          <a
            href={b.url}
            target="_blank"
            rel="noreferrer"
            title={b.title}
            className="block truncate text-sm text-info hover:underline"
          >
            {b.title}
          </a>
          <span className="block truncate text-xs text-muted-foreground">
            {hostOf(b.url)}
            {b.note ? ` · ${b.note}` : ''}
          </span>
        </span>
        {b.category && (
          <span className="hidden shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:inline">
            {b.category}
          </span>
        )}
        {awaitingConfirm ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {pendingPurgeId === b.id ? '彻底删除，不可恢复？' : '删除（移入回收站）？'}
            <button
              onClick={() => confirmRowDelete(b)}
              aria-label="确认"
              className="grid size-6 place-items-center rounded-sm text-destructive transition hover:bg-destructive/10 active:scale-[0.95]"
            >
              <Check size={14} weight="bold" />
            </button>
            <button
              onClick={() => {
                setPendingDeleteId(null)
                setPendingPurgeId(null)
              }}
              aria-label="取消"
              className="grid size-6 place-items-center rounded-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.95]"
            >
              <X size={14} />
            </button>
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {view === 'trash' ? (
              <>
                <button
                  onClick={() =>
                    restoreM.mutate(b.id, {
                      onError: (err) => toast.error(err instanceof Error ? err.message : '恢复失败'),
                    })
                  }
                  title="恢复"
                  aria-label={`恢复「${b.title}」`}
                  className={iconBtn}
                >
                  <ArrowCounterClockwise size={16} />
                </button>
                <button
                  onClick={() => setPendingPurgeId(b.id)}
                  title="彻底删除"
                  aria-label={`彻底删除「${b.title}」`}
                  className={iconBtnDanger}
                >
                  <TrashSimple size={16} />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    setEditingId(b.id)
                    setPendingDeleteId(null)
                  }}
                  title="编辑"
                  aria-label={`编辑「${b.title}」`}
                  className={iconBtn}
                >
                  <PencilSimple size={16} />
                </button>
                <button
                  onClick={() => setPendingDeleteId(b.id)}
                  title="删除"
                  aria-label={`删除「${b.title}」`}
                  className={iconBtnDanger}
                >
                  <TrashSimple size={16} />
                </button>
              </>
            )}
          </div>
        )}
      </li>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">书签台</h1>
        <p className="tnum mt-1 text-[13px] text-muted-foreground">
          {view === 'duplicates'
            ? `${duplicatesQ.data?.groups.length ?? 0} 组近似重复`
            : `${total} 条${view === 'trash' ? '在回收站' : ''}`}
        </p>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-sm transition',
                view === v.key
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {view !== 'duplicates' && (
            <div className="relative">
              <MagnifyingGlass
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="搜索标题 / URL / 分类"
                aria-label="搜索书签"
                className="w-52 rounded-md border border-input bg-transparent py-1.5 pl-8 pr-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </div>
          )}
          {view === 'active' && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="按分类过滤"
              className="max-w-44 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring"
            >
              <option value="">全部分类</option>
              {categoriesQ.data?.categories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}（{c.count}）
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => {
              setShowImport((s) => !s)
              setShowAdd(false)
            }}
            className={secondaryBtn}
          >
            <UploadSimple size={15} />
            导入
          </button>
          <button
            type="button"
            onClick={() => {
              setShowAdd((s) => !s)
              setShowImport(false)
            }}
            className={primaryBtn}
          >
            <Plus size={15} weight="bold" />
            新增
          </button>
        </div>
      </div>

      {showImport && <ImportCard onClose={() => setShowImport(false)} />}

      {showAdd && (
        <form onSubmit={submitNew} className="mb-3 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={nbTitle}
              onChange={(e) => setNbTitle(e.target.value)}
              placeholder="标题"
              aria-label="书签标题"
              className={`${fieldClass} min-w-40 flex-1`}
            />
            <input
              value={nbUrl}
              onChange={(e) => setNbUrl(e.target.value)}
              placeholder="https://…"
              aria-label="书签 URL"
              className={`${fieldClass} min-w-60 flex-[2]`}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={nbCategory}
              onChange={(e) => setNbCategory(e.target.value)}
              list="bookmark-category-options"
              placeholder="分类（可留空）"
              aria-label="书签分类"
              className={`${fieldClass} w-44`}
            />
            <input
              value={nbNote}
              onChange={(e) => setNbNote(e.target.value)}
              placeholder="备注（可留空）"
              aria-label="书签备注"
              className={`${fieldClass} min-w-40 flex-1`}
            />
            <datalist id="bookmark-category-options">
              {categoryNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <button
              type="submit"
              disabled={!nbTitle.trim() || !nbUrl.trim() || createM.isPending}
              className={primaryBtn}
            >
              添加
            </button>
            <button type="button" onClick={() => setShowAdd(false)} className={secondaryBtn}>
              取消
            </button>
          </div>
        </form>
      )}

      {selected.size > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            已选 <span className="tnum">{selected.size}</span> 条
          </span>
          {view === 'trash' ? (
            pendingBatch === 'purge' ? (
              <span className="flex items-center gap-2 text-xs text-destructive">
                彻底删除 {selected.size} 条，不可恢复？
                <button onClick={() => runBatch('purge')} disabled={batchM.isPending} className={tinyConfirmBtn}>
                  确认
                </button>
                <button
                  onClick={() => setPendingBatch(null)}
                  className="text-muted-foreground transition hover:text-foreground"
                >
                  取消
                </button>
              </span>
            ) : (
              <>
                <button onClick={() => runBatch('restore')} disabled={batchM.isPending} className={secondaryBtn}>
                  批量恢复
                </button>
                <button onClick={() => setPendingBatch('purge')} className={dangerGhostBtn}>
                  彻底删除
                </button>
              </>
            )
          ) : (
            <>
              {pendingBatch === 'delete' ? (
                <span className="flex items-center gap-2 text-xs text-destructive">
                  删除 {selected.size} 条（移入回收站）？
                  <button onClick={() => runBatch('delete')} disabled={batchM.isPending} className={tinyConfirmBtn}>
                    确认
                  </button>
                  <button
                    onClick={() => setPendingBatch(null)}
                    className="text-muted-foreground transition hover:text-foreground"
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button onClick={() => setPendingBatch('delete')} className={dangerGhostBtn}>
                  批量删除
                </button>
              )}
              <span className="flex items-center gap-1 text-muted-foreground">
                改分类为
                <input
                  value={recatCategory}
                  onChange={(e) => setRecatCategory(e.target.value)}
                  placeholder="分类名"
                  aria-label="批量新分类"
                  className="w-28 rounded-md border border-input bg-transparent px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
                />
                <button
                  onClick={() => runBatch('recategorize', { category: recatCategory.trim() })}
                  disabled={!recatCategory.trim() || batchM.isPending}
                  className={secondaryBtn}
                >
                  应用
                </button>
              </span>
            </>
          )}
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-muted-foreground transition hover:text-foreground"
          >
            取消选择
          </button>
        </div>
      )}

      {list.error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          加载失败（{list.error instanceof Error ? list.error.message : '未知错误'}）
        </p>
      )}

      {view === 'duplicates' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {duplicatesQ.isLoading && (
            <ul className="divide-y divide-border">
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </ul>
          )}
          {duplicatesQ.data && duplicatesQ.data.groups.length === 0 && (
            <p className="py-16 text-center text-sm text-muted-foreground">没有发现近似重复的书签</p>
          )}
          {duplicatesQ.data?.groups.map((g) => (
            <div key={g.key} className="border-b border-border last:border-b-0">
              <p className="px-1 pb-1 pt-3 text-xs text-muted-foreground">
                同页重复 × <span className="tnum">{g.count}</span> · <span className="tnum">{g.key}</span>
              </p>
              <ul className="divide-y divide-border">{g.items.map(renderRow)}</ul>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 px-1 pb-1 text-xs text-muted-foreground">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                aria-label="全选本页"
                checked={pageAllSelected}
                onChange={toggleAllPage}
                className="size-4 accent-primary"
              />
              全选本页
            </label>
            {view === 'trash' && <span>回收站内可恢复；彻底删除不可找回</span>}
          </div>
          <ul className="mt-1 min-h-0 flex-1 divide-y divide-border overflow-y-auto">
            {list.isLoading && (
              <>
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </>
            )}
            {items.map(renderRow)}
            {!list.isLoading && items.length === 0 && (
              <li className="py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  {view === 'trash' ? '回收站是空的' : '还没有书签——右上角导入浏览器书签，或手动新增'}
                </p>
              </li>
            )}
          </ul>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span className="tnum">共 {total} 条</span>
            <span className="flex items-center gap-2">
              <button
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                className={secondaryBtn}
              >
                <ArrowLeft size={12} />
                上一页
              </button>
              <span className="tnum">
                {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)}
              </span>
              <button
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className={secondaryBtn}
              >
                下一页
                <ArrowRight size={12} />
              </button>
            </span>
          </div>
        </>
      )}
    </section>
  )
}
