type KnownAspectRatio = {
  aspect_ratio: string;
  name: string;
};

export const KNOWN_ASPECT_RATIOS: KnownAspectRatio[] = [
  { aspect_ratio: '16:9', name: 'Widescreen' },
  { aspect_ratio: '1:1', name: 'Square' },
  { aspect_ratio: '4:3', name: 'Standard' },
  { aspect_ratio: '9:16', name: 'Portrait' },
  { aspect_ratio: '21:9', name: 'Ultrawide' },
  { aspect_ratio: '3:2', name: 'Classic' },
  { aspect_ratio: '5:4', name: 'SXGA' },
  { aspect_ratio: '32:9', name: 'Super Ultrawide' },
];

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x || 1;
}

export function resolveAspectRatio(input: {
  aspect_ratio?: string | null;
  width?: number | null;
  height?: number | null;
}): string | null {
  if (input.aspect_ratio?.trim()) {
    return input.aspect_ratio.trim();
  }

  if (!input.width || !input.height || input.width <= 0 || input.height <= 0) {
    return null;
  }

  const ratio = input.width / input.height;
  const knownMatch = KNOWN_ASPECT_RATIOS.find((entry) => {
    const [w, h] = entry.aspect_ratio.split(':').map(Number);
    return Math.abs(ratio - w / h) <= 0.03;
  });

  if (knownMatch) {
    return knownMatch.aspect_ratio;
  }

  const divisor = gcd(input.width, input.height);
  return `${input.width / divisor}:${input.height / divisor}`;
}

export function getAspectRatioName(aspectRatio: string | null): string | null {
  if (!aspectRatio) return null;
  return KNOWN_ASPECT_RATIOS.find((entry) => entry.aspect_ratio === aspectRatio)?.name ?? 'Custom';
}
