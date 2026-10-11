#!/bin/bash
# Double-click to run. Opens in Terminal from this folder.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again."
  read -r -p "Press Enter to close..."
  exit 1
fi
node cli/li-connect.js "$@"
echo
read -r -p "Finished. Press Enter to close this window..."
