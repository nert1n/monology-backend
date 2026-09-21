# Миграция локальной БД → Railway Postgres

Текущие локальные данные лежат в **SQLite**:

| Что | Путь |
|-----|------|
| База | `prisma/dev.db` (~28 MB) |
| Медиа-файлы | `uploads/` (avatars, backgrounds, media) — **отдельно от БД** |

В `.env` сейчас `DATABASE_URL="file:./dev.db"`. На Railway схема уже **PostgreSQL** (`prisma migrate deploy` при деплое). Нужно перелить **данные**, не миграции Prisma.

Скрипт: `scripts/migrate-sqlite-to-postgres.ts` (Bun). По умолчанию — **dry-run** (ничего не пишет в Postgres).

---

## Важно перед стартом

1. **Wipe vs merge**
   - `--wipe` — `TRUNCATE` всех таблиц приложения на целевой БД, потом импорт. Для **пустого** или «можно снести» prod.
   - без `--wipe` — `createMany({ skipDuplicates: true })`: существующие id не трогаются. Не «умное» слияние полей.
2. **Схема на Railway** должна уже быть применена (успешный deploy / `prisma migrate deploy`). Скрипт **не** копирует `_prisma_migrations`.
3. **`uploads/`** в дамп не входят. Скопируй volume отдельно (см. ниже), иначе аватары/обложки с путями `/uploads/...` сломаются.
4. **Не коммить** `tmp/sqlite-export.json` и любые дампы — там хеши паролей и персональные данные.
5. Скрипт **сам** не ходит в prod без `--apply` и без явного `TARGET_DATABASE_URL`.
6. Если URL/пароль светился в чате или логах — **сразу** смени credentials в Railway (Settings → Variables / regenerate `POSTGRES_PASSWORD`) и обнови `DATABASE_URL`.

---

## Шаг 1. Экспорт локального SQLite (безопасно)

```bash
cd /home/maksim/Projects/personal/monology-backend

bun run scripts/migrate-sqlite-to-postgres.ts --export-only
# → tmp/sqlite-export.json
```

Или через npm-скрипт:

```bash
bun run db:export-sqlite
```

Проверь counts в логе (User / Media / Item / …).

---

## Шаг 2. Взять **публичный** Railway URL

С ноутбука **нельзя** использовать internal host `postgres.railway.internal` — он резолвится только внутри сети Railway.

### В UI Railway

1. Открой сервис **Postgres** (plugin).
2. **Settings → Networking** (иногда «Public Networking»).
3. Включи **TCP Proxy** / **Public Networking**, если ещё не включено.
4. Запомни host вида `*.proxy.rlwy.net` и порт (например `25188`).
5. **Variables** → скопируй **Public** / `DATABASE_PUBLIC_URL` (или Connect → Public URL).  
   Не бери internal `DATABASE_URL` с `*.railway.internal` для локального скрипта.

### CLI

```bash
railway variables --service Postgres   # или PostgreSQL
# либо:
railway connect Postgres
```

Публичный URL обычно выглядит так:

```text
postgresql://postgres:***@xxx.proxy.rlwy.net:PORT/railway
```

Скрипт сам допишет `?sslmode=require` для хостов `*.rlwy.net`, если параметра ещё нет. Вручную тоже можно:

```bash
export TARGET_DATABASE_URL='postgresql://postgres:***@xxx.proxy.rlwy.net:PORT/railway?sslmode=require'
```

Не вставляй URL в git / чаты / скриншоты.

---

## Шаг 3. Dry-run импорта (план)

```bash
TARGET_DATABASE_URL='postgresql://…' \
  bun run scripts/migrate-sqlite-to-postgres.ts \
  --from-export tmp/sqlite-export.json
# без --apply → только план
```

---

## Шаг 4. Импорт (ты сам запускаешь)

### Вариант A — чистый prod (wipe)

```bash
TARGET_DATABASE_URL='postgresql://…' \
  bun run scripts/migrate-sqlite-to-postgres.ts \
  --from-export tmp/sqlite-export.json \
  --apply --wipe
```

### Вариант B — дописать, не трогая существующие id

```bash
TARGET_DATABASE_URL='postgresql://…' \
  bun run scripts/migrate-sqlite-to-postgres.ts \
  --from-export tmp/sqlite-export.json \
  --apply
```

Прямо из SQLite без JSON (тоже ок):

```bash
TARGET_DATABASE_URL='postgresql://…' \
  bun run scripts/migrate-sqlite-to-postgres.ts --apply --wipe
```

### Вариант C — миграция **из Railway** (обход локальной сети / DNS)

Если с ноутбука `Can't reach database server` (файрвол ISP, DNS-hijack, блокировка исходящего порта proxy):

1. Залей `tmp/sqlite-export.json` в окружение backend (или примонтируй).
2. One-off shell / linked service с **internal** `DATABASE_URL`:

```bash
# из корня backend, с railway link
railway run --service backend -- \
  bun run scripts/migrate-sqlite-to-postgres.ts \
  --from-export tmp/sqlite-export.json --apply --wipe
```

Внутри Railway `DATABASE_URL` уже указывает на `postgres.railway.internal` — публичный TCP Proxy не нужен.  
Либо `railway ssh --service backend` и запусти ту же команду с `TARGET_DATABASE_URL="$DATABASE_URL"`.

---

