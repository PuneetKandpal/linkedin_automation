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
