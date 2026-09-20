import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  OptionalCurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import { CategoriesService } from './categories.service.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { ListCategoryItemsQueryDto } from './dto/list-category-items-query.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

@Controller()
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get('users/:username/categories')
  @UseGuards(OptionalJwtAuthGuard)
  listByUsername(
    @Param('username') username: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.categoriesService.listByUsername(username, viewer?.userId);
  }

  @Get('users/:username/items')
  @UseGuards(OptionalJwtAuthGuard)
  listItemsByUsername(
    @Param('username') username: string,
    @Query() query: ListCategoryItemsQueryDto,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.categoriesService.listItemsByUsername(
      username,
      query,
      viewer?.userId,
    );
  }

  @Get('users/:username/categories/:slug')
  @UseGuards(OptionalJwtAuthGuard)
  getByUsernameAndSlug(
    @Param('username') username: string,
    @Param('slug') slug: string,
    @Query() query: ListCategoryItemsQueryDto,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.categoriesService.getByUsernameAndSlug(
      username,
      slug,
      query,
      viewer?.userId,
    );
  }

  @Post('categories')
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(user.userId, dto);
  }

  @Patch('categories/:id')
  @UseGuards(JwtAuthGuard)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(user.userId, id, dto);
  }

  @Delete('categories/:id')
  @UseGuards(JwtAuthGuard)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.categoriesService.remove(user.userId, id);
  }
}
