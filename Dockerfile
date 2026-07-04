# =============================================
# Stage 1: Build React frontend
# =============================================
FROM node:18-alpine AS builder

WORKDIR /app

# Install React dependencies
COPY package.json ./
RUN npm install --legacy-peer-deps && \
    npm install ajv@^8 --legacy-peer-deps

# Copy source and build
COPY public/ ./public/
COPY src/ ./src/

# CRA baka le env REACT_APP_* al momento del build.
# Railway le passa come build args se dichiarate qui.
ARG REACT_APP_SUPABASE_URL
ARG REACT_APP_SUPABASE_ANON_KEY
ENV REACT_APP_SUPABASE_URL=$REACT_APP_SUPABASE_URL
ENV REACT_APP_SUPABASE_ANON_KEY=$REACT_APP_SUPABASE_ANON_KEY

RUN npm run build

# =============================================
# Stage 2: Production server
# =============================================
FROM node:18-alpine AS production

WORKDIR /app

# Install server dependencies
COPY server/package.json ./server/
RUN cd server && npm install --production

# Copy built frontend and server
COPY --from=builder /app/build ./build
COPY server/server.js ./server/

# Create data directory for persistence
RUN mkdir -p /app/data

# Expose port
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:10000/api/snapshots || exit 1

CMD ["node", "server/server.js"]
