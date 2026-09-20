import { plainToInstance } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export class EnvironmentVariables {
  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @IsString()
  API_PREFIX?: string;

  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  JWT_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  ADMIN_EMAIL?: string;

  /** Google OAuth — optional; without both ID+secret, Connect uses a stub. */
  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CALLBACK_URL?: string;

  @IsOptional()
  @IsString()
  GOOGLE_FRONTEND_REDIRECT?: string;
}

/** Required in every environment (local `.env` or Railway Variables). */
const REQUIRED_ENV_HINTS: Record<string, string> = {
  DATABASE_URL:
    'Set on Railway Variables to ${{Postgres.DATABASE_URL}} (service name must match your Postgres plugin).',
  JWT_SECRET:
    'Set a long random string on Railway Variables (never commit the real value).',
};

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const lines = errors.flatMap((error) => {
      const constraints = Object.values(error.constraints ?? {});
      const hint = REQUIRED_ENV_HINTS[error.property];
      const detail =
        constraints.length > 0
          ? constraints.join(', ')
          : 'failed validation';
      return hint
        ? [`- ${error.property}: ${detail}`, `  → ${hint}`]
        : [`- ${error.property}: ${detail}`];
    });

    throw new Error(
      [
        'EnvironmentVariables validation failed.',
        'Fix missing/invalid vars on the Railway service Variables tab (or local .env):',
        ...lines,
        'See DEPLOY.md § Backend environment variables.',
      ].join('\n'),
    );
  }

  return validated;
}
