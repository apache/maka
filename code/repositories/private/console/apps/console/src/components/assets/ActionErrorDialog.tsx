import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ggbdpq/console-ui';
import { Button } from '@ggbdpq/console-ui';

export interface ActionErrorState {
  title: string;
  message: string;
  detail?: string | null;
}

export function ActionErrorDialog({
  error,
  onClose,
}: {
  error: ActionErrorState | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={error !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{error?.title ?? '接口错误'}</DialogTitle>
          <DialogDescription>{error?.message}</DialogDescription>
        </DialogHeader>
        {error?.detail && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-destructive">
            {error.detail}
          </pre>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>知道了</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
