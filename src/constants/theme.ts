import { ProviderType } from '../models/types';
import { Severity, severityOf } from '../services/capacity';

export { Severity, severityOf } from '../services/capacity';

export const SEVERITY_COLORS = {
  healthy: '#1f9d74',
  warning: '#d97706',
  critical: '#ea580c',
  exhausted: '#dc2626',
  unknown: '#a1a1aa',
} as const;

export const SeverityTokens = {
  healthy: { stroke: '#1f9d74', ink: '#15803d', soft: '#e7f6ec' },
  warning: { stroke: '#d97706', ink: '#b45309', soft: '#fdf3e1' },
  critical: { stroke: '#ea580c', ink: '#c2410c', soft: '#fff1e6' },
  exhausted: { stroke: '#dc2626', ink: '#dc2626', soft: '#fdecec' },
  unknown: { stroke: '#a1a1aa', ink: '#71717a', soft: '#eceae4' },
} as const;

export const Colors = {
  // WCAG compliant dual theme / light theme tokens
  background: '#f8fafc', // slate-50
  backgroundWarm: '#f1f5f9', // slate-100
  card: '#ffffff',
  cardElevated: '#ffffff',
  cardHighlight: '#f1f5f9',
  border: '#cbd5e1', // slate-300
  borderActive: '#0f172a',
  borderSubtle: '#e2e8f0',
  track: '#e2e8f0',

  text: '#0f172a', // slate-900 (>= 4.5:1 contrast)
  textMuted: '#475569', // slate-600 (>= 4.5:1 contrast against white)
  textSubtle: '#64748b', // slate-500
  textDisabled: '#94a3b8',

  ink: '#0f172a',
  inkText: '#ffffff',

  normal: '#16a34a',
  normalSoft: '#e7f6ec',
  warning: '#f59e0b',
  critical: '#f97316',
  exhausted: '#ef4444',
  exhaustedSoft: '#fdecec',
  unavailable: '#a1a1aa',
  ring: '#1f9d74',
  ringBlue: '#3b5bdb',

  claude: {
    primary: '#d97757',
    accent: '#ea580c',
    surface: 'rgba(217, 119, 87, 0.10)',
    border: 'rgba(217, 119, 87, 0.25)',
    glow: 'rgba(217, 119, 87, 0.2)',
    chart: '#d97757',
    chartAlt: '#e89073',
  },
  chatgpt: {
    primary: '#10a37f',
    accent: '#10a37f',
    surface: 'rgba(16, 163, 127, 0.08)',
    border: 'rgba(16, 163, 127, 0.20)',
    glow: 'rgba(16, 163, 127, 0.2)',
    chart: '#10a37f',
    chartAlt: '#2ec59c',
  },
  gemini: {
    primary: '#1a73e8',
    accent: '#3b82f6',
    surface: 'rgba(26, 115, 232, 0.08)',
    border: 'rgba(26, 115, 232, 0.2)',
    glow: 'rgba(26, 115, 232, 0.2)',
    chart: '#1a73e8',
    chartAlt: '#4285f4',
  },
  antigravity: {
    primary: '#4285f4',
    accent: '#8ab4f8',
    surface: 'rgba(66, 133, 244, 0.08)',
    border: 'rgba(66, 133, 244, 0.2)',
    glow: 'rgba(66, 133, 244, 0.2)',
    chart: '#4285f4',
    chartAlt: '#8ab4f8',
  },
  deepseek: {
    primary: '#0066ff',
    accent: '#3385ff',
    surface: 'rgba(0, 102, 255, 0.08)',
    border: 'rgba(0, 102, 255, 0.2)',
    glow: 'rgba(0, 102, 255, 0.2)',
    chart: '#0066ff',
    chartAlt: '#4d94ff',
  },
  qwen: {
    primary: '#615ced',
    accent: '#807cf2',
    surface: 'rgba(97, 92, 237, 0.08)',
    border: 'rgba(97, 92, 237, 0.2)',
    glow: 'rgba(97, 92, 237, 0.2)',
    chart: '#615ced',
    chartAlt: '#8783f5',
  },
  mistral: {
    primary: '#ff7000',
    accent: '#ff8c33',
    surface: 'rgba(255, 112, 0, 0.09)',
    border: 'rgba(255, 112, 0, 0.22)',
    glow: 'rgba(255, 112, 0, 0.2)',
    chart: '#ff7000',
    chartAlt: '#ff944d',
  },
  groq: {
    primary: '#f55036',
    accent: '#f7735e',
    surface: 'rgba(245, 80, 54, 0.09)',
    border: 'rgba(245, 80, 54, 0.22)',
    glow: 'rgba(245, 80, 54, 0.2)',
    chart: '#f55036',
    chartAlt: '#fa806e',
  },
  cursor: {
    primary: '#000000',
    accent: '#3f3f46',
    surface: 'rgba(0, 0, 0, 0.06)',
    border: 'rgba(0, 0, 0, 0.15)',
    glow: 'rgba(0, 0, 0, 0.15)',
    chart: '#27272a',
    chartAlt: '#52525b',
  },
  copilot: {
    primary: '#1f6feb',
    accent: '#388bfd',
    surface: 'rgba(31, 111, 235, 0.08)',
    border: 'rgba(31, 111, 235, 0.2)',
    glow: 'rgba(31, 111, 235, 0.2)',
    chart: '#1f6feb',
    chartAlt: '#79b8ff',
  },
  perplexity: {
    primary: '#20808d',
    accent: '#22b8cf',
    surface: 'rgba(32, 128, 141, 0.09)',
    border: 'rgba(32, 128, 141, 0.22)',
    glow: 'rgba(34, 184, 207, 0.2)',
    chart: '#20808d',
    chartAlt: '#5bc0ce',
  },
  grok: {
    primary: '#18181b',
    accent: '#52525b',
    surface: 'rgba(24, 24, 27, 0.06)',
    border: 'rgba(24, 24, 27, 0.15)',
    glow: 'rgba(24, 24, 27, 0.15)',
    chart: '#27272a',
    chartAlt: '#6b7280',
  },
  poe: {
    primary: '#5d3fd3',
    accent: '#7c5cf0',
    surface: 'rgba(93, 63, 211, 0.09)',
    border: 'rgba(93, 63, 211, 0.22)',
    glow: 'rgba(93, 63, 211, 0.2)',
    chart: '#5d3fd3',
    chartAlt: '#a98bf5',
  },
  custom: {
    primary: '#8b5cf6',
    accent: '#a78bfa',
    surface: 'rgba(139, 92, 246, 0.08)',
    border: 'rgba(139, 92, 246, 0.2)',
    glow: 'rgba(139, 92, 246, 0.2)',
    chart: '#8b5cf6',
    chartAlt: '#c4b5fd',
  },
};

