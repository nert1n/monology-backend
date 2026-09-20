import { IsBoolean, IsOptional } from 'class-validator';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsBoolean()
  profileHidden?: boolean;
}
