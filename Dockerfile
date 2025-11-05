FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache ffmpeg

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts

# Build TypeScript
RUN npm run build

# Expose ports
EXPOSE 3000 8443

# Start application
CMD ["npm", "start"]

