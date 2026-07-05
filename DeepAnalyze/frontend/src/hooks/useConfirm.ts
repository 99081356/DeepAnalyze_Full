import { useUIStore } from '../store/ui';

export function useConfirm() {
  const showConfirm = useUIStore((s) => s.showConfirm);

  return async (options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
  }): Promise<boolean> => {
    return showConfirm(options);
  };
}
