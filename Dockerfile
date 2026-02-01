# Production Dockerfile for LinkedIn Article Publisher
# Multi-stage build: build UI and then serve with Node.js

# Stage 1: Build UI
FROM node:20-alpine AS ui-builder

WORKDIR /app/ui

# Copy UI package files
COPY ui/package*.json ./
RUN npm ci

# Copy UI source and build
COPY ui/ ./
RUN npm run build

# Stage 2: Build backend and serve
FROM node:20-alpine AS runner

# Install Playwright dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Set Playwright to use system Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copy backend package files
COPY package*.json ./
RUN npm ci --only=production

# Install Playwright
RUN npx playwright install chromium

# Copy backend source and compiled code
COPY . .
RUN npm run build

# Copy built UI from stage 1
COPY --from=ui-builder /app/ui/dist ./ui/dist

# Create required directories
RUN mkdir -p config output logs profiles

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "dist/server.js"]
