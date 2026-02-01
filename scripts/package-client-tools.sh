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

# Shared client config (recommended)
if [ -f "client-config.json" ]; then
    cp client-config.json client-tools/
else
    cp client-config.json.example client-tools/
fi

# Create client README
cat > client-tools/README.md << 'EOF'
# LinkedIn Publisher - Client Tools

## Requirements
- Node.js 18 or higher
- macOS, Windows, or Linux

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   npx playwright install chromium
   ```

2. **Configure (recommended)**:
   - Edit `client-config.json` if present.
   - If only `client-config.json.example` exists, rename it:
     ```bash
     mv client-config.json.example client-config.json
     ```
   - Then edit `client-config.json` and set `mongodbUri` and `storageStateSecret`.

3. **Connect LinkedIn Account**:
   ```bash
   node cli/li-connect.js
   ```

4. **Run Worker** (optional):
   ```bash
   node cli/li-worker.js
   ```

## Full Documentation

See PRODUCTION_DEPLOYMENT_GUIDE.md for complete setup instructions.

## Support

Contact your admin for:
- MongoDB URI
- Storage state secret
- Troubleshooting assistance

---

Version: ${VERSION}
EOF

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
