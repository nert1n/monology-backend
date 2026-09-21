import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import {
  AllExceptionsFilter,
  APP_CONFIG_KEY,
  ensureUploadsDirs,
  LoggingInterceptor,
} from './common/index.js';
import type { AppConfig } from './config/index.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);

  // Volume mount must be /app/uploads (cwd in Docker). Empty volume needs subdirs.
  const uploadsDir = ensureUploadsDirs();
  Logger.log(`Serving static files from ${uploadsDir} at /uploads`, 'Bootstrap');
  app.useStaticAssets(uploadsDir, {
    prefix: '/uploads',
  });

  app.setGlobalPrefix(appConfig.apiPrefix);
  app.enableCors({
    origin: appConfig.corsOrigin,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  await app.listen(appConfig.port, '0.0.0.0');
}

await bootstrap();
