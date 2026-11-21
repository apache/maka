/**
 * 页面顶部 Header 组件
 * 包含页面标题、搜索入口、主题切换等
 */
import { useState } from 'react'
import { useSearch } from '@/hooks/governance/useSearch'
import { SearchBar, SearchResults } from '../search'

export interface HeaderProps {
  /** 主题切换插槽（占位） */
  themeSlot?: React.ReactNode
}

/**
 * 顶部 Header 组件
 */
export function Header({ themeSlot }: HeaderProps) {
  const { query, setQuery, results, isSearching, clear } = useSearch()
  const [showResults, setShowResults] = useState(false)

  const handleFocus = () => {
    setShowResults(true)
  }

  const handleBlur = () => {
    // 延迟关闭以允许点击结果
    setTimeout(() => setShowResults(false), 200)
  }

  const handleResultClick = () => {
    setShowResults(false)
    clear()
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-background px-6">
      {/* 品牌区 */}
      <span className="text-lg font-bold text-primary">治理台</span>

      {/* 搜索区域 */}
      <div className="relative flex-1 max-w-md">
        <SearchBar
          value={query}
          onChange={setQuery}
          onClear={clear}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder="搜索 PRD、组件... (⌘K)"
        />

        {/* 搜索结果下拉 */}
        {showResults && (query.length >= 2 || results.length > 0) && (
          <div className="absolute top-full left-0 right-0 mt-2 z-50">
            <SearchResults
              results={results}
              isSearching={isSearching}
              query={query}
              onResultClick={handleResultClick}
            />
          </div>
        )}
      </div>

      {/* 右侧操作区 */}
      <div className="flex items-center space-x-4">
        {themeSlot}
      </div>
    </header>
  )
}
