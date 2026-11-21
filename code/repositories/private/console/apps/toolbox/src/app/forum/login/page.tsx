"use client"

import { Terminal } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { useAuthStore } from "@/features/forum/stores/auth"

export default function ForumLoginPage() {
  const router = useRouter()
  const { currentUser, login, logout } = useAuthStore()
  const [username, setUsername] = useState("")
  const [error, setError] = useState("")

  const submit = () => {
    if (username.trim().length < 2) {
      setError("用户名至少 2 个字符")
      return
    }
    login(username)
    router.push("/forum")
  }

  return (
    <div className="mx-auto mt-10 max-w-sm">
      <div className="space-y-6 rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Terminal className="size-6" />
          </span>
          <h1 className="text-lg font-semibold">
            {currentUser ? "已登录" : "登录 ggbdpq 论坛"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {currentUser
              ? `当前账号：${currentUser.nickname}`
              : "本地演示账号体系，输入任意用户名即可登录"}
          </p>
        </div>

        {currentUser ? (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              logout()
            }}
          >
            退出当前账号
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="username" className="text-sm font-medium">
                用户名
              </label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit()
                }}
                placeholder="输入你的昵称"
                autoFocus
              />
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <Button className="w-full" onClick={submit}>
              登录
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
