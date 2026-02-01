# Deployment Guide

This guide explains how to deploy the LinkedIn Article Publisher for free on various platforms.

## Overview

The application consists of:
- **Backend**: Express.js API server with MongoDB
- **Frontend**: React + Vite SPA (served as static files from the backend)
- **Automation**: Playwright-based LinkedIn publishing (runs locally, not on server)

## Prerequisites

- MongoDB database (free tier available from MongoDB Atlas)
- Node.js 18+ (for local development)

## Environment Variables

Create a `.env` file with these variables:

```env
# Required
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/linkedin-publisher
STORAGE_STATE_SECRET=your_32_character_secret_key_here

# Server
PORT=3000
CORS_ORIGIN=*

# Optional
CONFIG_DIR=./config
LOG_LEVEL=info
LOG_RETENTION_DAYS=7
```

## Deployment Options

### Option 1: Railway (Recommended - Easiest)

**Pros**: Simplest deployment, free tier includes database
**Cons**: Free tier sleeps after inactivity (cold starts)

1. **Install Railway CLI**:
   ```bash
   npm install -g @railway/cli
   ```

2. **Login and create project**:
   ```bash
   railway login
   railway init
   ```

3. **Add MongoDB database**:
   ```bash
   railway add --database mongodb
   ```

4. **Set environment variables**:
   ```bash
   railway variables set STORAGE_STATE_SECRET="your_secret_here"
   railway variables set CORS_ORIGIN="*"
   ```

5. **Deploy**:
   ```bash
   railway up
   ```

6. **Get your URL**:
   ```bash
   railway domain
   ```

### Option 2: Render (Free Forever Tier)

**Pros**: Free tier never expires, includes web server and database
**Cons**: Spins down after 15 min inactivity (30s cold start)

1. **Create accounts**:
   - [Render](https://render.com)
   - [MongoDB Atlas](https://mongodb.com/atlas) (or use Render's MongoDB)

2. **Push code to GitHub**

3. **Create Web Service on Render**:
   - Connect your GitHub repo
   - Select "Use existing render.yaml"
   - Click "Apply" to use the blueprint

4. **Set environment variables** in Render Dashboard:
   - `MONGODB_URI`: Your MongoDB Atlas connection string
   - `STORAGE_STATE_SECRET`: Generate a random 32-char string

5. **Deploy automatically**

### Option 3: Fly.io (Free Tier)

**Pros**: Generous free tier, fast cold starts, global edge deployment
**Cons**: Requires credit card (no charges on free tier)

1. **Install Fly CLI**:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Login**:
   ```bash
   fly auth login
   ```

3. **Launch app** (first time only):
   ```bash
   fly launch --config fly.toml
   ```

4. **Set secrets**:
   ```bash
   fly secrets set MONGODB_URI="your_mongodb_uri"
   fly secrets set STORAGE_STATE_SECRET="your_secret"
   ```

5. **Deploy**:
   ```bash
   fly deploy
   ```

### Option 4: Self-Hosted (VPS)

Deploy on any VPS (DigitalOcean, Hetzner, AWS EC2, etc.)

1. **Build locally**:
   ```bash
   npm run build:all
   ```

2. **Upload to server**:
   ```bash
   rsync -avz --exclude=node_modules --exclude=.git . user@your-server:/app/
   ```

3. **On server**:
   ```bash
   cd /app
   npm ci --production
   npm run build:all
   
   # Using PM2
   npm install -g pm2
   pm2 start dist/server.js --name linkedin-publisher
   pm2 save
   pm2 startup
   ```

4. **Setup Nginx reverse proxy**:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

## MongoDB Setup (Free)

1. **Create MongoDB Atlas account** (https://mongodb.com/atlas)
2. **Create free M0 cluster**
3. **Create database user** with read/write permissions
4. **Add IP whitelist** (or use `0.0.0.0/0` for any IP)
5. **Get connection string**:
   ```
   mongodb+srv://username:password@cluster.mongodb.net/linkedin-publisher?retryWrites=true&w=majority
   ```

## Local Development with Production API

To test the UI against a deployed backend:

```bash
cd ui
# Create .env.local
echo "VITE_API_BASE_URL=https://your-deployed-api.com" > .env.local
npm run dev
```

## Troubleshooting

### Build fails on "npm ci"
- Clear npm cache: `npm cache clean --force`
- Delete node_modules and lock file, reinstall

### MongoDB connection errors
- Check IP whitelist in MongoDB Atlas
- Verify connection string format
- Ensure database user credentials are correct

### CORS errors in browser
- Set `CORS_ORIGIN=*` or specific domain
- For production, set it to your frontend URL

### Playwright not working on server
- Playwright automation requires local environment with browser
- The server only hosts the API and UI, not the automation
- Run `bootstrap` and `worker` locally on your machine

## Security Notes

1. **Never commit `.env` files**
2. **Use strong `STORAGE_STATE_SECRET`** (32+ random characters)
3. **Rotate secrets periodically**
4. **Use specific CORS origins** in production instead of `*`
5. **Enable MongoDB IP allowlisting** if possible

## Monitoring

- Health endpoint: `GET /health`
- Logs available in each platform's dashboard
- For PM2: `pm2 logs linkedin-publisher`

## Updates

To update after code changes:

```bash
# Railway
git push && railway up

# Render
# Auto-deploys on git push

# Fly.io
fly deploy

# VPS
git pull && npm run build:all && pm2 restart linkedin-publisher
```
