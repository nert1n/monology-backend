import { BadRequestException } from '@nestjs/common';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse YYYY-MM-DD into a UTC midnight Date. */
export function parseDateOnly(value: string): Date {
  const match = DATE_ONLY.exec(value.trim());
  if (!match) {
    throw new BadRequestException('dateOfBirth must be YYYY-MM-DD');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestException('dateOfBirth is not a valid calendar date');
  }
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (date.getTime() > todayUtc) {
    throw new BadRequestException('dateOfBirth cannot be in the future');
  }
  if (year < 1900) {
    throw new BadRequestException('dateOfBirth year must be 1900 or later');
  }
  return date;
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeAge(dateOfBirth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())
  ) {
    age -= 1;
  }
  return Math.max(0, age);
}
