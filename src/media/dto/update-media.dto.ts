import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ContentRating,
  MediaStatus,
  MediaType,
} from '../../../generated/prisma/index.js';

export class UpdateMediaDto {
  @IsOptional()
  @IsEnum(MediaType)
  type?: MediaType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1800)
  @Max(2100)
  year?: number | null;

  @IsOptional()
  @IsEnum(MediaStatus)
  status?: MediaStatus | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  episodeCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  episodesAired?: number | null;

  @IsOptional()
  @IsEnum(ContentRating)
  contentRating?: ContentRating | null;

  @IsOptional()
  @IsBoolean()
  isAdult?: boolean;

  /** When provided, replaces the full genre set. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  genres?: string[];
}
