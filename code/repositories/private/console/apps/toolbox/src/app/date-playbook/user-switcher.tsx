"use client";
import { DEMO_USERS, useDatePlaybookSession } from "@/stores/date-playbook";

export function UserSwitcher() {
  const { currentUserId, setUser } = useDatePlaybookSession();

  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm">
      <span className="text-muted-foreground">演示身份（模拟双方）：</span>
      {DEMO_USERS.map((u) => (
        <button
          key={u.id}
          type="button"
          onClick={() => setUser(u.id)}
          className={`rounded-full px-3 py-1 text-xs transition-colors ${
            currentUserId === u.id
              ? "bg-primary text-primary-foreground"
              : "border text-muted-foreground hover:bg-accent"
          }`}
        >
          {u.name}
        </button>
      ))}
    </div>
  );
}