## Шаг 5. Залить `uploads/` на Railway volume

Volume на **backend** (Nest API), mount `/app/uploads`.  
**Не** `railway link` на Postgres и **не** заливай в `postgres-volume`. Нужен SSH-ключ: `railway ssh keys add`.

**Полная инструкция (только картинки + recovery):** [sync-uploads-to-railway.md](./sync-uploads-to-railway.md)

Кратко:

```bash
cd /home/maksim/Projects/personal/monology-backend
railway login && railway link   # выбрать backend, НЕ Postgres
railway status && railway volume list && railway ssh keys
railway ssh --service monology-backend -- echo ok   # если Timeout — VPN/DNS
bun run sync:uploads:upload
# SFTP Timeout → см. sync-uploads-to-railway.md §0c
```

Без файлов URL вроде `/uploads/media/...` в БД останутся, но картинки 404.

**Если SFTP падает (`Failed to initialize SFTP session` / Timeout):** сначала CDN для обложек (без ~1 GB):

```bash
TARGET_DATABASE_URL='postgresql://…proxy.rlwy.net:PORT/railway?sslmode=require' \
  bun run rewrite:shiki-covers-cdn --apply
# avatars/backgrounds без SFTP:
bun run sync:uploads:ssh-pipe -- --only avatars,backgrounds
```

Полная инструкция: [sync-uploads-to-railway.md](./sync-uploads-to-railway.md) (§0c SFTP Timeout, §2 CDN, §3 SSH pipe).

---

## Если локально уже Postgres (не твой текущий случай)

Сейчас локально SQLite. Если позже перейдёшь на `docker compose` Postgres:

```bash
# dump
pg_dump --no-owner --no-acl "$LOCAL_DATABASE_URL" > /tmp/monology.dump.sql

# restore на Railway (DESTRUCTIVE для существующих данных в public)
psql "$TARGET_DATABASE_URL" -f /tmp/monology.dump.sql
```

Лучше для «полной замены»:

```bash
pg_dump --format=custom --no-owner --no-acl "$LOCAL_DATABASE_URL" -f /tmp/monology.dump
pg_restore --clean --if-exists --no-owner --no-acl -d "$TARGET_DATABASE_URL" /tmp/monology.dump
```

Не коммить `.sql` / `.dump`.

---

## Проверка после импорта

```bash
curl -s https://<api-host>/api/health
# логин тем же пользователем, что локально
# обложки / аватар — только после копирования uploads/
```

---

## Troubleshooting

| Симптом | Что проверить |
|---------|----------------|
| `Can't reach database server at …proxy.rlwy.net:PORT` | См. ниже: DNS ISP, TCP Proxy, порт, файрвол |
| `Need a Postgres TARGET_DATABASE_URL` | В `.env` всё ещё `file:./dev.db` — передай Railway URL явно |
| FK / enum errors | Сначала `prisma migrate deploy` на Railway |
| Дубликаты при merge | Ожидаемо: `skipDuplicates` пропускает те же id |
| Картинки 404 | Не залит `uploads/` на volume |
| Connection refused / timeout на internal host | С локальной машины нужен **public** proxy URL, не `postgres.railway.internal` |
| SSL / `SSL connection required` | Добавь `?sslmode=require` (скрипт делает это для `*.rlwy.net`) |

### `Can't reach … proxy.rlwy.net` — чеклист

**1. TCP Proxy включён**

Postgres → **Settings → Networking** → **TCP Proxy / Public Networking** = On.  
В Variables должен быть **Public** URL (`*.proxy.rlwy.net` + выделенный порт), не только internal.

**2. Берёшь именно Public URL и актуальный порт**

Порт после включения proxy случайный (не `5432`). Если пересоздавал proxy — порт мог смениться; скопируй URL заново.

**3. DNS провайдера подменяет Railway (частая причина в UA)**

Проверка (без паролей):

```bash
HOST=iriguchi.proxy.rlwy.net   # свой host из URL
PORT=25188                     # свой порт

# что видит система
getent ahosts "$HOST"

# что должны видеть публичные DNS
dig +short @1.1.1.1 "$HOST" A
dig +short @8.8.8.8 "$HOST" A
```

Если системный IP ≠ Cloudflare/Google (например, резолвится в IP своего ISP вроде `*.astra.in.ua`), браузер/Bun ходят «не туда» → TCP timeout. Фикс:

- DNS на машине/роутере: `1.1.1.1` / `8.8.8.8` (или DoH), **или**
- VPN, **или**
- импорт через **Вариант C** (`railway run` / SSH) с internal `DATABASE_URL`.

Быстрая проверка порта на **правильном** IP:

```bash
REAL_IP=$(dig +short @1.1.1.1 "$HOST" A | head -n1)
nc -vz -w 5 "$REAL_IP" "$PORT"
# succeeded = proxy жив; timeout на системном IP при ok на REAL_IP = проблема DNS/ISP
```

**4. Исходящий порт режется локальной сетью**

Корп. Wi‑Fi / некоторые ISP режут нестандартные порты. Тогда снова Вариант C (миграция из Railway).

**5. SSL**

Для public Railway URL нужен TLS. Скрипт добавляет `sslmode=require` для `*.rlwy.net`. Без SSL обычно другая ошибка (не «Can't reach»), но параметр всё равно обязателен для Prisma/pg.
