import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  InterfaceLanguage,
  UserSex,
} from '../../../generated/prisma/index.js';

export class ProfileColorsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @MaxLength(64)
  brand?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @MaxLength(64)
  background?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @MaxLength(64)
  surface?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @MaxLength(64)
  foreground?: string | null;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsBoolean()
  profileHidden?: boolean;

  /** Persona colors for the public profile. Pass null to reset to defaults. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => ProfileColorsDto)
  profileColors?: ProfileColorsDto | null;

  /** Personal site. Pass null or "" to clear. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  websiteUrl?: string | null;

  @IsOptional()
  @IsEnum(UserSex)
  sex?: UserSex;

  /** Full date of birth as YYYY-MM-DD. Pass null to clear. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'dateOfBirth must be YYYY-MM-DD',
  })
  dateOfBirth?: string | null;

  @IsOptional()
  @IsBoolean()
  displayAge?: boolean;

  @IsOptional()
  @IsBoolean()
  displayAdultContent?: boolean;

  @IsOptional()
  @IsEnum(InterfaceLanguage)
  interfaceLanguage?: InterfaceLanguage;
}
