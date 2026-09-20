export type AppConfig = {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
  /** `true` = reflect request origin; string/array = explicit allowlist. */
  corsOrigin: string | string[] | boolean;
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

/**
 * Normalize one CORS origin: strip trailing slash; add https:// if scheme missing
 * (bare hosts like `monology.vercel.app` never match browser Origin).
 * Leaves `http://localhost…` alone when the scheme is already present.
 */
function normalizeCorsOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/$/, '');
  if (!trimmed || trimmed === '*') {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/** Parse CORS_ORIGIN: `*` → true, comma-separated URLs → array, single URL → string. */
function parseCorsOrigin(
  raw: string | undefined,
): string | string[] | boolean {
  if (raw === undefined || raw.trim() === '') {
    return true;
  }
  const value = raw.trim();
  if (value === '*') {
    return true;
  }
  const parts = value
    .split(',')
    .map((part) => normalizeCorsOrigin(part))
    .filter(Boolean);
  if (parts.length === 0) {
    return true;
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return parts;
}

function firstHttpOrigin(corsOrigin: string | string[] | boolean): string | null {
  if (typeof corsOrigin === 'string' && corsOrigin.startsWith('http')) {
    return corsOrigin;
  }
  if (Array.isArray(corsOrigin)) {
    const found = corsOrigin.find((origin) => origin.startsWith('http'));
    return found ?? null;
  }
  return null;
}

export default (): {
  app: AppConfig;
  jwt: JwtConfig;
  google: GoogleConfig;
} => {
  const corsOrigin = parseCorsOrigin(process.env.CORS_ORIGIN);
  const primaryFrontend = firstHttpOrigin(corsOrigin);

  return {
    app: {
      nodeEnv: process.env.NODE_ENV ?? 'development',
      port: Number(process.env.PORT ?? 3000),
      apiPrefix: process.env.API_PREFIX ?? 'api',
      corsOrigin,
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
        (primaryFrontend
          ? `${primaryFrontend.replace(/\/$/, '')}/settings/profile`
          : 'http://localhost:5173/settings/profile'),
    },
  };
};
