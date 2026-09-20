import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CategoryKind,
  ItemStatus,
  MediaType,
} from '../../../generated/prisma/index.js';

const LEGACY_STATUS_MAP: Record<string, ItemStatus> = {
  completed: ItemStatus.DONE,
  watching: ItemStatus.IN_PROGRESS,
  dropped: ItemStatus.DROPPED,
  cancelled: ItemStatus.DROPPED,
  planned: ItemStatus.PLANNED,
  paused: ItemStatus.PAUSED,
  on_hold: ItemStatus.PAUSED,
  done: ItemStatus.DONE,
  watched: ItemStatus.DONE,
  in_progress: ItemStatus.IN_PROGRESS,
};

/** Map renamed vocabulary onto canonical ItemStatus. */
const LEGACY_ENUM_MAP: Record<string, ItemStatus> = {
  WATCHING: ItemStatus.IN_PROGRESS,
  WATCHED: ItemStatus.DONE,
  CANCELLED: ItemStatus.DROPPED,
};

function toItemStatus(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const upper = trimmed.toUpperCase().replace(/-/g, '_');
  if ((Object.values(ItemStatus) as string[]).includes(upper)) {
    return upper;
  }
  if (LEGACY_ENUM_MAP[upper]) {
    return LEGACY_ENUM_MAP[upper];
  }
  return LEGACY_STATUS_MAP[trimmed.toLowerCase()] ?? trimmed;
}

function toMediaType(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const upper = trimmed.toUpperCase();
  if ((Object.values(MediaType) as string[]).includes(upper)) {
    return upper;
  }
  const legacy: Record<string, MediaType> = {
    anime: MediaType.ANIME,
    movie: MediaType.MOVIE,
    film: MediaType.MOVIE,
    serial: MediaType.SERIAL,
    tv: MediaType.SERIAL,
    series: MediaType.SERIAL,
    book: MediaType.BOOK,
    manga: MediaType.BOOK,
    hentai: MediaType.HENTAI,
  };
  return legacy[trimmed.toLowerCase()] ?? trimmed;
}

export class ImportListEntryDto {
  @IsOptional()
  @IsString()
  mediaId?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => toMediaType(value))
  @IsEnum(MediaType)
  type?: MediaType;

  @IsOptional()
  @IsInt()
  @Min(1800)
  @Max(2100)
  year?: number | null;

  @IsOptional()
  @Transform(({ value }) => toItemStatus(value))
  @IsEnum(ItemStatus)
  status?: ItemStatus;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  rating?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  categorySlug?: string;

  @IsOptional()
  @IsEnum(CategoryKind)
  categoryKind?: CategoryKind;

  @IsOptional()
  @IsDateString()
  completedAt?: string | null;

  /** Shikimori / nert1n-style fields (optional compatibility). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  target_title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  target_title_ru?: string | null;

  @IsOptional()
  @Transform(({ value }) => toMediaType(value))
  @IsEnum(MediaType)
  target_type?: MediaType;

  @IsOptional()
  @IsNumber()
  score?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string | null;
}

export class ImportListsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsArray()
  @ArrayMaxSize(20_000)
  @ValidateNested({ each: true })
  @Type(() => ImportListEntryDto)
  lists!: ImportListEntryDto[];
}
