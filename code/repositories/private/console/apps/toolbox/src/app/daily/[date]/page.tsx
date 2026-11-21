import { DailyPage } from "@/features/daily/pages/daily-page"
import { listReports } from "@/features/daily/catalog"

export function generateStaticParams() {
  return listReports().map((report) => ({ date: report.date }))
}

export default async function DailyDatePage({
  params,
}: {
  params: Promise<{ date: string }>
}) {
  const { date } = await params
  return <DailyPage date={date} />
}
