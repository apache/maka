import Link from "next/link";

const TABS = [
  { href: "/date-playbook", label: "地点库" },
  { href: "/date-playbook/plans", label: "约会计划" },
  { href: "/date-playbook/couple", label: "我们" },
  { href: "/date-playbook/stage", label: "阶段" },
  { href: "/date-playbook/timeline", label: "时间线" },
  { href: "/date-playbook/family-tree", label: "家庭树" },
  { href: "/date-playbook/memories", label: "回忆" },
  { href: "/date-playbook/archive", label: "档案" },
];

export function SpaceNav({ active }: { active: string }) {
  return (
    <nav className="mb-6 flex flex-wrap gap-1.5 border-b pb-4">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            active === tab.href
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
