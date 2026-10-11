#!/bin/bash
# Package Client Tools for Distribution
# This script creates a distributable package for clients

set -e

echo "📦 LinkedIn Publisher - Client Tools Packager"
echo "=============================================="
echo ""

# Check if dist exists
if [ ! -d "dist" ]; then
    echo "❌ Error: dist/ folder not found. Run 'npm run build' first."
    exit 1
fi

# Version (you can update this)
VERSION="${1:-1.0.0}"
PACKAGE_NAME="linkedin-publisher-client-tools-v${VERSION}"

echo "📋 Version: ${VERSION}"
echo ""

# Clean up old package
rm -rf client-tools
rm -f linkedin-publisher-client-tools*.zip

echo "🗂️  Creating client-tools directory..."
mkdir -p client-tools

echo "📁 Copying files..."
# Copy necessary files
cp -r cli/ client-tools/cli/
cp -r dist/ client-tools/dist/
cp -r config/ client-tools/config/
cp package.json client-tools/
cp package-lock.json client-tools/
cp .env.example client-tools/
cp follow-list.xlsx client-tools/

# Shared client config (recommended)
if [ -f "client-config.json" ]; then
    cp client-config.json client-tools/
else
    cp client-config.json.example client-tools/
fi

# Client README (the step-by-step guide clients follow)
cp docs/CLIENT_FOLLOW_README.md client-tools/README.md
# Double-click launchers (Mac .command keeps its executable bit in the zip)
cp scripts/client/*.command scripts/client/*.bat client-tools/
chmod +x client-tools/*.command

echo "✅ Files copied"
echo ""

# Option to include node_modules (larger but ready-to-run)
read -p "Include node_modules? (makes package larger but clients don't need to run npm install) [y/N]: " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📦 Copying node_modules (this may take a while)..."
    cd client-tools
    npm install --production
    cd ..
    PACKAGE_TYPE="full"
else
    PACKAGE_TYPE="slim"
fi

echo ""
echo "🗜️  Creating zip archive..."
cd client-tools
zip -r ../${PACKAGE_NAME}-${PACKAGE_TYPE}.zip . -q
cd ..

# Get file size
FILE_SIZE=$(du -h ${PACKAGE_NAME}-${PACKAGE_TYPE}.zip | cut -f1)

echo ""
echo "✅ Package created successfully!"
echo ""
echo "📦 Package: ${PACKAGE_NAME}-${PACKAGE_TYPE}.zip"
echo "📊 Size: ${FILE_SIZE}"
echo ""

if [[ $PACKAGE_TYPE == "slim" ]]; then
    echo "⚠️  Note: Clients will need to run 'npm install' after extraction"
else
    echo "✅ Package is ready to run (npm install already done)"
fi

echo ""
echo "📤 Distribution Instructions:"
echo "   1. Upload ${PACKAGE_NAME}-${PACKAGE_TYPE}.zip to cloud storage"
echo "   2. Share link with client"
echo "   3. Send MongoDB URI and secret separately (for security)"
echo ""
echo "📝 Client setup guide: docs/PRODUCTION_DEPLOYMENT_GUIDE.md"
echo "   (Section: 'Client Setup Instructions')"
echo ""
