import { SLIDES } from "./Slides";
import { useDeck } from "./useDeck";
import { Overview } from "./Overview";

const pad = (n: number) => String(n).padStart(2, "0");

export default function App() {
  const deck = useDeck();

  // 片段类名挂在 section 上（f1..fN），配合 CSS 做分步显示
  const fragCls = (i: number) => {
    if (i !== deck.cur) return "";
    let s = "";
    for (let k = 1; k <= deck.frag; k++) s += ` f${k}`;
    return s;
  };

  return (
    <div className="deck">
      <div className="stage" ref={deck.stageRef} onClick={deck.onStageClick}>
        {SLIDES.map((s, i) => (
          <section
            key={i}
            ref={deck.sectionRef(i)}
            className={"slide" + (s.cls ? " " + s.cls : "") + (i === deck.cur ? " active" : "") + fragCls(i)}
            data-frags={s.frags || undefined}
          >
            <s.Comp />
            <div className="pn">
              {pad(i + 1)} / {pad(SLIDES.length)}
            </div>
            <div className="prog" style={{ width: (1512 * (i + 1)) / SLIDES.length + "px" }} />
            {i === 0 && (
              <div className="hint">
                {"→ / space · next    ← · prev    o · overview    f · fullscreen"}
              </div>
            )}
          </section>
        ))}
      </div>
      {deck.ovOpen && <Overview cur={deck.cur} onPick={deck.jumpTo} onClose={() => deck.setOvOpen(false)} />}
    </div>
  );
}
