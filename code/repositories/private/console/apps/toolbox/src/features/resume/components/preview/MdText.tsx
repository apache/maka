"use client"

import { Fragment } from "react"
import { parseMarkdown, type MdSegment } from "@/features/resume/lib/markdown"

function Segments({ segments }: { segments: MdSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.bold ? (
          <strong key={i} className="font-semibold" style={{ color: "inherit" }}>
            {s.text}
          </strong>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  )
}

/** 渲染简历正文 Markdown（段落 + 无序列表 + 加粗） */
export function MdText({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={className}>
      {blocks.map((b, i) =>
        b.type === "list" ? (
          <ul key={i} className="list-none space-y-1">
            {b.items.map((item, j) => (
              <li
                key={j}
                className={
                  item.level === 1
                    ? "relative ml-7 pl-4"
                    : "relative pl-4"
                }
              >
                <span
                  aria-hidden
                  className={
                    item.level === 1
                      ? "absolute left-[5px] top-[0.55em] size-1.5 rounded-full border border-current opacity-70"
                      : "absolute left-0 top-[0.5em] size-1.5 bg-current opacity-75"
                  }
                />
                <Segments segments={item.segments} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            <Segments segments={b.segments} />
          </p>
        ),
      )}
    </div>
  )
}
