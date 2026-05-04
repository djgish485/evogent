type RgbColor = readonly [number, number, number];

const OLED_MIN_VISIBLE_CHANNEL_DELTA = 5;
// Thread item cards sit on a #050505 surface; keep this duplicated with chat-card tinting.
const THREAD_CARD_BASE_RGB = [5, 5, 5] as const;
const THREAD_CARD_BG_ALPHA = 0.14;

export type ThreadTint = {
  name: string;
  bg: string;
  border: string;
  itemBorder: string;
  swatch: string;
  text: string;
};

function rgb(color: RgbColor): string {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function rgba(color: RgbColor, alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}

function blendTintOverSurface(
  color: RgbColor,
  alpha: number,
  surface: RgbColor = THREAD_CARD_BASE_RGB,
): RgbColor {
  return [
    Math.round(surface[0] + (color[0] - surface[0]) * alpha),
    Math.round(surface[1] + (color[1] - surface[1]) * alpha),
    Math.round(surface[2] + (color[2] - surface[2]) * alpha),
  ] as const;
}

function ensureVisibleOnOled(color: RgbColor, label: string): void {
  if (color.some((channel) => channel < OLED_MIN_VISIBLE_CHANNEL_DELTA)) {
    throw new Error(`${label} is too close to #000000 for OLED surfaces`);
  }
}

function createThreadTint(
  name: string,
  color: RgbColor,
  text: string,
): ThreadTint {
  const composedBackground = blendTintOverSurface(color, THREAD_CARD_BG_ALPHA);
  ensureVisibleOnOled(
    composedBackground,
    `${name} thread card background`,
  );

  return {
    name,
    swatch: rgb(color),
    bg: rgb(composedBackground),
    border: rgba(color, 0.45),
    itemBorder: rgba(color, 0.22),
    text,
  };
}

const THREAD_TINT_DEFINITIONS = [
  ['blue', [59, 130, 246], '#93c5fd'],
  ['purple', [168, 85, 247], '#c4b5fd'],
  ['teal', [20, 184, 166], '#5eead4'],
  ['amber', [245, 158, 11], '#fcd34d'],
  ['rose', [244, 63, 94], '#fda4af'],
  ['green', [34, 197, 94], '#86efac'],
  ['indigo', [99, 102, 241], '#a5b4fc'],
  ['pink', [236, 72, 153], '#f9a8d4'],
  ['cyan', [6, 182, 212], '#67e8f9'],
  ['lime', [132, 204, 22], '#bef264'],
  ['fuchsia', [217, 70, 239], '#f0abfc'],
  ['orange', [249, 115, 22], '#fdba74'],
] as const satisfies readonly (readonly [string, RgbColor, string])[];

export const THREAD_COLOR_KEYS: readonly string[] = THREAD_TINT_DEFINITIONS.map(([name]) => name);

export const THREAD_COLOR_PALETTE: Record<string, ThreadTint> = Object.fromEntries(
  THREAD_TINT_DEFINITIONS.map(([name, color, text]) => [
    name,
    createThreadTint(name, color, text),
  ]),
);

export function sanitizeThreadColor(color: string | null | undefined): string | null {
  if (typeof color !== 'string') {
    return null;
  }

  const key = color.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(THREAD_COLOR_PALETTE, key) ? key : null;
}

export function pickNextThreadColor(existingCounts: Record<string, number>): string {
  let selected = THREAD_COLOR_KEYS[0] ?? 'blue';
  let selectedCount = Number.POSITIVE_INFINITY;

  for (const key of THREAD_COLOR_KEYS) {
    const rawCount = existingCounts[key];
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount)
      ? Math.max(0, Math.floor(rawCount))
      : 0;

    if (count < selectedCount) {
      selected = key;
      selectedCount = count;
    }
  }

  return selected;
}
