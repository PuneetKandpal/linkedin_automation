#!/bin/bash
# Builds "Content Generator" for a client: a folder that runs on its own (Node.js 22 or newer is the only thing the
# computer needs), with its launchers, an empty Batch Monitor.xlsx and the client README, zipped as
# content-generator-client-v<version>.zip. It ships with config/api-keys.txt holding empty keys, to paste into after
# unzipping (or the tool asks for them on its first run; "Change API Keys" replaces them). --with-keys fills that file
# with the keys from .env instead (share such a zip privately).
#
# Usage: scripts/package-generate-client.sh [version] [--with-keys]    (re-run after changing code or config)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VERSION="1.0.0"
WITH_KEYS=0
for arg in "$@"; do
  case "${arg}" in
    --with-keys) WITH_KEYS=1 ;;
    *) VERSION="${arg}" ;;
  esac
done
NAME="Content Generator"
ZIP="content-generator-client-v${VERSION}.zip"
STAGE="$(mktemp -d)"
TARGET="${STAGE}/${NAME}"
trap 'rm -rf "${STAGE}"' EXIT

echo "📦 Content Generator: client package v${VERSION}"

echo "🔨 Building..."
npm run --silent build

echo "📁 Copying the tool..."
mkdir -p "${TARGET}/cli" "${TARGET}/dist/cli" "${TARGET}/dist/engine" "${TARGET}/dist/services" "${TARGET}/config"
cp cli/li-generate.js "${TARGET}/cli/"
cp dist/env.js "${TARGET}/dist/"
cp dist/engine/logger.js "${TARGET}/dist/engine/"
cp dist/cli/generate-cli.js "${TARGET}/dist/cli/"
cp dist/services/generate-*.js "${TARGET}/dist/services/"
cp config/generate.json "${TARGET}/config/"
cp docs/GENERATE/CLIENT_README.md "${TARGET}/README.md"
cp scripts/client/3-Generate-Articles.command "${TARGET}/Generate Articles.command"
cp scripts/client/3-Generate-Articles.bat "${TARGET}/Generate Articles.bat"
cp scripts/client/4-Change-API-Keys.command "${TARGET}/Change API Keys.command"
cp scripts/client/4-Change-API-Keys.bat "${TARGET}/Change API Keys.bat"
chmod +x "${TARGET}/Generate Articles.command" "${TARGET}/Change API Keys.command"

# The keys live in config/api-keys.txt, a plain text file the client opens and pastes into (or the tool fills in).
# Only API keys ever go in: the repository's .env also holds settings (MongoDB) that are not for clients.
KEYS_FILE="${TARGET}/config/api-keys.txt"
printf '# API keys: paste each key right after its "=" (no spaces, no quotes), then save this file.\n# Or leave them empty: the tool asks for them on its first run, and "Change API Keys" replaces them.\n' > "${KEYS_FILE}"
if [ "${WITH_KEYS}" = 1 ]; then
  for NAME_ in ANTHROPIC_API_KEY GEMINI_API_KEY; do
    grep -E "^${NAME_}=" .env >> "${KEYS_FILE}" || echo "${NAME_}=" >> "${KEYS_FILE}"
  done
  echo "🔑 API keys included in config/api-keys.txt"
else
  printf 'ANTHROPIC_API_KEY=\nGEMINI_API_KEY=\n' >> "${KEYS_FILE}"
  echo "🔑 No API keys included: paste them into config/api-keys.txt, or the tool asks for them on its first run"
fi

echo "📦 Installing what the generator needs (production only)..."
VERSION="${VERSION}" node -e '
  const repo = require("./package.json");
  const names = ["@anthropic-ai/sdk", "@google/genai", "openai", "dotenv", "winston", "winston-daily-rotate-file", "xlsx"];
  const dependencies = Object.fromEntries(names.map(name => [name, repo.dependencies[name]]));
  const pkg = { name: "content-generator", version: process.env.VERSION, private: true, description: "Writes articles from an Excel file of input records", engines: { node: ">=22" }, dependencies };
  console.log(JSON.stringify(pkg, null, 2));
' > "${TARGET}/package.json"
(cd "${TARGET}" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

echo "📊 Creating an empty Batch Monitor.xlsx..."
node -e '
  const { BatchMonitor } = require(process.argv[1] + "/dist/services/generate-monitor.js");
  if (!new BatchMonitor(process.argv[1] + "/Batch Monitor.xlsx").initialize()) process.exit(1);
' "${TARGET}"

echo "🗜️  Zipping..."
rm -f "${ROOT}/${ZIP}"
(cd "${STAGE}" && zip -r -q -X "${ROOT}/${ZIP}" "${NAME}")

echo ""
echo "✅ ${ZIP} ($(du -h "${ROOT}/${ZIP}" | cut -f1))"
if [ "${WITH_KEYS}" = 1 ]; then
  echo "   It contains the API keys: share it privately, and rebuild it after rotating them."
fi
echo "   The client unzips it, installs Node.js 22+ once, and double-clicks \"Generate Articles\"."
echo "   \"Change API Keys\" enters or replaces the keys at any time."
