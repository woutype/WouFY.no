#!/usr/bin/env bash
set -e

# Переходим в корень проекта
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DEST_FILE="$PROJECT_ROOT/woufy.ipa"

# 1. Извлекаем имя репозитория из git origin
ORIGIN_URL="$(git config --get remote.origin.url || true)"
if [ -z "$ORIGIN_URL" ]; then
  echo "❌ Ошибка: не найден remote origin в git."
  exit 1
fi

# Преобразуем url (https://github.com/woutype/WouFY.no.git или git@github.com:woutype/WouFY.no.git) -> woutype/WouFY.no
REPO_PATH="$(echo "$ORIGIN_URL" | sed -E 's#(https://github.com/|git@github.com:)##' | sed 's#\.git$##')"

# 2. Получаем токен авторизации GitHub
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="$(printf "url=https://github.com/%s.git\n\n" "$REPO_PATH" | git credential fill 2>/dev/null | grep '^password=' | head -1 | cut -d= -f2-)"
fi

if [ -z "$TOKEN" ]; then
  echo "❌ Не удалось получить токен GitHub из git credentials."
  echo "Пожалуйста, задайте переменную GITHUB_TOKEN или настройте git credential."
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")"

echo "🔍 Проверяем статус сборки в репозитории: $REPO_PATH (ветка: $BRANCH)..."

AUTH_HEADER="Authorization: token $TOKEN"

# 3. Ожидание завершения сборки (если она в процессе)
START_TIME=$(date +%s)
RUN_ID=""
STATUS=""
CONCLUSION=""
HTML_URL=""

while true; do
  RESPONSE="$(curl -s -H "$AUTH_HEADER" "https://api.github.com/repos/$REPO_PATH/actions/runs?branch=$BRANCH&per_page=1")"
  
  RUN_ID="$(echo "$RESPONSE" | jq -r '.workflow_runs[0].id // empty')"
  STATUS="$(echo "$RESPONSE" | jq -r '.workflow_runs[0].status // empty')"
  CONCLUSION="$(echo "$RESPONSE" | jq -r '.workflow_runs[0].conclusion // empty')"
  HTML_URL="$(echo "$RESPONSE" | jq -r '.workflow_runs[0].html_url // empty')"

  if [ -z "$RUN_ID" ]; then
    echo "⚠️ Не найдено запусков workflow в репозитории $REPO_PATH"
    exit 1
  fi

  if [ "$STATUS" = "completed" ]; then
    break
  fi

  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))
  printf "\r⏳ Сборка на GitHub в процессе (status: %s)... Прошло: %ds  " "$STATUS" "$ELAPSED"
  sleep 10
done

echo ""
if [ "$CONCLUSION" != "success" ]; then
  echo "❌ Сборка завершилась со статусом: $CONCLUSION"
  echo "Логи сборки: $HTML_URL"
  exit 1
fi

echo "✅ Сборка успешно завершена ($HTML_URL)!"

# 4. Поиск и скачивание артефакта
echo "📥 Получаем список артефактов..."
ARTIFACTS_JSON="$(curl -s -H "$AUTH_HEADER" "https://api.github.com/repos/$REPO_PATH/actions/runs/$RUN_ID/artifacts")"
ARTIFACT_ID="$(echo "$ARTIFACTS_JSON" | jq -r '.artifacts[] | select(.name == "woufy-ipa" or .name == "Woufy-ipa") | .id' | head -1)"

if [ -z "$ARTIFACT_ID" ]; then
  # Если имя отличается, берем первый попавшийся артефакт
  ARTIFACT_ID="$(echo "$ARTIFACTS_JSON" | jq -r '.artifacts[0].id // empty')"
fi

if [ -z "$ARTIFACT_ID" ]; then
  echo "❌ Не найден артефакт сборки в workflow run #$RUN_ID"
  exit 1
fi

TEMP_ZIP="/tmp/woufy-artifact-$RUN_ID.zip"
TEMP_DIR="/tmp/woufy-unpack-$RUN_ID"
rm -rf "$TEMP_ZIP" "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

echo "⬇️  Скачиваем .ipa артефакт (id: $ARTIFACT_ID)..."
curl -L -s -H "$AUTH_HEADER" "https://api.github.com/repos/$REPO_PATH/actions/artifacts/$ARTIFACT_ID/zip" -o "$TEMP_ZIP"

echo "📦 Распаковываем..."
unzip -q "$TEMP_ZIP" -d "$TEMP_DIR"

FOUND_IPA="$(find "$TEMP_DIR" -name "*.ipa" | head -1)"
if [ -z "$FOUND_IPA" ]; then
  echo "❌ Внутри скачанного архива не найден файл .ipa"
  rm -rf "$TEMP_ZIP" "$TEMP_DIR"
  exit 1
fi

mv "$FOUND_IPA" "$DEST_FILE"
rm -rf "$TEMP_ZIP" "$TEMP_DIR"

FILE_SIZE="$(ls -lh "$DEST_FILE" | awk '{print $5}')"
echo ""
echo "🎉 ГОТОВО! Файл успешно обновлён:"
echo "📁 $DEST_FILE ($FILE_SIZE)"
echo "📲 Теперь можно открывать iLoader и устанавливать приложение на iPhone."

if which notify-send >/dev/null 2>&1; then
  notify-send "WouFY.no" "Свежий woufy.ipa ($FILE_SIZE) успешно скачан и готов к установке!"
fi
