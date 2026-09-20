export type AppConfig = {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
  corsOrigin: string | boolean;
};

export type JwtConfig = {
  secret: string;
  expiresIn: string;
};

export type GoogleConfig = {
  clientId: string | null;
  clientSecret: string | null;
  callbackUrl: string;
  /** Frontend URL to land on after OAuth (success or error query). */
  frontendRedirectUrl: string;
};

export default (): {
  app: AppConfig;
  jwt: JwtConfig;
  google: GoogleConfig;
} => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    corsOrigin: process.env.CORS_ORIGIN ?? true,
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || null,
    callbackUrl:
      process.env.GOOGLE_CALLBACK_URL?.trim() ||
      'http://localhost:3000/api/auth/google/callback',
    frontendRedirectUrl:
      process.env.GOOGLE_FRONTEND_REDIRECT?.trim() ||
      (typeof process.env.CORS_ORIGIN === 'string' &&
      process.env.CORS_ORIGIN.startsWith('http')
        ? `${process.env.CORS_ORIGIN.replace(/\/$/, '')}/settings/profile`
        : 'http://localhost:5173/settings/profile'),
  },
});
