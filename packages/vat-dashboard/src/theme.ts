// 主题系统: 深/浅色 + 主色(accent) 预设, localStorage 持久化
export type ThemeName = 'dark' | 'light';

export interface AccentPreset {
  id: string;
  name: string;
  color: string;
}

export const ACCENTS: AccentPreset[] = [
  { id: 'bronze', name: '古铜金', color: '#c5a059' },
  { id: 'azure', name: '天青蓝', color: '#4f9cf0' },
  { id: 'emerald', name: '翡翠绿', color: '#43c59e' },
  { id: 'violet', name: '罗兰紫', color: '#9b7be0' },
  { id: 'rose', name: '霞光粉', color: '#e07a9b' },
  { id: 'amber', name: '琥珀橙', color: '#e0913f' },
];

const STORE_KEY = 'vat-dashboard-theme';

export interface ThemePref {
  theme: ThemeName;
  accent: string;
}

export function getThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ThemePref>;
      if (p.theme === 'dark' || p.theme === 'light') {
        return { theme: p.theme, accent: p.accent ?? ACCENTS[0].color };
      }
    }
  } catch {
    /* ignore */
  }
  return { theme: 'dark', accent: ACCENTS[0].color };
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', pref.theme);
  root.style.setProperty('--accent', pref.accent);
  root.style.setProperty('--accent-soft', hexToRgba(pref.accent, 0.35));
  root.style.setProperty('--accent-faint', hexToRgba(pref.accent, 0.12));
}

export function saveThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pref));
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}
