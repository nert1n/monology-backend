import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Writable uploads root.
 * Docker/Railway: WORKDIR is `/app`, volume should mount at `/app/uploads`
 * (or set `UPLOADS_DIR` to that mount path).
 */
export function uploadsRoot(): string {
  const fromEnv = process.env.UPLOADS_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd(), 'uploads');
}

export function uploadsSubdir(
  ...segments: Array<'avatars' | 'backgrounds' | 'media' | string>
): string {
  return path.join(uploadsRoot(), ...segments);
}

/** Ensure avatars / backgrounds / media exist (empty Railway volume hides Dockerfile mkdir). */
export function ensureUploadsDirs(): string {
  const root = uploadsRoot();
  for (const sub of ['avatars', 'backgrounds', 'media'] as const) {
    mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}
