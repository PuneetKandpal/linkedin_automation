#!/bin/bash
# Double-click to enter or replace the API keys. Opens in Terminal from this folder.
cd "$(dirname "$0")" || exit 1
# In a client package this file sits next to cli/; in the repository it is two folders down.
[ -f cli/li-generate.js ] || cd ../.. || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again."
  read -r -p "Press Enter to close..."
  exit 1
fi
if [ "$(node -p 'parseInt(process.versions.node)')" -lt 22 ]; then
  echo "This tool needs Node.js 22 or newer; this computer has $(node -v). Install the LTS version from https://nodejs.org, then double-click this file again."
  read -r -p "Press Enter to close..."
  exit 1
fi
node cli/li-generate.js --keys
echo
read -r -p "Finished. Press Enter to close this window..."
