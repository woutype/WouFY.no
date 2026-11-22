# WouFY Downloader Backend (Render)

Лёгкий сервер на Node.js + Docker (`ffmpeg` + `yt-dlp`) для поиска и скачивания треков в мобильном приложении WouFY.

## Провайдеры

- **VK Audio** (по аналогии с `vkms-src`) — включается автоматически, если задана переменная `VK_TOKEN`. Конвертирует `.m3u8` / `.mp3` через `ffmpeg` в MP3 320 kbps с вшитыми ID3v2.3 тегами и обложкой.
- **YouTube / `yt-dlp`** — работает автоматически без каких-либо токенов, если `VK_TOKEN` не указан (или `MUSIC_PROVIDER=ytdlp`).
- **LRCLIB** — автоматически подтягивает синхронизированный текст песни (`.lrc`) в `/api/tracks/:id/metadata`.

## Деплой на Render (Free Tier)

### Вариант 1 — через Web Service вручную
1. Запушь репозиторий на GitHub (`.env` уже в `.gitignore`, секреты туда не попадут).
2. В Render: **New + → Web Service** → выбери репозиторий.
3. Укажи параметры:
   - **Root Directory**: `server`
   - **Runtime**: `Docker`
   - **Instance Type**: `Free`
   - **Health Check Path**: `/health`
4. В разделе **Environment Variables** добавь:
   - `API_KEY` — придумай любой длинный секрет (защищает твой Render от посторонних);
   - `VK_TOKEN` *(опционально)* — если хочешь искать и качать через VK Audio. Без него сразу заработает `yt-dlp`.
5. Нажми **Create Web Service** и дождись сборки Docker-образа (~2–3 минуты).

### Вариант 2 — через Blueprint (`render.yaml`)
В Render: **New + → Blueprint** → выбери репозиторий — Render сам подхватит [`render.yaml`](../render.yaml) и предложит ввести `API_KEY` и `VK_TOKEN`.

## Подключение к приложению WouFY

1. Скопируй `.env.example` в `.env.local` (или `.env` — оба игнорируются Git):
   ```env
   EXPO_PUBLIC_DOWNLOAD_API_URL=https://<твой-сервис>.onrender.com
   EXPO_PUBLIC_DOWNLOAD_API_KEY=<тот-же-API_KEY-что-на-Render>
   ```
2. Либо введи URL прямо в приложении в окне **«Скачать треки»** (иконка сервера в правом верхнем углу).

## Локальный запуск для быстрой проверки

```bash
cd server
npm install
npm start
```

Сервер поднимется на `http://localhost:3000` (для проверки с телефона в одной Wi-Fi сети используй `http://<локальный-IP-компьютера>:3000`).
