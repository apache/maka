import { Link } from 'react-router'

export default function NotFound() {
  return (
    <div className="grid h-full place-items-center p-10 text-center">
      <div className="space-y-2">
        <p className="text-3xl font-semibold">404</p>
        <p className="text-sm text-muted-foreground">这个页面没有做——或者从来没存在过。</p>
        <Link to="/" className="text-sm underline underline-offset-4">
          回概览
        </Link>
      </div>
    </div>
  )
}
