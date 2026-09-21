# Sync `uploads/` → Railway (только картинки)

**RU:** залить локальные медиа на volume **бэкенда (Nest API)**, **без** повторного импорта БД.  
**EN:** copy local `uploads/` to the Railway **backend** volume only — not the database.

Локально: `~/Projects/personal/monology-backend/uploads` (~1.2 GB, в основном `media/`).  
Прод API: `https://monology-backend-production.up.railway.app`  
Статика: Nest отдаёт `GET /uploads/...` из writable dir (по умолчанию `/app/uploads`).

---

## ⚠️ Критично: какой сервис и какой volume

| Делай | Не делай |
|-------|----------|
| `railway link` / `railway service link` → сервис **backend / API / Nest** | Выбирать сервис **Postgres** |
| Volume на **backend**, mount `/app/uploads` | Лить файлы в **`postgres-volume`** |
| При upload выбирать volume бэкенда (имя вроде `monology-backend-volume`) | Игнорировать mount path Postgres |

Postgres volume хранит данные БД. Медиа Nest туда не читает. Если при `railway link` или `railway volume add` выбран Postgres — volume окажется не там, а upload в `postgres-volume` бесполезен (и опасен для данных БД).

Проверка перед upload:

```bash
railway status          # Service = backend/API, НЕ Postgres
railway volume list     # volume привязан к backend, mount = /app/uploads
```

---

## 0. Volume на Railway (backend)

Backend service → **Volumes** → mount path:

```text
/app/uploads
```

CLI (сервис уже должен быть **backend**):

```bash
railway volume add --mount-path /app/uploads
# или явно:
# railway volume add --service <backend-service-name> --mount-path /app/uploads
```

| Контейнер | Volume root | Локальный файл |
|-----------|-------------|----------------|
| `/app/uploads/media/foo.jpg` | `/media/foo.jpg` | `./uploads/media/foo.jpg` |

Пустой volume перекрывает `mkdir` из Dockerfile — Nest при старте создаёт `avatars/`, `backgrounds/`, `media/` сам (`ensureUploadsDirs`).

**После `volume add` дождись редеплоя backend** (status Online, новый deployment). SFTP к volume часто падает, пока контейнер ещё поднимается.

Проверка сейчас (ожидаемо **404**, пока файлов нет):

```bash
SAMPLE=$(ls uploads/media | head -1)
curl -sI "https://monology-backend-production.up.railway.app/uploads/media/$SAMPLE"
# после синка: HTTP/2 200 + image/*
```

---

## 0b. SSH-ключи для `railway volume files` / `railway ssh`

`railway volume files upload` и `railway volume browse` ходят по **SFTP** через Railway SSH. Без ключа CLI падает с:

```text
No SSH keys found
```

(или предлагает сгенерировать ключ и повторить).

### Исправление

```bash
# 1) Локальный ключ (если нет ~/.ssh/*.pub)
ssh-keygen -t ed25519 -C "railway-$(hostname)" -f ~/.ssh/id_ed25519
# Enter без passphrase OK для личного ноутбука; иначе задай passphrase

# 2) Зарегистрировать публичный ключ в Railway
railway login
railway ssh keys add --key ~/.ssh/id_ed25519.pub --name "laptop"
# или интерактивно: railway ssh keys add

# 3) Проверка
railway ssh keys
railway ssh --service monology-backend -- echo ok
# ожидаемо: строка ok (и warning про railway.toml — не ошибка)
```

Альтернативы регистрации:

- `railway ssh keys github` — импорт ключей из GitHub;
- первый `railway ssh` сам предложит зарегистрировать локальный ключ.

Ключи лежат на **диске** в `~/.ssh/*.pub`. Только agent (1Password / ForwardAgent без `.pub` на диске) CLI часто не видит — экспортируй `.pub` в `~/.ssh/` или укажи `-i` где поддерживается.

