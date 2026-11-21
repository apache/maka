import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** 全局 Toast（sonner）。接入暗色主题后把 theme 接到你的 ThemeProvider 即可 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="top-center"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: 'rounded-lg',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
