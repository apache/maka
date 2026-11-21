import { useEffect, useRef, useState } from "react";
import { GROUPS, LESSONS, type Lesson } from "./data/lessons";
import { VisualRegistry } from "./VisualRegistry";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 从 hash 读当前课节 id，非法时回退到第一节 */
function readHashLessonId(): string {
  const id = window.location.hash.slice(1);
  return LESSONS.some((l) => l.id === id) ? id : LESSONS[0].id;
}

export default function App() {
  const [currentId, setCurrentId] = useState(readHashLessonId);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const index = LESSONS.findIndex((l) => l.id === currentId);
  const lesson: Lesson = LESSONS[index];
  const progress = ((index + 1) / LESSONS.length) * 100;

  // 侧栏按关键词过滤（标题 + 章节），无匹配的章节整体隐藏
  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    lessons: g.lessons.filter((l) =>
      `${l.title} ${l.group}`.toLowerCase().includes(query.toLowerCase()),
    ),
  })).filter((g) => g.lessons.length);

  const closeSidebar = (refocusMenu = false) => {
    setSidebarOpen(false);
    if (refocusMenu)
      window.requestAnimationFrame(() => menuBtnRef.current?.focus());
  };
  const openSidebar = () => {
    setSidebarOpen(true);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  };
  const navigate = (id: string) => {
    setCurrentId(id);
    closeSidebar();
    if (window.location.hash !== `#${id}`)
      window.history.pushState(null, "", `#${id}`);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  // 浏览器前进/后退与 hash 变化 → 同步课节
  useEffect(() => {
    const sync = () => {
      setCurrentId(readHashLessonId());
      setSidebarOpen(false);
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // 移动端侧栏打开时锁住 body 滚动
  useEffect(() => {
    if (!sidebarOpen || !window.matchMedia("(max-width: 900px)").matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  // 快捷键：Esc 关侧栏，⌘/Ctrl+K 搜索，←/→ 切换课次
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sidebarOpen) {
        e.preventDefault();
        closeSidebar(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSidebar();
        return;
      }
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, button, textarea, select, [contenteditable="true"]')) return;
      if (e.key === "ArrowRight")
        navigate(LESSONS[Math.min(index + 1, LESSONS.length - 1)].id);
      if (e.key === "ArrowLeft") navigate(LESSONS[Math.max(index - 1, 0)].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, index]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          onClick={() => navigate(LESSONS[0].id)}
          aria-label="回到课程开头"
        >
          <span className="brand-mark">知</span>
          <span>
            <small>交互式培训课程</small>
            <b>理解大模型</b>
          </span>
        </button>
        <div className="course-position">
          <span>课程进度</span>
          <b>
            {pad2(index + 1)} <i>/</i> {pad2(LESSONS.length)}
          </b>
          <span className="course-meter" aria-label={`课程进度 ${Math.round(progress)}%`}>
            <i style={{ width: `${progress}%` }} />
          </span>
        </div>
        <div className="top-actions">
          <button
            ref={menuBtnRef}
            type="button"
            className="menu-button"
            onClick={() => (sidebarOpen ? closeSidebar(true) : openSidebar())}
            aria-controls="course-sidebar"
            aria-expanded={sidebarOpen}
          >
            课程目录 <span>⌘ K</span>
          </button>
        </div>
      </header>

      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="关闭课程目录"
          onClick={() => closeSidebar()}
        />
      )}

      <aside id="course-sidebar" className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="sidebar-intro">
          <span>课程目录</span>
          <b>从 Token 到 Agent</b>
          <p>十五节课，逐步看清大模型如何工作。</p>
        </div>
        <div className="sidebar-search">
          <label htmlFor="lesson-search">查找</label>
          <input
            ref={searchRef}
            id="lesson-search"
            placeholder="搜索课程内容"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <nav aria-label="课程章节">
          {visibleGroups.length ? (
            visibleGroups.map((g) => (
              <section className="chapter" key={g.group}>
                <div className="chapter-title">
                  <span>{g.group}</span>
                  <small>{g.lessons.length}</small>
                </div>
                {g.lessons.map((l) => (
                  <button
                    type="button"
                    key={l.id}
                    className={`lesson-link ${l.id === lesson.id ? "is-active" : ""}`}
                    aria-current={l.id === lesson.id ? "page" : undefined}
                    onClick={() => navigate(l.id)}
                  >
                    <span className="lesson-number">{l.icon}</span>
                    <span>{l.title}</span>
                  </button>
                ))}
              </section>
            ))
          ) : (
            <p className="search-empty" role="status">
              没有找到匹配的课程
            </p>
          )}
        </nav>
        <div className="sidebar-foot">
          <p>
            <kbd>←</kbd> <kbd>→</kbd> 切换课次
          </p>
        </div>
      </aside>

      <main className="lesson-main">
        <div className="breadcrumb">
          <span>{lesson.group}</span>
          <i>·</i>
          <b>第 {pad2(index + 1)} 节</b>
        </div>
        <article className="lesson-content" key={lesson.id}>
          <header className="lesson-intro">
            <div className="lesson-copy">
              <div className="lesson-order">第 {pad2(index + 1)} 节</div>
              <h1>
                {lesson.titleLines ? (
                  <>
                    <span className="lesson-title-line">{lesson.titleLines[0]}</span>
                    <br className="desktop-title-break" />
                    <span className="lesson-title-line">{lesson.titleLines[1]}</span>
                  </>
                ) : (
                  lesson.title
                )}
              </h1>
              <p>{lesson.summary}</p>
            </div>
            <aside className="lesson-question">
              <span>请先想一想</span>
              <b>{lesson.question}</b>
            </aside>
          </header>
          <div id="interactive-lab">
            <VisualRegistry kind={lesson.visual} lessonId={lesson.id} />
          </div>
          <section className="takeaways">
            <div>
              <span className="section-label">本节要点</span>
              <h2>带走这些理解</h2>
            </div>
            <ol>
              {lesson.takeaways.map((t, i) => (
                <li key={t}>
                  <span>{pad2(i + 1)}</span>
                  {t}
                </li>
              ))}
            </ol>
          </section>
        </article>
      </main>

      <footer className="lesson-footer">
        <button
          type="button"
          className="nav-button"
          onClick={() => index > 0 && navigate(LESSONS[index - 1].id)}
          disabled={index === 0}
        >
          <small>← 上一节</small>
          <b>{index > 0 ? LESSONS[index - 1].title : "已经是第一节"}</b>
        </button>
        <span className="footer-position">
          {pad2(index + 1)} / {pad2(LESSONS.length)} <i />
        </span>
        <button
          type="button"
          className="nav-button nav-next"
          onClick={() => navigate(index < LESSONS.length - 1 ? LESSONS[index + 1].id : LESSONS[0].id)}
        >
          <small>{index < LESSONS.length - 1 ? "下一节 →" : "重新开始 ↺"}</small>
          <b>
            {index < LESSONS.length - 1 ? LESSONS[index + 1].title : "回到课程开头"}
          </b>
        </button>
      </footer>
    </div>
  );
}
