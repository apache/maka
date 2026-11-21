import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { SLIDES } from "./Slides";

const fragsOf = (i: number) => SLIDES[i]?.frags ?? 0;

/**
 * 幻灯片引擎：页码 + 片段两级进度，hash 形如 #/3 或 #/3.2（第 3 页第 2 个片段）。
 * 翻页/跳转会同步 hash，浏览器前进后退也能驱动页面。
 */
export function useDeck() {
  const [cur, setCur] = useState(0);
  const [frag, setFrag] = useState(0);
  const [ovOpen, setOvOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);

  // ponytail: 片段显隐沿用原版的 DOM 切换（.frag.on / .caps .note.cur）；
  // 要纯 React 化就把 frag 状态下放进 Slide 组件，目前没必要。
  useEffect(() => {
    const el = sectionRefs.current[cur];
    if (!el) return;
    el.querySelectorAll<HTMLElement>(".frag").forEach((e) => {
      e.classList.toggle("on", Number(e.dataset.f) <= frag);
    });
    el.querySelectorAll<HTMLElement>(".caps .note").forEach((e) => {
      e.classList.toggle("cur", Number(e.dataset.f) === frag);
    });
  }, [cur, frag]);

  const show = useCallback((i: number, f = 0) => {
    const ni = Math.max(0, Math.min(SLIDES.length - 1, i));
    setCur(ni);
    setFrag(f);
    location.hash = `#/${ni + 1}` + (f ? `.${f}` : "");
  }, []);

  const next = useCallback(() => {
    if (frag < fragsOf(cur)) {
      setFrag(frag + 1);
      location.hash = `#/${cur + 1}.${frag + 1}`;
    } else {
      show(cur + 1);
    }
  }, [cur, frag, show]);

  const prev = useCallback(() => {
    if (frag > 0) {
      setFrag(frag - 1);
      location.hash = `#/${cur + 1}` + (frag - 1 ? `.${frag - 1}` : "");
    } else {
      show(cur - 1, fragsOf(cur - 1)); // 回上一页时落在它最后一个片段
    }
  }, [cur, frag, show]);

  // 初始与浏览器前进后退：从 hash 恢复位置
  useEffect(() => {
    const fromHash = () => {
      const m = location.hash.match(/#\/(\d+)(?:\.(\d+))?/);
      if (m) show(Number(m[1]) - 1, m[2] ? Number(m[2]) : 0);
      else show(0);
    };
    fromHash();
    addEventListener("hashchange", fromHash);
    return () => removeEventListener("hashchange", fromHash);
  }, [show]);

  // 键盘：→/空格 翻页，← 回退，Home/End 首尾，o/Esc 概览，f 全屏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) {
        e.preventDefault();
        next();
      } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) {
        e.preventDefault();
        prev();
      } else if (e.key === "Home") {
        show(0);
      } else if (e.key === "End") {
        show(SLIDES.length - 1);
      } else if (e.key === "o" || e.key === "Escape") {
        setOvOpen((v) => !v);
      } else if (e.key === "f") {
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [next, prev, show]);

  // 1600×900 舞台等比缩放适配窗口
  useEffect(() => {
    const fit = () => {
      const st = stageRef.current;
      if (!st) return;
      const s = Math.min(innerWidth / 1600, innerHeight / 900);
      st.style.transform = `translate(-50%,-50%) scale(${s})`;
      st.style.transformOrigin = "center";
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);

  // 触摸滑动翻页
  useEffect(() => {
    let tx: number | null = null;
    const start = (e: TouchEvent) => {
      tx = e.touches[0].clientX;
    };
    const end = (e: TouchEvent) => {
      if (tx === null) return;
      const dx = e.changedTouches[0].clientX - tx;
      if (Math.abs(dx) > 40) (dx < 0 ? next : prev)();
      tx = null;
    };
    addEventListener("touchstart", start, { passive: true });
    addEventListener("touchend", end);
    return () => {
      removeEventListener("touchstart", start);
      removeEventListener("touchend", end);
    };
  }, [next, prev]);

  // 点击舞台：左侧 1/4 上一页，其余下一页（概览打开时忽略）
  const onStageClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (ovOpen || !stageRef.current) return;
      const r = stageRef.current.getBoundingClientRect();
      (e.clientX - r.left) / r.width < 0.25 ? prev() : next();
    },
    [ovOpen, next, prev]
  );

  const jumpTo = useCallback(
    (i: number) => {
      setOvOpen(false);
      show(i);
    },
    [show]
  );

  const sectionRef = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      sectionRefs.current[i] = el;
    },
    []
  );

  return { cur, frag, ovOpen, stageRef, sectionRef, onStageClick, jumpTo, setOvOpen };
}
