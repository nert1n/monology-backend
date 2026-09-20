import { BadRequestException } from '@nestjs/common';

export const PROFILE_COLOR_KEYS = [
  'brand',
  'background',
  'surface',
  'foreground',
] as const;

export type ProfileColorKey = (typeof PROFILE_COLOR_KEYS)[number];

export type ProfileColors = Partial<Record<ProfileColorKey, string>>;

const HEX_COLOR =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Safe subset of CSS oklch() — numbers/percent only, no nested functions. */
const OKLCH_COLOR =
  /^oklch\(\s*(?:\d*\.?\d+%?|\.\d+%?)\s+(?:\d*\.?\d+|\.\d+)\s+(?:\d*\.?\d+|\.\d+)(?:\s*\/\s*(?:\d*\.?\d+%?|\.\d+%?))?\s*\)$/i;

export function isValidCssColor(value: string): boolean {
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) || OKLCH_COLOR.test(trimmed);
}

export function normalizeCssColor(value: string): string {
  return value.trim();
}

/**
 * Validates and normalizes a profileColors payload.
 * Returns null when resetting to site defaults (empty / all-null object).
 */
export function parseProfileColors(input: unknown): ProfileColors | null {
  if (input === null) {
    return null;
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('profileColors must be an object or null');
  }

  const record = input as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !PROFILE_COLOR_KEYS.includes(key as ProfileColorKey),
  );
  if (unknownKeys.length > 0) {
    throw new BadRequestException(
      `Unknown profileColors keys: ${unknownKeys.join(', ')}`,
    );
  }

  const result: ProfileColors = {};

  for (const key of PROFILE_COLOR_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') {
      throw new BadRequestException(`profileColors.${key} must be a string`);
    }
    const normalized = normalizeCssColor(value);
    if (!isValidCssColor(normalized)) {
      throw new BadRequestException(
        `profileColors.${key} must be a hex (#rgb/#rrggbb) or oklch() color`,
      );
    }
    result[key] = normalized;
  }

  return Object.keys(result).length === 0 ? null : result;
}

export function readProfileColors(value: unknown): ProfileColors | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const result: ProfileColors = {};

  for (const key of PROFILE_COLOR_KEYS) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const normalized = normalizeCssColor(raw);
    if (isValidCssColor(normalized)) {
      result[key] = normalized;
    }
  }

  return Object.keys(result).length === 0 ? null : result;
}
