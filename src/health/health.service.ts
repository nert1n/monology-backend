import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG_KEY } from '../common/constants/index.js';
import type { AppConfig } from '../config/configuration.js';

export type HealthStatus = {
  status: 'ok';
  uptime: number;
  environment: string;
  timestamp: string;
};

@Injectable()
export class HealthService {
  constructor(private readonly configService: ConfigService) {}

  check(): HealthStatus {
    const app = this.configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);

    return {
      status: 'ok',
      uptime: process.uptime(),
      environment: app.nodeEnv,
      timestamp: new Date().toISOString(),
    };
  }
}