export const PROVIDER_NAMES: Record<ProviderType, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  mistral: 'Mistral',
  groq: 'Groq',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  perplexity: 'Perplexity',
  grok: 'Grok',
  poe: 'Poe',
  custom: 'Other service',
};

export const PROVIDER_COMPANY: Record<ProviderType, string> = {
  claude: 'Anthropic',
  chatgpt: 'OpenAI',
  gemini: 'Google',
  antigravity: 'Google AI',
  deepseek: 'DeepSeek',
  qwen: 'Alibaba Qwen',
  mistral: 'Mistral AI',
  groq: 'Groq',
  cursor: 'Anysphere',
  copilot: 'GitHub',
  perplexity: 'Perplexity',
  grok: 'xAI',
  poe: 'Quora',
  custom: 'Custom endpoint',
};

export const LAB_BRAND_PALETTES: Record<ProviderType, { primary: string; name: string }> = {
  claude: { primary: '#d97757', name: 'Anthropic' },     // Official Terracotta/Coral
  chatgpt: { primary: '#10a37f', name: 'OpenAI' },       // Official Emerald/Teal
  gemini: { primary: '#1a73e8', name: 'Google' },        // Official Google Blue
  antigravity: { primary: '#4285f4', name: 'Google AI' },// Google AI
  deepseek: { primary: '#0066ff', name: 'DeepSeek' },    // DeepSeek Blue
  qwen: { primary: '#615ced', name: 'Alibaba Qwen' },    // Qwen Violet
  mistral: { primary: '#ff7000', name: 'Mistral' },      // Mistral Flame Orange
  groq: { primary: '#f55036', name: 'Groq' },            // Groq Bright Orange
  cursor: { primary: '#000000', name: 'Cursor' },
  copilot: { primary: '#1f6feb', name: 'GitHub Copilot' },
  perplexity: { primary: '#20808d', name: 'Perplexity' },
  grok: { primary: '#18181b', name: 'Grok' },
  poe: { primary: '#5d3fd3', name: 'Poe' },
  custom: { primary: '#8b5cf6', name: 'Custom' },
};

/** Converts a hex color (#rrggbb) to HSL values [h (0-360), s (0-1), l (0-1)]. */
export function hexToHsl(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h = h * 60;
  }
  return [Math.round(h * 10) / 10, Math.round(s * 1000) / 1000, Math.round(l * 1000) / 1000];
}

