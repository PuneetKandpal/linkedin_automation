# Dockerfile for Server + UI only (no Playwright)
# Use this for cloud deployment where browser automation runs on client machines

# Stage 1: Build UI
FROM node:20-alpine AS ui-builder

WORKDIR /app/ui

# Copy UI package files
COPY ui/package*.json ./
RUN npm ci

# Copy UI source and build
COPY ui/ ./
RUN npm run build

# Stage 2: Build backend (needs devDependencies for `tsc`)
FROM node:20-alpine AS backend-builder

WORKDIR /app

# Copy backend package files
COPY package*.json ./
RUN npm ci

# Copy backend source and build
COPY . .
RUN npm run build

# Stage 3: Runtime (production dependencies only)
FROM node:20-alpine AS server

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled backend and built UI
COPY --from=backend-builder /app/dist ./dist
COPY --from=ui-builder /app/ui/dist ./ui/dist

# Create required directories
RUN mkdir -p config output logs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD sh -c 'wget --no-verbose --tries=1 --spider "http://localhost:${PORT:-3000}/health" || exit 1'

# Start the server only (no worker)
CMD ["node", "dist/server.js"]
