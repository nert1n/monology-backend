import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  ContentRating,
  MediaStatus,
  MediaType,
} from '../../../generated/prisma/index.js';

export const MEDIA_LIST_SORTS = [
  'updatedAt',
  'createdAt',
  'rating',
  'yearDesc',
] as const;
export type MediaListSort = (typeof MEDIA_LIST_SORTS)[number];

export class ListMediaQueryDto {
  @IsOptional()
  @IsEnum(MediaType)
  type?: MediaType;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(MEDIA_LIST_SORTS)
  sort: MediaListSort = 'updatedAt';

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  hasRating?: boolean;

  /** Minimum community average rating (0–10). Implies rated titles only. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  minRating?: number;

  /** Inclusive lower bound on Media.year (null years excluded when set). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1800)
  @Max(2100)
  yearFrom?: number;

  /** Inclusive upper bound on Media.year (null years excluded when set). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1800)
  @Max(2100)
  yearTo?: number;

  /** When true, omit titles with year > current calendar year (null years kept). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  excludeFutureYears?: boolean;

  /** Filter by genre slug. */
  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @IsEnum(MediaStatus)
  status?: MediaStatus;

  @IsOptional()
  @IsEnum(ContentRating)
  contentRating?: ContentRating;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