/** Converts HSL values [h (0-360), s (0-1), l (0-1)] to a hex color (#rrggbb). */
export function hslToHex(h: number, s: number, l: number): string {
  // Normalize h to [0, 360)
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;

  if (0 <= h && h < 60) {
    r = c; g = x; b = 0;
  } else if (60 <= h && h < 120) {
    r = x; g = c; b = 0;
  } else if (120 <= h && h < 180) {
    r = 0; g = c; b = x;
  } else if (180 <= h && h < 240) {
    r = 0; g = x; b = c;
  } else if (240 <= h && h < 300) {
    r = x; g = 0; b = c;
  } else if (300 <= h && h < 360) {
    r = c; g = 0; b = x;
  }

  const toHex = (n: number) => {
    const int = Math.round((n + m) * 255);
    const hex = Math.max(0, Math.min(255, int)).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Deterministic string hash (FNV-1a) to HSL hue [0, 360). */
export function hashStringToHue(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

/**
 * Calculates WCAG relative luminance for an sRGB hex color.
 */
export function getRelativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Computes readable text color (white vs slate-900) for a background color to meet WCAG AA.
 */
export function getAccessibleSegmentTextColor(hexColor: string): '#ffffff' | '#0f172a' {
  const lum = getRelativeLuminance(hexColor);
  // Contrast against white (L=1): (1 + 0.05) / (lum + 0.05)
  // Contrast against slate-900 (#0f172a, lum ~ 0.01): (lum + 0.05) / (0.01 + 0.05)
  const contrastWhite = 1.05 / (lum + 0.05);
  const contrastDark = (lum + 0.05) / 0.06;
  return contrastDark >= contrastWhite ? '#0f172a' : '#ffffff';
}

/**
 * Generates N monochromatic shades for a provider account fleet.
 * Preserves exact hue (+/- 0 deg) and avoids mid-tone contrast dead zones (L=46-54%).
 */
export function getProviderAccountShades(provider: ProviderType | string, accountCount: number): string[] {
  if (accountCount <= 0) return [];
  const palette = LAB_BRAND_PALETTES[provider as ProviderType];
  const primaryHex = palette ? palette.primary : hslToHex(hashStringToHue(provider), 0.7, 0.5);

  if (accountCount === 1) return [primaryHex];

  const [baseH, baseS, baseL] = hexToHsl(primaryHex);

  // If primary is near black/dark monochrome (e.g. Cursor #000000)
  if (baseS < 0.05 && baseL < 0.15) {
    const shades: string[] = [];
    const minL = 0.15;
    const maxL = 0.65;
    for (let i = 0; i < accountCount; i++) {
      let l = minL + (i / (accountCount - 1)) * (maxL - minL);
      if (l >= 0.44 && l <= 0.56) {
        l = l < 0.5 ? 0.43 : 0.57;
      }
      shades.push(hslToHex(0, 0, l));
    }
    return shades;
  }

  const shades: string[] = [];
  // For brand colors, vary lightness across a calibrated band
  const lMin = Math.max(0.22, baseL - 0.20);
  const lMax = Math.min(0.78, baseL + 0.20);

  for (let i = 0; i < accountCount; i++) {
    const t = i / (accountCount - 1);
    let l = lMin + t * (lMax - lMin);
    // Mandatory safeguard: skip / clamp away from [46%, 54%] dead zone for text legibility
    if (l >= 0.44 && l <= 0.56) {
      l = l < 0.5 ? 0.43 : 0.57;
    }
    // Also modulate saturation slightly (higher saturation for lighter tones, preserving purity)
    const s = Math.max(0.35, Math.min(0.95, baseS + (t - 0.5) * 0.1));
    shades.push(hslToHex(baseH, s, l));
  }

  return shades;
}

/** Distinct chart colors per account: provider hue, alternating shade for 2nd+ account. */
export function accountChartColor(providerType: ProviderType, indexWithinProvider: number): string {
  const scheme = Colors[providerType] || Colors.custom;
  return indexWithinProvider % 2 === 0 ? scheme.chart : scheme.chartAlt;
}

/** Ring color by remaining percent, using severity thresholds and colors. */
export function severityColor(remaining: number | null, providerType?: ProviderType): string {
  const sev = severityOf(remaining);
  if (sev === 'healthy' && providerType === 'gemini') {
    return Colors.ringBlue;
  }
  return SEVERITY_COLORS[sev];
}

/** Ring color by remaining percent, as in the mockup (green → orange → red). */
export function remainingColor(remaining: number | null, providerType?: ProviderType): string {
  return severityColor(remaining, providerType);
}

export const Typography = {
  familyMono: 'monospace',
  fontSize: {
    xs: 11,
    sm: 13,
    base: 15,
    lg: 17,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
  },
};

export const Radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 22,
  full: 9999,
};

export const CardShadow = {
  shadowColor: '#3f3a2e',
  shadowOffset: { width: 0, height: 3 },
  shadowOpacity: 0.06,
  shadowRadius: 10,
  elevation: 2,
};
