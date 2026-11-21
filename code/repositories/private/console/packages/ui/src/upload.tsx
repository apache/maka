"use client";
import * as React from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "./cn";

// Upload：拖拽/点选触发，文件列表由调用方管理（真实 XHR 上传缓迁）

export function Upload({
  onFiles,
  accept,
  multiple = false,
  className,
  hint = "点击或拖拽文件到此处",
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  className?: string;
  hint?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
        dragOver ? "border-primary bg-accent" : "hover:border-primary/50",
        className,
      )}
    >
      <UploadCloud className="size-8 text-muted-foreground" />
      <p className="text-sm">{hint}</p>
      <p className="text-xs text-muted-foreground">支持拖拽上传</p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
      />
    </div>
  );
}

export function UploadList({ files, onRemove }: { files: File[]; onRemove: (name: string) => void }) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {files.map((f) => (
        <li key={f.name} className="flex items-center justify-between rounded-md border px-3 py-1.5">
          <span className="truncate">{f.name}</span>
          <button type="button" onClick={() => onRemove(f.name)} className="text-xs text-destructive hover:underline">
            移除
          </button>
        </li>
      ))}
    </ul>
  );
}
