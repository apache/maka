import type { ReactNode } from "react"
import { AdminGate } from "@/features/admin/admin-shell"

export const metadata = {
  title: "后台",
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminGate>{children}</AdminGate>
}
