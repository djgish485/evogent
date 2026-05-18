import { type CSSProperties } from 'react';

export const OLED_MIN_VISIBLE_CHANNEL_DELTA = 5;

export const CONVERSATION_CARD_BASE_RGB = [5, 5, 5] as const;

export const SESSION_TINT_BG_ALPHA = 0.14;

export const CURATOR_CURATE_BUTTON_BASE_CLASS_NAME = 'group inline-flex min-h-8 shrink-0 flex-col items-center justify-center rounded-xl border py-1.5 text-[11px] font-semibold leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_0_rgba(0,0,0,0.28)] transition hover:brightness-125 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:flex-row sm:gap-1.5 sm:px-2 sm:py-0 sm:pr-3 sm:text-[13px] sm:whitespace-nowrap';

export const CURATOR_CURATE_FULL_LABEL_MIN_ROW_WIDTH = 250;

export const CURATOR_CURATE_HEADER_FULL_LABEL_MIN_ROW_WIDTH = 340;

export const CURATOR_CURATE_COMMANDS = [
  { command: '/curate', label: 'Curate', mobileLabel: 'Curate' },
  { command: '/curate-latest', label: 'Curate Latest', mobileLabel: 'Latest' },
] as const;

export type RgbColor = readonly [number, number, number];

export function rgb(color: RgbColor): string {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

export function rgba(color: RgbColor, alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}

export function blendTintOverSurface(
  color: RgbColor,
  alpha: number,
  surface: RgbColor = CONVERSATION_CARD_BASE_RGB,
): RgbColor {
  return [
    Math.round(surface[0] + (color[0] - surface[0]) * alpha),
    Math.round(surface[1] + (color[1] - surface[1]) * alpha),
    Math.round(surface[2] + (color[2] - surface[2]) * alpha),
  ] as const;
}

export function ensureVisibleOnOled(color: RgbColor, label: string): void {
  if (color.some((channel) => channel < OLED_MIN_VISIBLE_CHANNEL_DELTA)) {
    throw new Error(`${label} is too close to #000000 for OLED surfaces`);
  }
}

export function createSessionTint(
  name: string,
  color: RgbColor,
  text: string,
): {
  name: string;
  swatch: string;
  bg: string;
  border: string;
  icon: string;
  iconBorder: string;
  text: string;
} {
  const composedBackground = blendTintOverSurface(color, SESSION_TINT_BG_ALPHA);
  ensureVisibleOnOled(
    composedBackground,
    `${name} session card background`,
  );

  return {
    name,
    swatch: rgb(color),
    bg: rgb(composedBackground),
    border: rgba(color, 0.22),
    icon: rgba(color, 0.18),
    iconBorder: rgba(color, 0.3),
    text,
  };
}

export const SESSION_TINT_PALETTE = [
  createSessionTint('blue', [59, 130, 246], '#93c5fd'),
  createSessionTint('purple', [168, 85, 247], '#c4b5fd'),
  createSessionTint('teal', [20, 184, 166], '#5eead4'),
  createSessionTint('amber', [245, 158, 11], '#fcd34d'),
  createSessionTint('rose', [244, 63, 94], '#fda4af'),
  createSessionTint('green', [34, 197, 94], '#86efac'),
  createSessionTint('indigo', [99, 102, 241], '#a5b4fc'),
  createSessionTint('pink', [236, 72, 153], '#f9a8d4'),
] as const;

export type SessionTint = typeof SESSION_TINT_PALETTE[number];

export function getSessionTint(sessionId: string, storedColor?: string | null): SessionTint {
  const explicitTint = typeof storedColor === 'string'
    ? SESSION_TINT_PALETTE.find((tint) => tint.name === storedColor.trim().toLowerCase())
    : null;
  if (explicitTint) {
    return explicitTint;
  }

  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
  }
  return SESSION_TINT_PALETTE[Math.abs(hash) % SESSION_TINT_PALETTE.length];
}

export function getCuratorCurateButtonStyle(tint: SessionTint | undefined): CSSProperties {
  const resolvedTint = tint ?? SESSION_TINT_PALETTE[3];
  return {
    background: `linear-gradient(180deg, ${resolvedTint.icon} 0%, ${resolvedTint.bg} 100%)`,
    borderColor: resolvedTint.iconBorder,
    color: '#fff',
  };
}

export function getCuratorCurateButtonIconStyle(tint: SessionTint | undefined): CSSProperties {
  const resolvedTint = tint ?? SESSION_TINT_PALETTE[3];
  return {
    backgroundColor: resolvedTint.icon,
    borderColor: resolvedTint.iconBorder,
    color: resolvedTint.text,
  };
}
