# Multi-stage build for production
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install dependencies
RUN npm install && \
    cd backend && npm install && \
    cd ../frontend && npm install

# Copy source code
COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/
COPY frontend/src ./frontend/src
COPY frontend/index.html ./frontend/
COPY frontend/vite.config.js ./frontend/

# Build backend and frontend
RUN cd backend && npm run build
RUN cd frontend && npm run build

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Install Ollama (for local development, optional)
RUN apk add --no-cache curl

# Copy built files
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/node_modules ./backend/node_modules

COPY backend/.env.example ./backend/.env
COPY package.json ./

# Container hosting probes the app on port 80 unless a service-level port is set.
ENV API_PORT=80

# Expose ports
EXPOSE 80 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:80/api/health > /dev/null || exit 1

# Start backend (frontend is served from backend)
CMD ["npm", "start"]
