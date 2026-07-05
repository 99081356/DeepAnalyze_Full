import { useUIStore } from '../store/ui';

export function useToast() {
  const addToast = useUIStore((s) => s.addToast);

  return {
    success: (message: string) => addToast('success', message),
    error: (message: string) => addToast('error', message),
    warning: (message: string) => addToast('warning', message),
    info: (message: string) => addToast('info', message),
  };
}
