import { useUIStore, type ThemeMode } from '../store/ui';

export function useTheme() {
  const themeMode = useUIStore((s) => s.themeMode);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);
  const setThemeMode = useUIStore((s) => s.setThemeMode);

  const toggleTheme = () => {
    if (resolvedTheme === 'light') {
      setThemeMode('dark');
    } else {
      setThemeMode('light');
    }
  };

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
  };

  return {
    themeMode,
    resolvedTheme,
    isDark: resolvedTheme === 'dark',
    isLight: resolvedTheme === 'light',
    toggleTheme,
    setTheme,
  };
}
