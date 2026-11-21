'use client'
// src/app/components/FlowMap.jsx —— 模块数据流地图（原 map.js 的 React 化）。
//
// 布局按真实执行流：用户文本 tui → cli → agent；agent 是循环枢纽，
// 与 llm / tools 之间各有一条双向边。数据包沿边流动，方向即数据方向。
// 数据包仍是 SVG animateMotion（SMIL）：动态插入的动画不会自动开始，
// 挂载后 ref 里手动 beginElement()。

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { MAP_NODES, MAP_EDGES } from '../utils/session-store.js'

function Packet({ p }) {
  const animRef = useRef(null)
  useEffect(() => {
    // 动态插入的 SMIL 动画必须手动触发
    animRef.current?.beginElement()
  }, [])
  return (
    <circle r={4} fill={p.color} className="packet">
      <animateMotion
        ref={animRef}
        dur="0.5s"
        fill="freeze"
        begin="indefinite"
        calcMode="linear"
        keyPoints={p.reverse ? '1;0' : '0;1'}
        keyTimes="0;1"
        path={MAP_EDGES[p.edge]}
      />
    </circle>
  )
}

export default function FlowMap({ store, onNodeClick }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)

  return (
    <div className="min-w-0 flex-1 self-stretch" role="img"
         aria-label="模块数据流地图：用户文本 tui→cli→agent，agent 与 llm、tools 之间循环往复">
      <svg viewBox="0 0 680 100" className="h-full w-full" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {/* 先画边（在节点下层） */}
        {Object.values(MAP_EDGES).map(d => <path key={d} d={d} className="flow-edge" />)}

        {/* 再画节点：rect + 模块名；点击直达该模块源码（期5） */}
        {MAP_NODES.map(n => (
          <g
            key={n.id}
            className={`flow-node clickable${snap.mapActive === n.id ? ' active' : ''}`}
            data-module={n.id}
            role="button"
            tabIndex={0}
            aria-label={`查看 ${n.id} 源码`}
            onClick={() => onNodeClick(n.id)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNodeClick(n.id) } }}
          >
            <rect x={n.cx - 38} y={n.cy - 13} width={76} height={26} rx={7} />
            <text x={n.cx} y={n.cy + 4} textAnchor="middle">{n.id}</text>
          </g>
        ))}

        {/* 循环注释：agent ⇄ llm/tools 这个环就是 coding agent 的核心结构 */}
        <text x={600} y={55} textAnchor="middle" className="flow-loop">↻ 直到模型不再调工具</text>

        {/* 数据包（store 里 600ms 自清除） */}
        {snap.packets.map(p => <Packet key={p.id} p={p} />)}
      </svg>
    </div>
  )
}
