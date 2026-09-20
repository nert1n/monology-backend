import "dotenv/config";
import { defineConfig } from "prisma/config";

// Fallback lets `prisma generate` / postinstall succeed in CI without a .env.
// Runtime still requires a real DATABASE_URL via Nest ConfigModule.
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/monology?schema=public";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    url: databaseUrl,
  },
});
