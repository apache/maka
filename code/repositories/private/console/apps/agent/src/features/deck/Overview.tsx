import { SLIDES } from "./Slides";

/** 按 o 键呼出的全页概览：每页取标题前 40 字（与原版一致） */
export function Overview({
  cur,
  onPick,
  onClose,
}: {
  cur: number;
  onPick: (i: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="overview show" onClick={onClose}>
      {SLIDES.map((s, i) => (
        <div
          key={i}
          className={"th" + (i === cur ? " cur" : "")}
          onClick={(e) => {
            e.stopPropagation();
            onPick(i);
          }}
        >
          <b>{pad(i + 1)}</b>
          {s.title}
        </div>
      ))}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
