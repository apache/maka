/**
 * 搜索结果面板组件
 * 展示搜索结果 (PRD/Component/CommitHash)
 */
import { useRouter } from 'next/navigation'
import type { SearchResultItem, SearchResultType } from '@/hooks/governance/useSearch'
import { cn } from '@ggbdpq/console-ui'

export interface SearchResultsProps {
  /** 搜索结果列表 */
  results: readonly SearchResultItem[]
  /** 是否正在搜索 */
  isSearching?: boolean
  /** 搜索关键词 */
  query: string
  /** 结果点击后的回调 */
  onResultClick?: () => void
  /** 自定义类名 */
  className?: string
}

/**
 * 获取结果类型的图标
 */
function getTypeIcon(type: SearchResultType): string {
  switch (type) {
    case 'prd':
      return '📋'
    case 'component':
      return '🧩'
    case 'progress':
      return '📝'
  }
}

/**
 * 获取结果类型的标签
 */
function getTypeLabel(type: SearchResultType): string {
  switch (type) {
    case 'prd':
      return 'PRD'
    case 'component':
      return '组件'
    case 'progress':
      return 'Progress'
  }
}

/**
 * 高亮搜索关键词
 */
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)

  if (index === -1) return text

  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-warning/25 text-foreground rounded px-0.5">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  )
}

/**
 * 搜索结果面板
 */
export function SearchResults({
  results,
  isSearching,
  query,
  onResultClick,
  className,
}: SearchResultsProps) {
  const router = useRouter()

  const handleClick = (result: SearchResultItem) => {
    router.push(result.route)
    onResultClick?.()
  }

  if (isSearching) {
    return (
      <div className={cn('rounded-lg border border-border bg-muted p-4', className)}>
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          <span>搜索中...</span>
        </div>
      </div>
    )
  }

  if (results.length === 0 && query.length >= 2) {
    return (
      <div className={cn('rounded-lg border border-border bg-muted p-4', className)}>
        <p className="text-center text-sm text-muted-foreground">
          未找到与 "{query}" 相关的结果
        </p>
      </div>
    )
  }

  if (results.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-muted overflow-hidden',
        className
      )}
    >
      <div className="max-h-80 overflow-y-auto">
        {results.map((result, index) => (
          <button
            key={result.id}
            onClick={() => handleClick(result)}
            className={cn(
              'w-full text-left px-4 py-3 hover:bg-accent/50 transition-colors',
              index > 0 && 'border-t border-border'
            )}
          >
            <div className="flex items-start gap-3">
              {/* 类型图标 */}
              <span className="text-lg">{getTypeIcon(result.type)}</span>

              {/* 内容 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">
                    {highlightMatch(result.title, query)}
                  </span>
                  <span className="text-xs rounded bg-accent px-1.5 py-0.5 text-muted-foreground">
                    {getTypeLabel(result.type)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground truncate mt-0.5">
                  {highlightMatch(result.description, query)}
                </p>
              </div>

              {/* 跳转箭头 */}
              <span className="text-muted-foreground">→</span>
            </div>
          </button>
        ))}
      </div>

      {/* 底部提示 */}
      <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        共 {results.length} 条结果 · 按 Enter 跳转
      </div>
    </div>
  )
}
