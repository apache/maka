import { Link } from 'react-router';
import { House } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  return (
    <div className="bg-background flex h-screen flex-col items-center justify-center gap-6">
      <p className="text-muted-foreground/30 text-[120px] leading-none font-black select-none">
        404
      </p>
      <p className="text-muted-foreground -mt-4 text-sm">页面不存在，或没有访问权限</p>
      <Button asChild>
        <Link to="/dashboard">
          <House />
          回到首页
        </Link>
      </Button>
    </div>
  );
}
