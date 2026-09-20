import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service.js';
import { APP_CONFIG_KEY } from '../common/constants/index.js';

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              if (key === APP_CONFIG_KEY) {
                return { nodeEnv: 'test' };
              }
              throw new Error(`Unknown key: ${key}`);
            },
          },
        },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  it('returns ok status', () => {
    const result = service.check();
    expect(result.status).toBe('ok');
    expect(result.environment).toBe('test');
    expect(typeof result.uptime).toBe('number');
  });
});
