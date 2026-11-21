import { DailyPage } from "@/features/daily/pages/daily-page"
import { latestReportDate } from "@/features/daily/catalog"

export default function DailyIndexPage() {
  return <DailyPage date={latestReportDate()} />
}
