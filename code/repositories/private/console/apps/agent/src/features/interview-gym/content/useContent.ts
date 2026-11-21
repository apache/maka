import { use } from 'react'
import { loadContent } from './loader'
import type { Content } from './loader'

// 页面组件里 use(loadContent()) 读取内容，配合 Suspense 展示加载态
export function useContent(): Content {
  return use(loadContent())
}
