"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { authStore } from "@/features/admin/auth-store"
import { loginAdmin, adminErrorMessage } from "@/features/admin/admin-client"
import { loginRequestSchema } from "@/features/admin/schemas"
import { useAdminLocale } from "@/features/admin/locale-store"

const copy = {
  "zh-CN": {
    title: "登录后台",
    hint: "演示账号 admin / admin123，也可试 manager / viewer",
    username: "用户名",
    password: "密码",
    submit: "登录",
  },
  "en-US": {
    title: "Sign in",
    hint: "Seed accounts: admin / admin123, plus manager and viewer",
    username: "Username",
    password: "Password",
    submit: "Sign in",
  },
}

export function AdminLoginPage() {
  const router = useRouter()
  const locale = useAdminLocale((state) => state.locale)
  const text = copy[locale]
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    authStore.getState().hydrateFromStorage()
    if (authStore.getState().accessToken) router.replace("/admin")
    setHydrated(true)
  }, [router])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try {
      const credentials = loginRequestSchema.parse({
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
      })
      authStore.getState().setSession(await loginAdmin(credentials))
      router.push("/admin")
    } catch (caught) {
      setError(adminErrorMessage(caught, locale))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm items-center px-4 py-10">
      <form onSubmit={handleSubmit} className="w-full rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">{text.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{text.hint}</p>
        <label className="mt-5 block text-sm font-medium" htmlFor="username">
          {text.username}
          <Input id="username" name="username" autoComplete="username" className="mt-1" defaultValue="admin" />
        </label>
        <label className="mt-3 block text-sm font-medium" htmlFor="password">
          {text.password}
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="mt-1"
            defaultValue="admin123"
          />
        </label>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="mt-4 w-full" disabled={pending || !hydrated}>
          {text.submit}
        </Button>
      </form>
    </div>
  )
}
