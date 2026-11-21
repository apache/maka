import { useState } from 'react'
import { Check, X } from '@phosphor-icons/react'
import type { Bookmark } from '@ggbdpq/console-shared/bookmarks'

/** 域内统一的表单控件样式（行内编辑与新增表单共用） */
export const fieldClass =
  'min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20'

/** 行内编辑表单：标题 / URL / 分类（datalist 提示现存分类）/ 备注 */
export function BookmarkEditRow({
  bookmark,
  categories,
  onSave,
  onCancel,
}: {
  bookmark: Bookmark
  categories: string[]
  onSave: (v: { title: string; url: string; category: string; note: string }) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(bookmark.title)
  const [url, setUrl] = useState(bookmark.url)
  const [category, setCategory] = useState(bookmark.category)
  const [note, setNote] = useState(bookmark.note)
  const valid = title.trim() !== '' && url.trim() !== ''

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) {
          onSave({
            title: title.trim(),
            url: url.trim(),
            category: category.trim(),
            note: note.trim(),
          })
        }
      }}
      className="w-full py-1"
    >
      <div className="flex flex-wrap gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题"
          aria-label="书签标题"
          className={`${fieldClass} min-w-40 flex-1`}
        />
        <button
          type="submit"
          disabled={!valid}
          aria-label="保存"
          className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 active:scale-90 disabled:opacity-40"
        >
          <Check size={15} weight="bold" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          aria-label="取消编辑"
          className="grid size-8 shrink-0 place-items-center rounded-md border border-input text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-90"
        >
          <X size={15} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          aria-label="书签 URL"
          className={`${fieldClass} min-w-60 flex-[2]`}
        />
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          list="bookmark-category-options"
          placeholder="分类"
          aria-label="书签分类"
          className={`${fieldClass} w-40`}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注"
          aria-label="书签备注"
          className={`${fieldClass} min-w-40 flex-1`}
        />
      </div>
    </form>
  )
}
