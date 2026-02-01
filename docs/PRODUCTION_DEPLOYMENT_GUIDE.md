# LinkedIn Publisher - Production Deployment Guide

**Version:** 1.0.0  
**Last Updated:** February 2026

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Railway Deployment (Server + UI)](#railway-deployment-server--ui)
3. [Client CLI Tools Distribution](#client-cli-tools-distribution)
4. [Client Setup Instructions](#client-setup-instructions)
5. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────┐
│                   RAILWAY CLOUD                      │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │  Server + UI (Dockerized)                  │    │
│  │  - Express API (port 3000)                 │    │
│  │  - React UI (served from /ui/dist)         │    │
│  │  - MongoDB Atlas connection                │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
└─────────────────────────────────────────────────────┘
                         ▲
                         │ HTTPS
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    ┌────▼────┐     ┌────▼────┐    ┌────▼────┐
    │ Client 1│     │ Client 2│    │ Client 3│
    │         │     │         │    │         │
    │ browser │     │ browser │    │ browser │
    │   +     │     │   +     │    │   +     │
    │  CLIs   │     │  CLIs   │    │  CLIs   │
    └─────────┘     └─────────┘    └─────────┘
```

### What Runs Where

**Railway (Cloud Server):**
- ✅ API Server (`src/server.ts`)
- ✅ React UI (`ui/dist/`)
- ✅ MongoDB Atlas connection
- ❌ NO browser automation (Playwright)
- ❌ NO worker process

**Client Machines (Local):**
- ✅ Account connection tool (`bootstrap`)
- ✅ Publishing worker (`worker`)
- ✅ Playwright browser automation
- ✅ Direct MongoDB Atlas connection

---

## Railway Deployment (Server + UI)

### Prerequisites

1. **Railway Account**: Sign up at [railway.app](https://railway.app)
2. **Railway CLI**: Install globally
   ```bash
   npm install -g @railway/cli
   railway login
   ```
3. **MongoDB Atlas**: Get your connection string
   - Format: `mongodb+srv://username:password@cluster.mongodb.net/?appName=YourApp`

### Step 1: Create Railway Project

```bash
# Navigate to project root
cd /path/to/artcile_automation

# Initialize Railway project (if not already done)
railway init
```

When prompted:
- Select **"Create new project"**
- Name it: **"LinkedIn Publisher"**
- Select environment: **"production"**

### Step 2: Create App Service

The current Railway setup may have linked to a MongoDB service. You need a separate **App** service for your code.

#### Option A: Via Railway Dashboard (Recommended)

1. Run to open dashboard:
   ```bash
   railway open
   ```

2. In the Railway UI:
   - Click **"+ New"** → **"Empty Service"**
   - Name it: `app` or `linkedin-publisher`
   - Click **"Create"**

3. Link your local folder to this service:
   ```bash
   railway service link app
   ```
   (Use the exact name you created)

#### Option B: Via CLI (if dashboard option A worked)

```bash
# This may prompt interactively
railway service
```

### Step 3: Set Environment Variables

Set these variables on your **app** service (not MongoDB service):

```bash
# Database connection (YOUR MongoDB Atlas URI)
railway variable set MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/?appName=Cluster0"

# Storage encryption secret (generate a random 32-char string)
railway variable set STORAGE_STATE_SECRET="G9k2X5nQ8sR1vT4wY7zC0mP3aL6eH9bD"

# Optional: Port (Railway auto-assigns, but you can set)
railway variable set PORT="3000"

# Optional: CORS origin (your Railway domain, set after first deploy)
railway variable set CORS_ORIGIN="https://your-app.up.railway.app"
```

**Generate a secure secret:**
```bash
# On macOS/Linux
openssl rand -base64 32

# Or use Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Step 4: Verify Dockerfile

Your `Dockerfile` should build both UI and server:

```dockerfile
# Stage 1: Build UI
FROM node:20-alpine AS ui-builder
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine AS backend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 3: Runtime
FROM node:20-alpine AS server
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=backend-builder /app/dist ./dist
COPY --from=ui-builder /app/ui/dist ./ui/dist
RUN mkdir -p config output logs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

✅ This is already created at `Dockerfile`

### Step 5: Deploy to Railway

```bash
# Deploy (specify the app service explicitly)
railway up -s app

# Or if already linked
railway up
```

**Build process:**
1. Railway detects `Dockerfile`
2. Builds UI (React + Vite)
3. Builds backend (TypeScript → JavaScript)
4. Creates production image
5. Starts server on assigned port

**Monitor the deployment:**
```bash
# Watch logs in real-time
railway logs -s app

# Check deployment status
railway status
```

### Step 6: Get Your Public URL

```bash
# Generate a Railway subdomain
railway domain

# Or open dashboard to see the URL
railway open
```

Your app will be live at: `https://your-app-name.up.railway.app`

### Step 7: Update CORS (if needed)

After getting your Railway URL, update CORS:

```bash
railway variable set CORS_ORIGIN="https://your-app-name.up.railway.app"

# Redeploy to apply
railway up -s app
```

### Verification

1. **Health check**: Visit `https://your-app.up.railway.app/health`
   - Should return: `{"status":"ok","timestamp":"..."}`

2. **UI**: Visit `https://your-app.up.railway.app/`
   - Should load React UI

3. **API**: Check `https://your-app.up.railway.app/accounts`
   - Should return empty array `[]` or existing accounts

---

## Client CLI Tools Distribution

### Why Not Standalone Executables?

We discovered that `pkg` (the Node.js packager) is **incompatible with Playwright** due to:
- Playwright's MCP/agent bundle failing under `pkg`'s embedded Node runtime
- `pkg` only supports Node 18.5, but Playwright requires newer runtime features

### Distribution Approach: Node-Based CLI Package

Instead, you'll distribute a **portable Node.js package** that clients run with their own Node installation.

---

## Preparing Client CLI Package

### Step 1: Build the Project

```bash
# Build TypeScript to JavaScript
npm run build
```

This compiles:
- `src/cli/bootstrap-cli.ts` → `dist/cli/bootstrap-cli.js`
- `src/cli/worker-cli.ts` → `dist/cli/worker-cli.js`

### Step 2: Create Distribution Package

Create a folder structure for clients:

```bash
# From project root
mkdir -p client-tools
```

Copy required files:

```bash
# Copy CLI entry points
cp -r cli/ client-tools/cli/
cp -r dist/ client-tools/dist/
cp -r config/ client-tools/config/

# Copy dependencies manifest
cp package.json client-tools/
cp package-lock.json client-tools/

# Copy environment template
cp .env.example client-tools/.env.example

# Create client README
cat > client-tools/README.md << 'EOF'
# LinkedIn Publisher - Client Tools

## Requirements
- Node.js 18 or higher
- macOS, Windows, or Linux

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Install Playwright browser:
   ```bash
   npx playwright install chromium
   ```

## Configuration

Copy `.env.example` to `.env` and fill in your details:

```bash
cp .env.example .env
```

Edit `.env`:
```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?appName=Cluster0
STORAGE_STATE_SECRET=<provided-by-admin>
```

## Usage

### Connect LinkedIn Account

```bash
node cli/li-connect.js
```

Follow the interactive prompts to link your LinkedIn account.

### Run Publishing Worker

```bash
node cli/li-worker.js
```

This starts the local worker that processes publishing jobs.

## Troubleshooting

- **Playwright browser not found**: Run `npx playwright install chromium`
- **MongoDB connection error**: Verify your `MONGODB_URI` in `.env`
- **Storage state secret error**: Get the correct secret from your admin
EOF
```

### Step 3: Create Distribution Archive

```bash
# Create a zip file for distribution
cd client-tools
zip -r ../linkedin-publisher-client-tools.zip .
cd ..
```

Now you have: `linkedin-publisher-client-tools.zip` (~50-100MB with node_modules)

**Alternative: Without node_modules (smaller, requires npm install)**

```bash
# Don't copy node_modules
rm -rf client-tools/node_modules
cd client-tools
zip -r ../linkedin-publisher-client-tools-slim.zip .
cd ..
```

This creates a smaller package (~5-10MB) but clients must run `npm install` first.

---

## Client Setup Instructions

### For Clients: Complete Setup Guide

Send this to your clients along with the zip file:

---

# LinkedIn Publisher - Client Setup Guide

## What You'll Need

1. **Node.js** (version 18 or higher)
   - Download: https://nodejs.org/
   - Verify: `node --version` (should show v18.x or higher)

2. **The client tools package** (provided by admin)

3. **Configuration details** (provided by admin):
   - MongoDB connection URI
   - Storage state secret

---

## Step 1: Install Node.js

### macOS
```bash
# Using Homebrew
brew install node

# Or download installer from https://nodejs.org/
```

### Windows
1. Download installer: https://nodejs.org/en/download/
2. Run installer, follow prompts
3. Verify in Command Prompt: `node --version`

### Linux (Ubuntu/Debian)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Step 2: Extract Client Tools

```bash
# Navigate to where you saved the zip
cd ~/Downloads

# Extract
unzip linkedin-publisher-client-tools.zip -d linkedin-publisher

# Navigate into folder
cd linkedin-publisher
```

---

## Step 3: Install Dependencies

```bash
# Install Node.js dependencies
npm install

# Install Playwright browser (required for LinkedIn automation)
npx playwright install chromium
```

**Note**: This downloads the Chromium browser (~150MB). This is normal.

---

## Step 4: Configure Connection

Create your `.env` file:

```bash
# Copy template
cp .env.example .env

# Edit with your credentials (use any text editor)
nano .env
# or
code .env
# or
notepad .env
```

Fill in these values (provided by your admin):

```env
MONGODB_URI=mongodb+srv://your-username:your-password@cluster.mongodb.net/?appName=Cluster0
STORAGE_STATE_SECRET=<32-character-secret-provided-by-admin>
```

**Save and close the file.**

---

## Step 5: Connect Your LinkedIn Account

Run the account connector:

```bash
node cli/li-connect.js
```

### What Happens:

1. **Prompts for Account ID**:
   ```
   Account ID (e.g., client_001): 
   ```
   Enter a unique identifier for your account (e.g., `john_doe_linkedin`)

2. **Opens LinkedIn in Browser**:
   - A Chromium browser window will open
   - You'll see the LinkedIn login page

3. **Login to LinkedIn**:
   - Enter your LinkedIn email and password
   - Complete any 2FA/verification if prompted
   - **Wait until you see your LinkedIn feed**

4. **Return to Terminal**:
   - Press Enter in the terminal when you're logged in
   - The tool will verify your session and save it

5. **Success**:
   ```
   ✅ Account connected successfully!
   ```

Your LinkedIn session is now saved securely in the database.

---

## Step 6: Run the Publishing Worker (Optional)

If you want to run the local worker to process publishing jobs:

```bash
node cli/li-worker.js
```

### What It Does:

- Connects to the database
- Polls for pending publishing jobs every 5 seconds
- Executes jobs using your saved LinkedIn session
- Publishes articles to LinkedIn

**Keep this running** while you want jobs to be processed.

**To stop**: Press `Ctrl+C`

---

## Common Issues & Solutions

### Error: "Cannot find module"

**Solution**: Run `npm install` to install dependencies.

### Error: "Playwright browser not found"

**Solution**: Run `npx playwright install chromium`

### Error: "MONGODB_URI is required"

**Solution**: Check your `.env` file has the correct MongoDB URI.

### Error: "Invalid storage state secret"

**Solution**: Verify the `STORAGE_STATE_SECRET` in `.env` matches what admin provided.

### LinkedIn Login Fails / Session Invalid

**Solution**:
1. Delete your account from database (ask admin)
2. Re-run `node cli/li-connect.js`
3. Make sure you're fully logged in before pressing Enter

### Browser Opens But Crashes

**Solution**:
1. Update Playwright: `npx playwright install chromium --force`
2. Make sure you have enough RAM (2GB+ free)

---

## Support

Contact your admin if you encounter issues not listed here.

Provide:
- The full error message
- Your operating system (macOS, Windows, Linux)
- Node.js version (`node --version`)

---

**End of Client Setup Guide**

---

## Sending Client Tools to Clients

### Method 1: Email / Cloud Storage (Recommended)

1. **Upload to cloud storage**:
   - Google Drive
   - Dropbox
   - AWS S3
   - OneDrive

2. **Share the link** with:
   - `linkedin-publisher-client-tools.zip`
   - Client setup instructions (from above)

3. **Send credentials separately** (for security):
   - MongoDB URI
   - Storage state secret

**Email template:**

```
Subject: LinkedIn Publisher - Client Tools Setup

Hi [Client Name],

Please find the LinkedIn Publisher client tools at the link below:

[Cloud Storage Link]

Setup Instructions:
1. Download and extract the zip file
2. Follow the README.md inside for installation
3. I'll send your MongoDB credentials in a separate email for security

Required software:
- Node.js 18+ (https://nodejs.org/)

Estimated setup time: 10-15 minutes

Let me know if you need any assistance!

Best,
[Your Name]
```

### Method 2: USB Drive (High Security)

For clients requiring maximum security:
1. Copy `linkedin-publisher-client-tools.zip` to USB drive
2. Include printed setup instructions
3. Provide credentials via secure channel (encrypted email, password manager)

### Method 3: Direct Server Download

Host the tools on your server:

```bash
# On your web server
cp linkedin-publisher-client-tools.zip /var/www/html/downloads/

# Share URL
https://yourdomain.com/downloads/linkedin-publisher-client-tools.zip
```

**Add password protection** (nginx example):

```nginx
location /downloads/ {
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
}
```

---

## Updating Client Tools

When you make changes to `bootstrap-cli.ts` or `worker-cli.ts`:

```bash
# 1. Rebuild
npm run build

# 2. Create new client package
rm -rf client-tools
mkdir client-tools
cp -r cli/ dist/ config/ package.json package-lock.json .env.example client-tools/
cd client-tools
zip -r ../linkedin-publisher-client-tools-v1.1.zip .
cd ..

# 3. Notify clients of the update
```

**Versioning**: Update version in `client-tools/README.md` header.

---

## Security Best Practices

### For You (Admin)

1. **Rotate secrets** periodically:
   ```bash
   # Generate new secret
   openssl rand -base64 32
   
   # Update Railway
   railway variable set STORAGE_STATE_SECRET="<new-secret>"
   
   # Notify all clients to update their .env
   ```

2. **Monitor MongoDB access**:
   - Use MongoDB Atlas IP whitelist
   - Enable audit logs
   - Review access logs monthly

3. **Separate credentials per client** (if needed):
   - Create separate MongoDB users per client
   - Set read/write permissions per collection

### For Clients

1. **Never commit `.env` to git**
2. **Don't share credentials** via unsecured channels
3. **Keep tools folder secure** (encrypted disk)
4. **Update Node.js** and dependencies regularly

---

## Troubleshooting

### Railway Deployment Issues

**Build fails with "tsc: not found"**
- ✅ Fixed in current `Dockerfile` (uses multi-stage build with devDependencies)

**Container starts but crashes**
- Check logs: `railway logs -s app`
- Verify `MONGODB_URI` is set correctly
- Verify `STORAGE_STATE_SECRET` is set

**Health check fails**
- Verify port is `3000` (or `PORT` env var)
- Check server starts: `railway logs -s app` should show "Server started on port..."

**"Cannot find module '/app/mongod'"**
- This means you're deploying to the **MongoDB service** instead of app service
- Solution: Create separate `app` service and deploy there (see Step 2)

### Client CLI Issues

**"Module not found" errors**
- Run `npm install` in the client-tools folder

**Playwright crashes**
- Update Playwright: `npx playwright install chromium --force`
- Check RAM (needs ~500MB free)

**LinkedIn session expires**
- Re-run `node cli/li-connect.js`
- LinkedIn may require re-authentication every 30-60 days

---

## Maintenance Schedule

### Weekly
- Monitor Railway logs for errors
- Check disk usage on Railway (logs/output folders)

### Monthly
- Review MongoDB connection count
- Update dependencies: `npm update`
- Rotate storage secrets (optional)

### Quarterly
- Update Playwright: `npm install @playwright/test@latest`
- Update Node.js to latest LTS
- Review client access (revoke unused accounts)

---

## Support & Contact

For issues with this deployment:

1. **Check logs first**:
   ```bash
   railway logs -s app
   ```

2. **Check Railway status**: https://status.railway.app

3. **MongoDB Atlas status**: https://status.cloud.mongodb.com

4. **GitHub issues**: [Your repo URL]

---

**End of Production Deployment Guide**
