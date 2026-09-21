#!/usr/bin/env bun
/**
 * Sync local uploads/ → Railway volume (media / avatars / backgrounds).
 *
 * Preferred: `railway volume files upload` (directory upload, concurrent).
 * Does NOT upload by default — prints commands unless --upload / --ssh-pipe
 * is passed and `railway` is logged in.
 *
 * If SFTP times out (`Failed to initialize SFTP session`):
 *   1) bun run rewrite:shiki-covers-cdn --apply  (covers without ~1GB upload)
 *   2) --ssh-pipe  (tar | railway ssh tar — bypasses SFTP)
 *
 * WARNINGS:
 *   - `railway link` must target the Nest backend/API service — NOT Postgres.
 *   - Volume must be on the backend at mount /app/uploads.
 *   - Never upload into postgres-volume (DB data, Nest does not serve it).
 *   - `volume files upload` needs a Railway SSH key (`railway ssh keys add`).
 *   - CLI has no non-SFTP volume transfer; use --ssh-pipe or hosted tar + curl.
 *
 * Usage:
 *   bun run scripts/sync-uploads-to-railway.ts
 *   bun run scripts/sync-uploads-to-railway.ts --pack
 *   bun run scripts/sync-uploads-to-railway.ts --pack-test
 *   bun run scripts/sync-uploads-to-railway.ts --upload
 *   bun run scripts/sync-uploads-to-railway.ts --upload --only media
 *   bun run scripts/sync-uploads-to-railway.ts --upload --dry-run
 *   bun run scripts/sync-uploads-to-railway.ts --ssh-pipe --only avatars,backgrounds
 *
 * See scripts/sync-uploads-to-railway.md
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UPLOADS = path.join(ROOT, 'uploads');
const PACK_DIR = process.env.UPLOADS_PACK_DIR?.trim() || tmpdir();

const SUBDIRS = ['avatars', 'backgrounds', 'media'] as const;
type Subdir = (typeof SUBDIRS)[number];

type Args = {
  pack: boolean;
  packTest: boolean;
  upload: boolean;
  sshPipe: boolean;
  dryRun: boolean;
  only: Subdir[] | null;
  concurrency: number;
  testMediaLimit: number;
  help: boolean;
};

const RAILWAY_SERVICE = process.env.RAILWAY_SERVICE?.trim() || 'monology-backend';

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pack: false,
    packTest: false,
    upload: false,
    sshPipe: false,
    dryRun: false,
    only: null,
    concurrency: 32,
    testMediaLimit: 5,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--pack') args.pack = true;
    else if (a === '--pack-test') args.packTest = true;
    else if (a === '--upload') args.upload = true;
    else if (a === '--ssh-pipe') args.sshPipe = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--only') {
      const raw = argv[++i];
      if (!raw) throw new Error('--only needs a value (media,avatars,backgrounds)');
      const parts = raw.split(',').map((s) => s.trim()) as Subdir[];
      for (const p of parts) {
        if (!SUBDIRS.includes(p)) {
          throw new Error(`Unknown --only segment: ${p}`);
        }
      }
      args.only = parts;
    } else if (a === '--concurrency') {
      args.concurrency = Number(argv[++i] ?? 32);
    } else if (a === '--test-media-limit') {
      args.testMediaLimit = Number(argv[++i] ?? 5);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function dirStats(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        files += 1;
        bytes += st.size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function selectedSubdirs(args: Args): Subdir[] {
  return args.only ?? [...SUBDIRS];
}

function printVolumeReminder() {
  console.log(`
Volume layout (Railway):
  Mount path on **backend** service (NOT Postgres): /app/uploads
  Volume root "/" == container /app/uploads
  So local uploads/media/foo.jpg → remote /media/foo.jpg

Nest serves process.cwd()/uploads (WORKDIR /app) at GET /uploads/...

WARNINGS:
  - railway link / service link → Nest backend/API — never Postgres
  - Do NOT upload to postgres-volume
  - railway volume files upload needs SSH: railway ssh keys add
  - After volume create: wait for backend redeploy before SFTP
  - SFTP Timeout → VPN/DNS or use CDN rewrite / --ssh-pipe (see .md §0c)
`);
}

function printCommands(subs: Subdir[], concurrency: number) {
  console.log('=== Preferred: railway volume files upload ===\n');
  console.log('Prereqs:');
  console.log('  railway login');
  console.log('  cd ' + ROOT);
  console.log(
    '  railway link   # monology project + **backend** service (NOT Postgres)',
  );
  console.log('  railway status # confirm Service = backend/API, Online');
  console.log('  railway volume list');
  console.log(
    '  # If backend has no volume: railway volume add --mount-path /app/uploads',
  );
  console.log('  # wait for redeploy after volume add');
  console.log('  # SSH key (required for volume files / railway ssh):');
  console.log(
    '  #   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519   # if no ~/.ssh/*.pub',
  );
  console.log(
    '  #   railway ssh keys add --key ~/.ssh/id_ed25519.pub --name laptop',
  );
  console.log('  railway ssh keys');
  console.log(`  railway ssh --service ${RAILWAY_SERVICE} -- echo ok`);
  console.log('');
  console.log(
    'When prompted for a volume: pick the **backend** uploads volume — NEVER postgres-volume.\n',
  );
  for (const sub of subs) {
    console.log(
      `railway volume files upload ./uploads/${sub} /${sub} --overwrite --concurrency ${concurrency}`,
    );
  }
  console.log('');
  console.log('Smoke test (one file):');
  console.log('  SAMPLE=$(ls uploads/media | head -1)');
  console.log(
    '  railway volume files upload "./uploads/media/$SAMPLE" "/media/$SAMPLE" --overwrite',
  );
  console.log(
    '  curl -sI "https://monology-backend-production.up.railway.app/uploads/media/$SAMPLE"',
  );
  console.log('');
  console.log(
    '=== If SFTP Timeout: CDN rewrite FIRST (no ~1GB upload) ===\n',
  );
  console.log(
    '  TARGET_DATABASE_URL=\'postgresql://…proxy.rlwy.net:PORT/railway?sslmode=require\' \\',
  );
  console.log('    bun run rewrite:shiki-covers-cdn --apply');
  console.log('  # or (if railway run injects DATABASE_URL):');
  console.log(
    `  railway run --service ${RAILWAY_SERVICE} -- bun run rewrite:shiki-covers-cdn --apply`,
  );
  console.log('');
  console.log('=== Fallback without SFTP: tar | railway ssh (pipe) ===\n');
  console.log(
    '  bun run scripts/sync-uploads-to-railway.ts --ssh-pipe --only avatars,backgrounds',
  );
  console.log(
    '  bun run scripts/sync-uploads-to-railway.ts --ssh-pipe --only media',
  );
  console.log('  # manual:');
  console.log(
    `  tar -czf - -C . uploads/avatars | railway ssh --service ${RAILWAY_SERVICE} -- tar -xzf - -C /app`,
  );
  console.log('');
  console.log('=== Fallback: hosted tar + curl inside container ===\n');
  console.log('  bun run sync:uploads:pack');
  console.log('  # host monology-uploads.tgz over HTTPS, then:');
  console.log(
    `  railway ssh --service ${RAILWAY_SERVICE} -- bash -lc 'curl -fL "$URL" -o /tmp/u.tgz && tar -xzf /tmp/u.tgz -C /app && rm -f /tmp/u.tgz'`,
  );
  console.log('');
  console.log('=== Fallback: tar + SFTP upload + ssh extract ===\n');
  console.log('  bun run scripts/sync-uploads-to-railway.ts --pack');
  console.log(
    `  railway volume files upload ${path.join(PACK_DIR, 'monology-uploads.tgz')} /monology-uploads.tgz --overwrite`,
  );
  console.log(
    `  railway ssh --service ${RAILWAY_SERVICE} -- tar -xzf /app/uploads/monology-uploads.tgz -C /app`,
  );
  console.log(
    `  railway ssh --service ${RAILWAY_SERVICE} -- rm -f /app/uploads/monology-uploads.tgz`,
  );
  console.log('');
  console.log('=== If still blocked ===\n');
  console.log(
    '  Dashboard → backend service → Volumes / Console file browser',
  );
  console.log('  Or later: S3 / Railway Bucket (separate app change)');
  console.log(
    '  Recovery after linking Postgres by mistake: see scripts/sync-uploads-to-railway.md §5',
  );
  console.log(
    '  SFTP Timeout details: scripts/sync-uploads-to-railway.md §0c',
  );
}

async function packUploads(opts: {
  test: boolean;
  testMediaLimit: number;
  subs: Subdir[];
}): Promise<string> {
  const outName = opts.test
    ? 'monology-uploads-test.tgz'
    : 'monology-uploads.tgz';
  const outPath = path.join(PACK_DIR, outName);

  // Prefer system tar (fast, preserves structure as uploads/...)
  const includeArgs: string[] = [];
  for (const sub of opts.subs) {
    if (sub === 'media' && opts.test) {
      const mediaDir = path.join(UPLOADS, 'media');
      const names = readdirSync(mediaDir)
        .filter((n) => statSync(path.join(mediaDir, n)).isFile())
        .slice(0, opts.testMediaLimit);
      for (const n of names) {
        includeArgs.push(path.join('uploads', 'media', n));
      }
    } else {
      includeArgs.push(path.join('uploads', sub));
    }
  }

  console.log(`Packing → ${outPath}`);
  console.log(`  entries: ${includeArgs.join(', ')}`);

  const result = spawnSync(
    'tar',
    ['-czf', outPath, '-C', ROOT, ...includeArgs],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`tar failed with status ${result.status}`);
  }

  const size = statSync(outPath).size;
  console.log(`Packed ${humanSize(size)} → ${outPath}`);
  console.log('(Do not commit this archive.)');
  return outPath;
}

function runRailwayUpload(
  localDir: string,
  remoteDir: string,
  concurrency: number,
  dryRun: boolean,
) {
  const cmd = [
    'volume',
    'files',
    'upload',
    localDir,
    remoteDir,
    '--overwrite',
    '--concurrency',
    String(concurrency),
  ];
  console.log(`$ railway ${cmd.join(' ')}`);
  if (dryRun) return 0;
  const result = spawnSync('railway', cmd, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

function runSshPipe(subs: Subdir[], dryRun: boolean): Promise<number> {
  const includeArgs: string[] = [];
  for (const sub of subs) {
    const local = path.join(UPLOADS, sub);
    if (!existsSync(local)) {
      console.warn(`Skip missing ${local}`);
      continue;
    }
    includeArgs.push(path.join('uploads', sub));
  }
  if (includeArgs.length === 0) {
    throw new Error('Nothing to pipe — no matching uploads/ subdirs');
  }

  const tarArgs = ['-czf', '-', '-C', ROOT, ...includeArgs];
  const sshArgs = [
    'ssh',
    '--service',
    RAILWAY_SERVICE,
    '--',
    'tar',
    '-xzf',
    '-',
    '-C',
    '/app',
  ];

  console.log(`$ tar ${tarArgs.join(' ')} | railway ${sshArgs.join(' ')}`);
  console.log(
    `(Bypasses SFTP. Confirm first: railway ssh --service ${RAILWAY_SERVICE} -- echo ok)\n`,
  );
  if (dryRun) return Promise.resolve(0);

  return new Promise((resolve, reject) => {
    const tar = spawn('tar', tarArgs, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const ssh = spawn('railway', sshArgs, {
      cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    tar.on('error', reject);
    ssh.on('error', reject);

    tar.stdout!.pipe(ssh.stdin!);

    let tarCode: number | null = null;
    let sshCode: number | null = null;
    const maybeDone = () => {
      if (tarCode === null || sshCode === null) return;
      if (tarCode !== 0) {
        reject(new Error(`tar failed with status ${tarCode}`));
        return;
      }
      resolve(sshCode);
    };

    tar.on('close', (code) => {
      tarCode = code ?? 1;
      // Close ssh stdin when tar ends (EOF for remote tar)
      ssh.stdin?.end();
      maybeDone();
    });
    ssh.on('close', (code) => {
      sshCode = code ?? 1;
      maybeDone();
    });
  });
}

function ensureRailwayReady(): void {
  const who = spawnSync('railway', ['whoami'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (who.status !== 0 || /Unauthorized|login/i.test(who.stdout + who.stderr)) {
    throw new Error(
      'railway CLI not logged in. Run: railway login && railway link (backend service, NOT Postgres)',
    );
  }
  console.log(`
Before upload, confirm:
  railway status          # Service = backend/API, not Postgres; Online after volume mount
  railway volume list     # backend volume mount = /app/uploads
  railway ssh keys        # at least one key (else: railway ssh keys add)
  railway ssh --service ${RAILWAY_SERVICE} -- echo ok
  When picking a volume: NEVER postgres-volume
  If SFTP Timeout: bun run rewrite:shiki-covers-cdn --apply  OR  --ssh-pipe
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: bun run scripts/sync-uploads-to-railway.ts [options]

Sync local uploads/ to the Railway **backend** volume (NOT Postgres).

WARNINGS:
  - railway link must select the Nest backend/API service — never Postgres
  - Volume must be on the backend at mount path /app/uploads
  - Never upload into postgres-volume
  - volume files upload needs an SSH key:
      ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
      railway ssh keys add --key ~/.ssh/id_ed25519.pub --name laptop
  - After volume create: wait for backend redeploy; SFTP may Timeout otherwise
  - SFTP Timeout → VPN/DNS, or: bun run rewrite:shiki-covers-cdn --apply
    then --ssh-pipe (tar over SSH, no SFTP)
  - If you linked Postgres by mistake: railway unlink -s -y && railway link
    then railway volume add --mount-path /app/uploads on the backend
  - Full recovery steps: scripts/sync-uploads-to-railway.md §5

Options:
  --pack                 Create tmp/monology-uploads.tgz from uploads/
  --pack-test            Small archive (avatars+backgrounds+N media files)
  --upload               Run railway volume files upload for each subdir
  --ssh-pipe             Stream tar over railway ssh (bypasses SFTP)
  --dry-run              Print commands only (with --upload / --ssh-pipe)
  --only media,avatars   Limit subdirs
  --concurrency 32       Parallel uploads for directory mode
  --test-media-limit 5   Media files included in --pack-test

Package scripts:
  bun run sync:uploads
  bun run sync:uploads:upload
  bun run sync:uploads:pack
  bun run sync:uploads:ssh-pipe
  bun run rewrite:shiki-covers-cdn
`);
    return;
  }

  if (!existsSync(UPLOADS)) {
    throw new Error(`Missing ${UPLOADS}`);
  }

  const subs = selectedSubdirs(args);
  console.log('Local uploads inventory:\n');
  let totalBytes = 0;
  let totalFiles = 0;
  for (const sub of SUBDIRS) {
    const st = dirStats(path.join(UPLOADS, sub));
    totalBytes += st.bytes;
    totalFiles += st.files;
    const mark = subs.includes(sub) ? '*' : ' ';
    console.log(
      `  ${mark} ${sub.padEnd(12)} ${String(st.files).padStart(6)} files  ${humanSize(st.bytes)}`,
    );
  }
  console.log(
    `    ${'TOTAL'.padEnd(12)} ${String(totalFiles).padStart(6)} files  ${humanSize(totalBytes)}`,
  );
  printVolumeReminder();

  if (args.pack || args.packTest) {
    await packUploads({
      test: args.packTest,
      testMediaLimit: args.testMediaLimit,
      subs,
    });
  }

  if (args.sshPipe) {
    ensureRailwayReady();
    console.log(
      args.dryRun
        ? 'Dry-run: would ssh-pipe:\n'
        : 'Streaming uploads via railway ssh (no SFTP)…\n',
    );
    const code = await runSshPipe(subs, args.dryRun);
    if (code !== 0) {
      throw new Error(`railway ssh-pipe failed (exit ${code})`);
    }
    console.log('\nDone. Verify with:');
    console.log(
      '  SAMPLE=$(ls uploads/media | head -1); curl -sI "https://monology-backend-production.up.railway.app/uploads/media/$SAMPLE"',
    );
    console.log(
      '  Cover-shiki 404s without media: bun run rewrite:shiki-covers-cdn --apply',
    );
    return;
  }

  if (args.upload) {
    ensureRailwayReady();
    console.log(
      args.dryRun
        ? 'Dry-run: would upload:\n'
        : 'Uploading to Railway volume (this may take a while for ~1GB+):\n',
    );
    for (const sub of subs) {
      const local = path.join(UPLOADS, sub);
      if (!existsSync(local)) {
        console.warn(`Skip missing ${local}`);
        continue;
      }
      const code = runRailwayUpload(
        local,
        `/${sub}`,
        args.concurrency,
        args.dryRun,
      );
      if (code !== 0) {
        throw new Error(
          `railway upload failed for ${sub} (exit ${code}). ` +
            'If SFTP Timeout: see sync-uploads-to-railway.md §0c — ' +
            'try bun run rewrite:shiki-covers-cdn --apply and/or --ssh-pipe',
        );
      }
    }
    console.log('\nDone. Verify with:');
    console.log(
      '  SAMPLE=$(ls uploads/media | head -1); curl -sI "https://monology-backend-production.up.railway.app/uploads/media/$SAMPLE"',
    );
    return;
  }

  printCommands(subs, args.concurrency);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
