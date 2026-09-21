# syntax=docker/dockerfile:1

FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs prisma generate — needs schema + a DATABASE_URL fallback
ENV DATABASE_URL="postgresql://postgres:postgres@localhost:5432/monology?schema=public"
RUN bun install --frozen-lockfile

FROM oven/bun:1.4-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="postgresql://postgres:postgres@localhost:5432/monology?schema=public"
RUN bunx prisma generate && bun run build

FROM oven/bun:1.4-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Writable media root. On Railway mount a Volume at /app/uploads (same path).
ENV UPLOADS_DIR=/app/uploads
RUN apk add --no-cache openssl libc6-compat \
  && mkdir -p /app/uploads/avatars /app/uploads/backgrounds /app/uploads/media

COPY package.json bun.lock ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/generated ./generated

EXPOSE 3000
# Railway injects PORT; Nest reads process.env.PORT
CMD ["bun", "run", "start:prod"]
