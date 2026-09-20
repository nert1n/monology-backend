import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ItemStatus } from '../../../generated/prisma/index.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const ITEM_LIST_SORTS = ['updatedAt', 'createdAt', 'rating'] as const;
export type ItemListSort = (typeof ITEM_LIST_SORTS)[number];

export class ListCategoryItemsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ItemStatus)
  status?: ItemStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(ITEM_LIST_SORTS)
  sort: ItemListSort = 'updatedAt';

  /** Inclusive lower bound on Item.year (null years excluded when set). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1800)
  @Max(2100)
  yearFrom?: number;

  /** Inclusive upper bound on Item.year (null years excluded when set). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1800)
  @Max(2100)
  yearTo?: number;
}
