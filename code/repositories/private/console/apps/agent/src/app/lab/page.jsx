'use client'

// /lab 是浏览器专属教学场（localStorage、Portal、终端 UI，无 SSR 语义），
// 整页 dynamic ssr:false 关闭服务端首渲染——原 Vite 应用即纯客户端。
import dynamic from 'next/dynamic'

const LabApp = dynamic(() => import('./LabApp'), { ssr: false })

export default function LabPage() {
  return <LabApp />
}
