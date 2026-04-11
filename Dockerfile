FROM node:20-bookworm

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HEXMON_RUNTIME_CONTAINER=true

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  ffmpeg \
  libreoffice \
  postgresql-client \
  tar \
  && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install
RUN npx playwright install --with-deps chromium

# Copy source code
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts

# Build TypeScript
RUN npm run build

# Expose ports
EXPOSE 3000

# Start application
CMD ["npm", "start"]
