import { avatarInitials } from "@/features/forum/lib/format";
import { cn } from "@ggbdpq/console-ui";
import type { User } from "@/features/forum/schemas/forum";

interface UserAvatarProps {
  user: Pick<User, "nickname" | "color">;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  xs: "size-5 text-[9px]",
  sm: "size-7 text-[11px]",
  md: "size-10 text-sm",
  lg: "size-14 text-lg",
};

/** 纯 CSS 渐变首字母头像，无外部图片依赖 */
export function UserAvatar({ user, size = "md", className }: UserAvatarProps) {
  return (
    <div
      aria-label={user.nickname}
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white shadow-inner", // style:ok 白字挂在下方用户数据色渐变上，静态 token 无法表达
        sizeClasses[size],
        className,
      )}
      style={{
        background: `linear-gradient(135deg, ${user.color}, ${user.color}cc 60%, ${user.color}88)`,
      }}
    >
      {avatarInitials(user.nickname)}
    </div>
  );
}
