FROM node:20-slim

# Устанавливаем ffmpeg и распакованный yt-dlp через pip (вместо сжатого zipapp, который тормозит на 0.1 vCPU Render)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
