'use client'
// src/app/components/TerminalHost.jsx —— 核心学习文件 tui.js 的 React 外壳。
//
// tui 是 5 个核心文件之一，保持命令式 DOM（与 pi-from-scratch 的 tui.ts 对照阅读）；
// React 只提供挂载点，绝不接管它内部的 DOM（空依赖 effect，挂载一次）。

import { useEffect, useRef } from 'react'
import { Tui } from '@ggbdpq/agent-lab-core/src/tui.js'

export default function TerminalHost({ onTui }) {
  const ref = useRef(null)

  useEffect(() => {
    const tui = new Tui(ref.current)
    onTui(tui)
    // 应用生命周期内常驻，不卸载
  }, [])

  return <div ref={ref} className="flex min-h-0 flex-1 flex-col" />
}
