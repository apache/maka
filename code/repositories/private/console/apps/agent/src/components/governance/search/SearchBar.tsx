/**
 * 全局搜索栏组件
 * 支持快捷键触发
 */
import { useRef, useEffect, useState } from 'react'
import { cn } from '@ggbdpq/console-ui'

export interface SearchBarProps {
  /** 搜索值 */
  value: string
  /** 值变化回调 */
  onChange: (value: string) => void
  /** 清空回调 */
  onClear?: () => void
  /** 获得焦点回调 */
  onFocus?: () => void
  /** 失去焦点回调 */
  onBlur?: () => void
  /** 占位文本 */
  placeholder?: string
  /** 自定义类名 */
  className?: string
}

/**
 * 全局搜索栏
 */
export function SearchBar({
  value,
  onChange,
  onClear,
  onFocus,
  onBlur,
  placeholder = '搜索 PRD、组件...',
  className,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isFocused, setIsFocused] = useState(false)

  // 快捷键支持 (Cmd/Ctrl + K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
      // ESC 关闭搜索
      if (e.key === 'Escape' && isFocused) {
        inputRef.current?.blur()
        onClear?.()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isFocused, onClear])

  const handleFocus = () => {
    setIsFocused(true)
    onFocus?.()
  }

  const handleBlur = () => {
    setIsFocused(false)
    onBlur?.()
  }

  return (
    <div className={cn('relative', className)}>
      {/* 搜索图标 */}
      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>

      {/* 输入框 */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={cn(
          'w-full rounded-lg border bg-muted py-2 pl-10 pr-20 text-sm text-foreground',
          'placeholder:text-muted-foreground',
          'focus:outline-none focus:ring-2',
          isFocused
            ? 'border-ring ring-ring/20'
            : 'border-border hover:border-border'
        )}
      />

      {/* 快捷键提示 */}
      {!value && !isFocused && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
          <kbd className="rounded bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">⌘</kbd>
          <kbd className="rounded bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">K</kbd>
        </div>
      )}

      {/* 清空按钮 */}
      {value && (
        <button
          onClick={() => {
            onChange('')
            onClear?.()
            inputRef.current?.focus()
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  )
}
