import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@ig/router";
import { Timer } from "lucide-react";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ig/components/ui/card";
import { useContent } from "@ig/content/useContent";
import { localDateKey } from "@ig/lib/dates";
import { buildLookup } from "@ig/state/lookup";
import { useArena } from "@ig/state/store";
import { Runner, BackLink } from "@ig/features/practice/components/Runner";
import { buildExamItems, examBySlug } from "@ig/features/mock-exam/lib/exams";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 开考页：全局倒计时 + 分段提示；到时自动收卷进报告
export function ExamRunner() {
  const content = useContent();
  const { slug } = useParams() as { slug: string };
  const exam = slug ? examBySlug(decodeURIComponent(slug)) : undefined;
  const recordAttempt = useArena((s) => s.recordAttempt);
  const lookup = useMemo(() => buildLookup(content), [content]);

  const [started, setStarted] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [timeUp, setTimeUp] = useState(false);

  const examRun = useMemo(
    () => (exam ? buildExamItems(exam, content.bank, content.projectCards) : null),
    [exam, started, content],
  );

  if (!exam) {
    return (
      <div className="space-y-3">
        <BackLink to="/exams" label="模拟卷" />
        <p className="text-sm text-muted-foreground">找不到试卷：{slug}</p>
      </div>
    );
  }

  if (!examRun || examRun.items.length === 0) {
    return (
      <div className="space-y-3">
        <BackLink to="/exams" label="模拟卷" />
        <p className="text-sm text-muted-foreground">
          当前资料没有可抽取的独立题目，请按练习说明手动选题；本次不启动计时或记录成绩。
        </p>
        <Button asChild variant="outline">
          <Link to={`/exams/${encodeURIComponent(exam.slug)}/doc`}>查看练习说明</Link>
        </Button>
      </div>
    );
  }

  if (!started) {
    const totalMinutes = exam.segments.reduce((sum, s) => sum + s.minutes, 0);
    return (
      <div className="space-y-3">
        <BackLink to="/exams" label="模拟卷" />
        <Card>
          <CardHeader>
            <CardTitle>{exam.title}</CardTitle>
            <CardDescription>{exam.intro}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1 text-sm text-muted-foreground">
              {exam.segments.map((seg) => (
                <li key={seg.label}>
                  {seg.label}：{seg.count} 题 / {seg.minutes} 分钟
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              全程 {totalMinutes} 分钟倒计时，到时自动收卷；每题按四维 0–2
              现场评分，计入统计与掌握度。
            </p>
            <Button
              onClick={() => {
                setSecondsLeft(totalMinutes * 60);
                setStarted(true);
              }}
            >
              <Timer className="size-4" /> 开始考试
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const timerHeader = (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <span className="flex items-center gap-2 text-sm">
        <Timer className="size-4 text-muted-foreground" />
        {exam.title}
      </span>
      <Badge
        variant={timeUp ? "destructive" : secondsLeft < 300 ? "outline" : "secondary"}
        className="tabular-nums"
      >
        {timeUp ? "已收卷" : fmt(secondsLeft)}
      </Badge>
    </div>
  );

  return (
    <div className="space-y-3">
      <ExamTimer setSecondsLeft={setSecondsLeft} setTimeUp={setTimeUp} />
      <Runner
        title={exam.title}
        header={timerHeader}
        segmentLabel={(i) => examRun.segmentOf(i)}
        items={examRun.items}
        lookup={lookup}
        getProjectBody={(entry) =>
          entry.project ? content.projectBodies[entry.project.slug] : undefined
        }
        onSave={(_index, item, scores, note) =>
          recordAttempt({
            qid: item.qid,
            date: localDateKey(),
            ts: Date.now(),
            kind: item.kind,
            scores,
            note,
          })
        }
        finishLabel="回到模拟卷"
        finishTo="/exams"
      />
    </div>
  );
}

// 计时器独立组件，interval 不随 Runner 重渲重置
function ExamTimer({
  setSecondsLeft,
  setTimeUp,
}: {
  setSecondsLeft: (fn: (n: number) => number) => void;
  setTimeUp: (v: boolean) => void;
}) {
  useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft((n) => {
        if (n <= 1) {
          clearInterval(id);
          setTimeUp(true);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [setSecondsLeft, setTimeUp]);
  return null;
}