Документация: [railway ssh](https://docs.railway.com/cli/ssh), [railway volume](https://docs.railway.com/cli/volume).

---

## 0c. SFTP Timeout (`Failed to initialize SFTP session`)

Типичный лог при уже правильном link/volume/ключе:

```text
railway volume files upload ... /avatars
Select volume: monology-backend-volume
Failed to initialize SFTP session
Caused by: Timeout
```

Это **сеть/сессия SFTP**, не «не тот volume». Часто те же ISP/DNS проблемы, что и у Postgres public proxy (см. `migrate-local-to-railway.md`).

### Что сделать по порядку

1. **Дождись редеплоя** после `volume add` / attach. `railway status` → backend ● Online.
2. **Проверь SSH отдельно** (тот же канал ключей, другой протокол):

   ```bash
   railway ssh --service monology-backend -- echo ok
   ```

   - Если `ok` — SSH жив; SFTP может всё равно таймаутить. Иди в **§2 (CDN rewrite)** или **§3b (tar по SSH)**.
   - Если SSH тоже Timeout / hang — **VPN** или DNS `1.1.1.1` / `8.8.8.8` (как для Postgres proxy), потом retry.
3. **Retry** через 1–2 минуты; иногда помогает снизить concurrency: `--concurrency 4`.
4. CLI **не** умеет заливать volume без SFTP (`volume files *` = SFTP). Обход: CDN rewrite + SSH pipe/curl (§2–§3).

| Симптом | Вывод |
|---------|--------|
| Ключ есть, volume верный, SFTP Timeout | Жди redeploy → retry → VPN → §2 CDN |
| `railway ssh … echo ok` тоже Timeout | VPN / DNS (как Postgres proxy) |
| `echo ok` проходит, SFTP нет | Используй §2 + §3b (SSH pipe), не жди SFTP |

---

## 1. Предпочтительный способ: `railway volume files upload`

CLI умеет заливать **директорию** с concurrency (не нужен tar на 1 GB, если канал стабильный).

```bash
cd /home/maksim/Projects/personal/monology-backend

railway login
railway link          # project + **backend** service (НЕ Postgres)
railway status
railway volume list   # volume на backend, mount = /app/uploads
railway ssh keys      # должен быть хотя бы один ключ
railway ssh --service monology-backend -- echo ok

# инвентарь + команды
bun run sync:uploads

# маленький smoke-test (один файл)
SAMPLE=$(ls uploads/media | head -1)
# при выборе volume — ТОЛЬКО volume бэкенда, НЕ postgres-volume
railway volume files upload "./uploads/media/$SAMPLE" "/media/$SAMPLE" --overwrite
curl -sI "https://monology-backend-production.up.railway.app/uploads/media/$SAMPLE"

# полный синг (долго, ~1.2 GB)
bun run sync:uploads:upload
# или по частям:
bun run scripts/sync-uploads-to-railway.ts --upload --only avatars,backgrounds
bun run scripts/sync-uploads-to-railway.ts --upload --only media --concurrency 16
```

Эквивалент вручную:

```bash
railway volume files upload ./uploads/avatars /avatars --overwrite --concurrency 32
railway volume files upload ./uploads/backgrounds /backgrounds --overwrite --concurrency 32
railway volume files upload ./uploads/media /media --overwrite --concurrency 16
```

`--overwrite` обновляет уже существующие имена. Агент **не** заливает 1.2 GB за тебя — нужен `railway login` у тебя на машине.

Если сразу `Failed to initialize SFTP session` / Timeout → **не** гоняй 1 GB. Переходи к §2.

---

## 2. Если SFTP падает: CDN rewrite (рекомендуемый быстрый путь)

~95 % локальных обложек — `cover-shiki{ID}-…`. Их можно вернуть на CDN Shikimori **в Postgres на Railway**, **не** заливая ~1 GB `media/`:

```bash
cd /home/maksim/Projects/personal/monology-backend

# dry-run (TARGET_DATABASE_URL = public Postgres proxy + sslmode=require)
TARGET_DATABASE_URL='postgresql://…proxy.rlwy.net:PORT/railway?sslmode=require' \
  bun run rewrite:shiki-covers-cdn

# применить
TARGET_DATABASE_URL='…' bun run rewrite:shiki-covers-cdn --apply
# или:
# TARGET_DATABASE_URL='…' bun run scripts/rewrite-shiki-covers-to-cdn.ts --apply
```

Если public proxy таймаутит (DNS/ISP) — **VPN** / DNS `1.1.1.1`, затем снова локально с `TARGET_DATABASE_URL`.  
В прод-образе **нет** `scripts/` (только `dist/`), поэтому `railway ssh … bun run scripts/rewrite-…` не сработает — только локальный Bun + public proxy (или `railway run` с переменными сервиса, если CLI прокидывает `DATABASE_URL`).

```bash
# вариант с railway run (если link = backend и DATABASE_URL доступен в окружении команды):
railway run --service monology-backend -- bun run rewrite:shiki-covers-cdn --apply
```

**Что это чинит:** `Media.coverUrl` с префиксом `/uploads/media/cover-shiki…` → `https://shikimori.io/system/animes/original/{id}.jpg`.

**Что всё равно нужно залить** (маленькие каталоги / остатки), когда SFTP или SSH pipe заработает:

- `avatars/`, `backgrounds/`
- `MediaPhoto` (`photo-shiki*`)
- non-shiki обложки (IMDb и т.п.)

CDN rewrite — **главный** ответ на «обложки 404», пока SFTP Timeout. Полный media sync — потом.

---

## 3. Fallback без SFTP (файлы на volume)

Railway CLI **не** даёт альтернативы `volume files upload` кроме SFTP. Если SSH жив — используй его.

### 3a. Диагностика SSH

```bash
railway ssh --service monology-backend -- echo ok
```

Ожидаемо: `ok`. Если Timeout — VPN/DNS (§0c), иначе §3b/§3c бесполезны.

### 3b. Tar по SSH pipe (обходит SFTP)

Поток `tar | railway ssh tar` **не** использует SFTP. Подходит, когда `echo ok` проходит, а `volume files upload` — Timeout.

```bash
cd /home/maksim/Projects/personal/monology-backend

# только маленькие каталоги (быстро)
bun run scripts/sync-uploads-to-railway.ts --ssh-pipe --only avatars,backgrounds

# полный media (~1GB) — долго; не гоняй через агента
bun run scripts/sync-uploads-to-railway.ts --ssh-pipe --only media

# или вручную:
tar -czf - -C . uploads/avatars uploads/backgrounds \
  | railway ssh --service monology-backend -- tar -xzf - -C /app
```

Архив распаковывается в `/app/uploads/...` (структура `uploads/` внутри tar).

### 3c. Hosted tar + `curl` внутри контейнера

Если pipe нестабилен, но HTTPS с контейнера наружу ок:

```bash
bun run sync:uploads:pack
# залей monology-uploads.tgz куда угодно по HTTPS (свой бакет / временный URL)

railway ssh --service monology-backend -- \
  bash -lc 'curl -fL "$URL" -o /tmp/u.tgz && tar -xzf /tmp/u.tgz -C /app && rm -f /tmp/u.tgz'
```

Подставь свой `$URL`. Не коммить `*.tgz`.

### 3d. Tar → один файл через SFTP → extract (если SFTP снова ожил)

```bash
bun run sync:uploads:pack
railway volume files upload /tmp/monology-uploads.tgz /monology-uploads.tgz --overwrite
railway ssh --service monology-backend -- tar -xzf /app/uploads/monology-uploads.tgz -C /app
railway ssh --service monology-backend -- rm -f /app/uploads/monology-uploads.tgz
```

### 3e. Dashboard / Console

1. Railway → **monology-backend** → Console / Volumes file browser.
2. Залей хотя бы `avatars/` + `backgrounds/` (для ~1 GB media неудобно).

### 3f. Admin HTTP zip endpoint

Отдельного admin bulk/zip upload **нет** (Nest лимиты ~2–5 MB на одиночные картинки; 1 GB через HTTP proxy ненадёжен). Для bulk используй §2 + §3b/§3c. Долгосрочно — S3 / Railway Bucket (§3g).

### 3g. Позже: S3 / Railway Bucket

Медиа лучше вынести в object storage + CDN. Отдельная миграция — не блокер для разового синка.

---

## 4. Проверка

```bash
curl -s https://monology-backend-production.up.railway.app/api/health
SAMPLE=$(ls uploads/media | head -1)
curl -sI "https://monology-backend-production.up.railway.app/uploads/media/$SAMPLE"
# Frontend: VITE_MEDIA_ORIGIN=https://monology-backend-production.up.railway.app
```

| Симптом | Что делать |
|---------|------------|
| `Cannot GET /uploads/...` / 404 | Файла нет на volume — upload или §2 CDN для cover-shiki |
| 200 на health, 404 на картинке | Volume пустой или mount не `/app/uploads` / volume на Postgres |
| Upload пишет не туда | Remote path: `/media`, не `/uploads/media` и не `/app/uploads/media` |
| После redeploy картинки пропали | Volume не смонтирован на **backend** |
| `No SSH keys found` | §0b — `ssh-keygen` + `railway ssh keys add` |
| `Failed to initialize SFTP session` / Timeout | §0c → §2 CDN → §3b SSH pipe |
| `railway ssh … echo ok` Timeout | VPN / DNS (§0c) |
| `A volume is already mounted on service Postgres` | Ты linked к Postgres — перелинкуй на backend (§5) |
| Выбран `postgres-volume` | Отмена; выбери volume backend с mount `/app/uploads` |

---

## 5. Восстановление после ошибочного link на Postgres

Точная последовательность (Bun + Railway CLI). **Не** трогай / не удаляй `postgres-volume`.

```bash
cd /home/maksim/Projects/personal/monology-backend

# --- A. Перелинковать на backend ---
railway login
railway status
# если Service = Postgres:
railway unlink -s -y
# полный relink (workspace → project → environment → **backend service**):
railway link
# или только сменить сервис, если project уже верный:
# railway service link
# railway link -s <имя-backend-сервиса>

railway status
# ожидаемо: Service указывает на Nest/API/backend, НЕ Postgres

# --- B. Volume на backend ---
railway volume list
# если на backend ещё нет volume с /app/uploads:
railway volume add --mount-path /app/uploads
# дождись редеплоя backend после mount

railway volume list
# проверь: volume на backend, Mount Path = /app/uploads
# НЕ заливай ничего в postgres-volume

# --- C. SSH-ключ ---
ls ~/.ssh/*.pub 2>/dev/null || ssh-keygen -t ed25519 -C "railway-$(hostname)" -f ~/.ssh/id_ed25519
railway ssh keys add --key ~/.ssh/id_ed25519.pub --name "laptop"
railway ssh keys
railway ssh --service monology-backend -- echo ok

# --- D. Повтор: сначала CDN, потом файлы ---
# TARGET_DATABASE_URL='…' bun run rewrite:shiki-covers-cdn --apply

SAMPLE=$(ls uploads/media | head -1)
# интерактивно выбери volume **backend** (не postgres-volume)
railway volume files upload "./uploads/media/$SAMPLE" "/media/$SAMPLE" --overwrite
# если SFTP Timeout: bun run scripts/sync-uploads-to-railway.ts --ssh-pipe --only avatars,backgrounds

curl -sI "https://monology-backend-production.up.railway.app/uploads/media/$SAMPLE"
```

Имена сервисов в UI могут отличаться (`monology-backend`, `backend`, `api` …) — ориентир: тот сервис, у которого публичный URL Nest и переменные приложения, а не Postgres.

---

## Связанные файлы

- `scripts/sync-uploads-to-railway.ts` — инвентарь / pack / upload / `--ssh-pipe`
- `scripts/rewrite-shiki-covers-to-cdn.ts` — CDN fallback (`bun run rewrite:shiki-covers-cdn`)
- `DEPLOY.md` — volume checklist
- `scripts/migrate-local-to-railway.md` — импорт БД (отдельно от media) + DNS/VPN для proxy
