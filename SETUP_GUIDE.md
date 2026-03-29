# Hexmon Signage Backend - Complete Setup & Deployment Guide

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

This comprehensive guide will walk you through setting up the Hexmon Signage Backend from scratch, whether you're setting up a development environment or deploying to production.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Initial Setup](#2-initial-setup)
3. [Development Environment Setup](#3-development-environment-setup)
4. [Production Environment Setup](#4-production-environment-setup)
5. [Verification Steps](#5-verification-steps)
6. [Common Issues and Solutions](#6-common-issues-and-solutions)
7. [Additional Resources](#7-additional-resources)

---

## 1. Prerequisites

### 1.1 Required Software

#### Node.js (Required)
- **Version:** Node.js 20.x LTS
- **Download:** https://nodejs.org/
- **Verify Installation:**
  ```bash
  node --version  # Should show v18.x.x or higher
  npm --version   # Should show 9.x.x or higher
  ```

#### Docker Desktop (Recommended)
- **Version:** Docker 20.x or higher
- **Download:** https://www.docker.com/products/docker-desktop
- **Why:** Simplifies PostgreSQL and MinIO setup
- **Verify Installation:**
  ```bash
  docker --version         # Should show Docker version 20.x.x or higher
  docker-compose --version # Should show version 2.x.x or higher
  ```

#### Git (Required)
- **Version:** Git 2.x or higher
- **Download:** https://git-scm.com/downloads
- **Verify Installation:**
  ```bash
  git --version  # Should show git version 2.x.x
  ```

### 1.2 Optional Software (If Not Using Docker)

#### PostgreSQL (Required if not using Docker)
- **Version:** PostgreSQL 14.x or higher (15.x recommended)
- **Download:** https://www.postgresql.org/download/
- **Default Port:** 5432
- **Verify Installation:**
  ```bash
  psql --version  # Should show psql (PostgreSQL) 14.x or higher
  ```

#### MinIO (Required if not using Docker)
- **Version:** Latest stable release
- **Download:** https://min.io/download
- **Default Ports:** 9000 (API), 9001 (Console)
- **Verify Installation:**
  ```bash
  minio --version  # Should show minio version RELEASE.xxxx-xx-xxTxx:xx:xxZ
  ```

#### FFmpeg (Optional - for media processing)
- **Version:** FFmpeg 4.x or higher
- **Download:** https://ffmpeg.org/download.html
- **Verify Installation:**
  ```bash
  ffmpeg -version  # Should show ffmpeg version 4.x.x or higher
  ```

### 1.3 System Requirements

#### Minimum Requirements
- **CPU:** 2 cores
- **RAM:** 4 GB
- **Disk Space:** 10 GB free space
- **OS:** Windows 10/11, macOS 10.15+, or Linux (Ubuntu 20.04+)

#### Recommended Requirements
- **CPU:** 4+ cores
- **RAM:** 8+ GB
- **Disk Space:** 20+ GB free space (for media storage)
- **OS:** Windows 11, macOS 12+, or Linux (Ubuntu 22.04+)

### 1.4 Required Accounts/Credentials

- **GitHub Account** (if cloning from private repository)
- **Database Credentials** (will be configured in `.env`)
- **MinIO Credentials** (will be configured in `.env`)
- **JWT Secret** (will be generated during setup)

---

## 2. Initial Setup

### 2.1 Clone the Repository

```bash
# Clone the repository
git clone <repository-url>
cd server

# Verify you're in the correct directory
ls -la  # Should see package.json, src/, etc.
```

**Expected Output:**
```
drizzle.config.ts
docker-compose.yml
nodemon.json
package.json
src/
scripts/
README.md
...
```

### 2.2 Install Dependencies

```bash
# Install all npm dependencies
npm install
```

**Expected Output:**
```
added 250+ packages in 30s
```

**Verify Installation:**
```bash
# Check if node_modules exists
ls node_modules  # Should show many packages

# Verify TypeScript is installed
npx tsc --version  # Should show Version 5.3.3
```

### 2.3 Configure Environment Variables

#### Step 1: Copy the Example Environment File

```bash
# Copy .env.example to .env
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

#### Step 2: Edit the `.env` File

Open `.env` in your text editor and configure the following variables:

```bash
# ============================================
# SERVER CONFIGURATION
# ============================================

# Environment: development, production, or test
NODE_ENV=development

# Main API server port
PORT=3000

# Device server port (for mTLS device connections)
DEVICE_PORT=8443

# ============================================
# DATABASE CONFIGURATION
# ============================================

# PostgreSQL connection string
# Format: postgresql://username:password@host:port/database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/signhex

# Note: Change 'postgres' password in production!
# Example for production: postgresql://signhex_user:SecurePassword123@db.example.com:5432/signhex_prod

# ============================================
# JWT CONFIGURATION
# ============================================

# JWT secret key - MUST be at least 32 characters
# Generate a secure secret: openssl rand -base64 32
JWT_SECRET=your-secret-key-min-32-chars-long-here-CHANGE-THIS-IN-PRODUCTION

# JWT expiry time in seconds (900 = 15 minutes)
JWT_EXPIRY=900

# ============================================
# MINIO CONFIGURATION
# ============================================

# MinIO server endpoint (hostname or IP)
MINIO_ENDPOINT=localhost

# MinIO server port
MINIO_PORT=9000

# MinIO access credentials
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin

# Use SSL/TLS for MinIO connection (true/false)
MINIO_USE_SSL=false

# MinIO region (can be any value for local MinIO)
MINIO_REGION=us-east-1

# ============================================
# ADMIN USER (for initial seeding)
# ============================================

# Default admin user email
ADMIN_EMAIL=admin@hexmon.local

# Default admin user password
# CHANGE THIS IMMEDIATELY AFTER FIRST LOGIN!
ADMIN_PASSWORD=ChangeMe123!

# ============================================
# TLS/mTLS CONFIGURATION (Optional)
# ============================================

# Paths to TLS certificates (for device server)
TLS_CERT_PATH=./certs/server.crt
TLS_KEY_PATH=./certs/server.key
CA_CERT_PATH=./certs/ca.crt

# ============================================
# LOGGING CONFIGURATION
# ============================================

# Log level: trace, debug, info, warn, error, fatal
LOG_LEVEL=info

# ============================================
# FFMPEG CONFIGURATION (Optional)
# ============================================

# Path to FFmpeg binary
# Linux/Mac: ffmpeg
# Windows: C:/ffmpeg/bin/ffmpeg.exe
FFMPEG_PATH=ffmpeg

# ============================================
# PG-BOSS CONFIGURATION
# ============================================

# PostgreSQL schema for pg-boss tables
PG_BOSS_SCHEMA=pgboss
```

#### Step 3: Generate a Secure JWT Secret

**Linux/Mac:**
```bash
openssl rand -base64 32
```

**Windows (PowerShell):**
```powershell
# Generate random bytes and convert to base64
$bytes = New-Object byte[] 32
[Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

**Copy the output and replace `JWT_SECRET` in your `.env` file.**

#### Step 4: Verify Environment Configuration

```bash
# Check if .env file exists and has content
cat .env  # Linux/Mac
type .env # Windows

# Verify required variables are set
grep JWT_SECRET .env  # Should show your JWT secret
```

---

## 3. Development Environment Setup

### 3.1 Option A: Using Docker (Recommended)

This is the easiest way to get started. Docker will handle PostgreSQL and MinIO setup automatically.

#### Step 1: Start Services with Docker Compose

```bash
# Start PostgreSQL and MinIO in the background
docker-compose up -d postgres minio

# Wait for services to be healthy (about 10-15 seconds)
```

**Expected Output:**
```
[+] Running 2/2
 ✔ Container hexmon-postgres  Started
 ✔ Container hexmon-minio     Started
```

#### Step 2: Verify Services are Running

```bash
# Check if containers are running
docker ps

# Should show:
# - hexmon-postgres (port 5432)
# - hexmon-minio (ports 9000, 9001)
```

**Or use the built-in check script:**
```bash
npm run check
```

**Expected Output:**
```
✓ PostgreSQL is running on localhost:5432
✓ MinIO is running on localhost:9000
✓ All services are ready!
```

#### Step 3: Access MinIO Console (Optional)

Open your browser and go to: http://localhost:9001

- **Username:** minioadmin
- **Password:** minioadmin

You can use this to view buckets and uploaded files.

### 3.2 Option B: Manual Installation (Without Docker)

If you cannot use Docker, follow these steps to install PostgreSQL and MinIO manually.

#### Step 1: Install and Configure PostgreSQL

**Linux (Ubuntu/Debian):**
```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Create database and user
sudo -u postgres psql
```

**In PostgreSQL prompt:**
```sql
-- Create database
CREATE DATABASE signhex;

-- Create user (optional - or use default postgres user)
CREATE USER signhex_user WITH PASSWORD 'your_password';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE signhex TO signhex_user;

-- Exit
\q
```

**macOS (using Homebrew):**
```bash
# Install PostgreSQL
brew install postgresql@15

# Start PostgreSQL service
brew services start postgresql@15

# Create database
createdb signhex
```

**Windows:**
1. Download PostgreSQL installer from https://www.postgresql.org/download/windows/
2. Run the installer and follow the wizard
3. Remember the password you set for the `postgres` user
4. Open pgAdmin or use psql to create the `signhex` database

**Update `.env` file:**
```bash
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/signhex
```

#### Step 2: Install and Configure MinIO

**Linux:**
```bash
# Download MinIO
wget https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x minio

# Create data directory
mkdir -p ~/minio/data

# Start MinIO server
./minio server ~/minio/data --console-address ":9001"
```

**macOS:**
```bash
# Install MinIO using Homebrew
brew install minio/stable/minio

# Create data directory
mkdir -p ~/minio/data

# Start MinIO server
minio server ~/minio/data --console-address ":9001"
```

**Windows:**
1. Download MinIO from https://dl.min.io/server/minio/release/windows-amd64/minio.exe
2. Create a folder: `C:\minio\data`
3. Open PowerShell and run:
```powershell
.\minio.exe server C:\minio\data --console-address ":9001"
```

**MinIO will display:**
```
API: http://localhost:9000
Console: http://localhost:9001

RootUser: minioadmin
RootPass: minioadmin
```

**Keep MinIO running in this terminal.**

### 3.3 Initialize the Database

#### Step 1: Push Database Schema

```bash
# Push Drizzle schema to PostgreSQL
npm run db:push
```

**Expected Output:**
```
[✓] Changes applied successfully
```

**This creates all tables:**
- `users` - User accounts
- `sessions` - Active sessions
- `organizations` - Organizations/tenants
- `devices` - Digital signage devices
- `media` - Media files
- `playlists` - Content playlists
- `schedules` - Scheduling rules
- `pgboss.*` - Background job tables

#### Step 2: Seed Initial Data

```bash
# Create default admin user
npm run seed
```

**Expected Output:**
```
[INFO] Seeding database...
[INFO] Creating admin user: admin@hexmon.local
[INFO] Admin user created successfully
[INFO] Seeding complete!
```

**Default Admin Credentials:**
- **Email:** admin@hexmon.local
- **Password:** ChangeMe123!

**⚠️ IMPORTANT:** Change this password immediately after first login!

### 3.4 Start the Development Server

```bash
# Start development server with hot-reload
npm run dev
```

**Expected Output:**
```
[nodemon] starting `tsx src/index.ts`
[20:30:00.123] INFO (main): Loading configuration...
[20:30:00.234] INFO (main): Initializing database...
[20:30:00.345] INFO (main): Initializing S3/MinIO...
[20:30:00.456] INFO (main): Initializing background jobs...
[20:30:01.567] INFO (jobs): pg-boss initialized
[20:30:01.678] INFO (jobs): Job handlers registered
[20:30:02.789] INFO (main): Creating Fastify server...
[20:30:03.890] INFO (main): Server listening on port 3000
```

**The server is now running!**

- **API Base URL:** http://localhost:3000/api/v1
- **Swagger Documentation:** http://localhost:3000/docs
- **Health Check:** http://localhost:3000/health

### 3.5 Access API Documentation

Open your browser and navigate to:

**http://localhost:3000/docs**

You'll see the Swagger UI with all available API endpoints:
- Authentication endpoints (`/api/auth/*`)
- User management (`/api/users/*`)
- Organization management (`/api/organizations/*`)
- Device management (`/api/devices/*`)
- Media management (`/api/media/*`)
- Playlist management (`/api/playlists/*`)
- Schedule management (`/api/schedules/*`)

### 3.6 Test the API

#### Option 1: Using Swagger UI

1. Go to http://localhost:3000/docs
2. Click on `POST /api/auth/login`
3. Click "Try it out"
4. Enter credentials:
   ```json
   {
     "email": "admin@hexmon.local",
     "password": "ChangeMe123!"
   }
   ```
5. Click "Execute"
6. Copy the `token` from the response
7. Click "Authorize" button at the top
8. Enter: `Bearer <your-token>`
9. Now you can test other endpoints!

#### Option 2: Using cURL

```bash
# Login and get token
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hexmon.local","password":"ChangeMe123!"}'

# Response will include a token
# Copy the token and use it in subsequent requests

# Example: Get current user profile
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <your-token>"
```

#### Option 3: Using Postman or Insomnia

1. Import the OpenAPI spec from: http://localhost:3000/docs/json
2. Create a login request
3. Save the token to an environment variable
4. Use the token in other requests

---

## 4. Production Environment Setup

### 4.1 Prerequisites for Production

Before deploying to production, ensure you have:

- ✅ A production server (VPS, cloud instance, or dedicated server)
- ✅ Domain name (optional but recommended)
- ✅ SSL/TLS certificates (for HTTPS)
- ✅ Production PostgreSQL database
- ✅ Production MinIO instance or S3-compatible storage
- ✅ Reverse proxy (Nginx or Apache) configured
- ✅ Process manager (PM2, systemd, or Docker)
- ✅ Firewall configured
- ✅ Backup strategy in place

### 4.2 Production Environment Variables

Create a production `.env` file with secure values:

```bash
# ============================================
# PRODUCTION CONFIGURATION
# ============================================

NODE_ENV=production
PORT=3000
DEVICE_PORT=8443

# Use strong, unique passwords!
DATABASE_URL=postgresql://signhex_prod:STRONG_PASSWORD_HERE@db.example.com:5432/signhex_prod

# Generate with: openssl rand -base64 48
JWT_SECRET=VERY_LONG_RANDOM_SECRET_AT_LEAST_48_CHARS_LONG_HERE
JWT_EXPIRY=900

# Production MinIO or S3
MINIO_ENDPOINT=s3.example.com
MINIO_PORT=443
MINIO_ACCESS_KEY=YOUR_ACCESS_KEY
MINIO_SECRET_KEY=YOUR_SECRET_KEY
MINIO_USE_SSL=true
MINIO_REGION=us-east-1

# Strong admin password
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=VERY_STRONG_PASSWORD_HERE

# TLS certificates
TLS_CERT_PATH=/etc/ssl/certs/server.crt
TLS_KEY_PATH=/etc/ssl/private/server.key
CA_CERT_PATH=/etc/ssl/certs/ca.crt

# Production logging
LOG_LEVEL=warn

# FFmpeg
FFMPEG_PATH=ffmpeg

# pg-boss
PG_BOSS_SCHEMA=pgboss
```

**Security Checklist:**
- ✅ Use strong, unique passwords (20+ characters)
- ✅ Generate a long JWT secret (48+ characters)
- ✅ Enable SSL for MinIO (`MINIO_USE_SSL=true`)
- ✅ Use production database with restricted access
- ✅ Set `LOG_LEVEL=warn` or `error` in production
- ✅ Never commit `.env` to version control
- ✅ Use environment-specific `.env` files

### 4.3 Build the Application

```bash
# Install production dependencies only
npm ci --production=false

# Build TypeScript to JavaScript
npm run build
```

**Expected Output:**
```
> hexmon-signage-api@1.0.0 build
> tsc && tsc-alias

Successfully compiled TypeScript
```

**Verify Build:**
```bash
# Check if dist/ directory exists
ls dist/

# Should contain:
# index.js, config/, auth/, db/, routes/, etc.
```

### 4.4 Database Migration for Production

**⚠️ IMPORTANT:** Always backup your database before running migrations!

```bash
# Backup database first
pg_dump -U postgres -h localhost signhex_prod > backup_$(date +%Y%m%d_%H%M%S).sql

# Generate migration files (if schema changed)
npm run db:generate

# Review migration files in drizzle/migrations/

# Push schema to production database
npm run db:push

# Seed initial data (first time only)
npm run seed
```

### 4.5 Option A: Deploy with PM2 (Recommended)

PM2 is a production process manager for Node.js applications.

#### Step 1: Install PM2 Globally

```bash
npm install -g pm2
```

#### Step 2: Create PM2 Ecosystem File

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'hexmon-signage-api',
    script: './dist/index.js',
    instances: 'max',  // Use all CPU cores
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '1G',
  }]
};
```

#### Step 3: Start with PM2

```bash
# Start the application
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
# Follow the instructions shown
```

#### Step 4: Monitor with PM2

```bash
# View status
pm2 status

# View logs
pm2 logs hexmon-signage-api

# Monitor resources
pm2 monit

# Restart application
pm2 restart hexmon-signage-api

# Stop application
pm2 stop hexmon-signage-api
```

### 4.6 Option B: Deploy with systemd

For Linux servers, you can use systemd to manage the application.

#### Step 1: Create systemd Service File

Create `/etc/systemd/system/hexmon-signage.service`:

```ini
[Unit]
Description=Hexmon Signage API
After=network.target postgresql.service

[Service]
Type=simple
User=hexmon
WorkingDirectory=/opt/hexmon-signage/server
Environment=NODE_ENV=production
EnvironmentFile=/opt/hexmon-signage/server/.env
ExecStart=/usr/bin/node /opt/hexmon-signage/server/dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hexmon-signage

[Install]
WantedBy=multi-user.target
```

#### Step 2: Enable and Start Service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable hexmon-signage

# Start service
sudo systemctl start hexmon-signage

# Check status
sudo systemctl status hexmon-signage

# View logs
sudo journalctl -u hexmon-signage -f
```

### 4.7 Option C: Deploy with Docker

#### Step 1: Build Docker Image

```bash
# Build production image
docker build -t hexmon-signage-api:latest .
```

#### Step 2: Run with Docker Compose

Use the checked-in production-safe compose file:

```bash
docker compose up -d postgres minio api
```

Use the checked-in development override only when you explicitly want bind mounts and `npm run dev` inside the container:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres minio api
```

#### Step 3: Start Production Stack

```bash
# Start all services
docker compose up -d postgres minio api

# View logs
docker compose logs -f api
```

### 4.8 Configure Reverse Proxy (Nginx)

Create `/etc/nginx/sites-available/hexmon-signage`:

```nginx
# HTTP to HTTPS redirect
server {
    listen 80;
    server_name api.example.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name api.example.com;

    # SSL certificates
    ssl_certificate /etc/ssl/certs/api.example.com.crt;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Proxy to Node.js application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Increase upload size for media files
    client_max_body_size 100M;

    # Logging
    access_log /var/log/nginx/hexmon-access.log;
    error_log /var/log/nginx/hexmon-error.log;
}
```

Enable the site:

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/hexmon-signage /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### 4.9 Security Best Practices

#### Firewall Configuration

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow PostgreSQL (only from application server)
sudo ufw allow from <app-server-ip> to any port 5432

# Enable firewall
sudo ufw enable
```

#### Database Security

```sql
-- Create dedicated database user
CREATE USER signhex_app WITH PASSWORD 'strong_password';

-- Grant only necessary privileges
GRANT CONNECT ON DATABASE signhex_prod TO signhex_app;
GRANT USAGE ON SCHEMA public TO signhex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO signhex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO signhex_app;

-- Revoke public access
REVOKE ALL ON DATABASE signhex_prod FROM PUBLIC;
```

#### Environment Variables Security

```bash
# Set proper file permissions
chmod 600 .env

# Never commit .env to git
echo ".env" >> .gitignore
echo ".env.*" >> .gitignore
```

#### Rate Limiting

The application includes built-in rate limiting. Configure in production:

```typescript
// Already configured in src/server/index.ts
// Adjust limits as needed for your use case
```

#### CORS Configuration

Update CORS settings for production in `src/server/index.ts`:

```typescript
fastify.register(cors, {
  origin: ['https://yourdomain.com', 'https://app.yourdomain.com'],
  credentials: true,
});
```

---

## 5. Verification Steps

### 5.1 Verify Installation

```bash
# Check if all services are running
npm run check
```

**Expected Output:**
```
✓ PostgreSQL is running on localhost:5432
✓ MinIO is running on localhost:9000
✓ All services are ready!
```

### 5.2 Verify TypeScript Compilation

```bash
# Check for TypeScript errors
npx tsc --noEmit
```

**Expected Output:**
```
(No output means no errors - success!)
```

### 5.3 Verify Database Schema

```bash
# Open Drizzle Studio
npm run db:studio
```

**Expected:**
- Browser opens at http://localhost:4983
- You can see all tables (users, sessions, organizations, etc.)
- Tables have data (at least the admin user)

### 5.4 Verify API Endpoints

#### Health Check

```bash
curl http://localhost:3000/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-05T20:30:00.000Z",
  "uptime": 123.456
}
```

#### Login Test

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hexmon.local","password":"ChangeMe123!"}'
```

**Expected Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "...",
    "email": "admin@hexmon.local",
    "role": "admin"
  }
}
```

#### Protected Endpoint Test

```bash
# Replace <TOKEN> with the token from login response
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <TOKEN>"
```

**Expected Response:**
```json
{
  "id": "...",
  "email": "admin@hexmon.local",
  "role": "admin",
  "organizationId": "..."
}
```

### 5.5 Verify MinIO Buckets

```bash
# Check if buckets were created
# Open MinIO Console: http://localhost:9001
# Login with: minioadmin / minioadmin
```

**Expected Buckets:**
- media-source
- media-ready
- media-thumbnails
- device-screenshots
- logs-audit
- logs-system
- logs-auth
- logs-heartbeats
- logs-pop
- archives

### 5.6 Verify Background Jobs

```bash
# Check pg-boss tables in database
npm run db:studio

# Look for pgboss schema with tables:
# - job
# - archive
# - schedule
# - queue
```

### 5.7 Run Comprehensive Tests

```bash
# Run all verification scripts
npm run test:all
```

**Expected Output:**
```
✓ Build verification passed
✓ Import verification passed
✓ Code tests passed (65/65)
✓ All verifications successful!
```

---

## 6. Common Issues and Solutions

### 6.1 Development Issues

#### Issue: "Cannot connect to PostgreSQL"

**Error:**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solutions:**

1. **Check if PostgreSQL is running:**
   ```bash
   # Docker
   docker ps | grep postgres
   
   # Linux
   sudo systemctl status postgresql
   
   # macOS
   brew services list | grep postgresql
   ```

2. **Start PostgreSQL:**
   ```bash
   # Docker
   docker-compose up -d postgres
   
   # Linux
   sudo systemctl start postgresql
   
   # macOS
   brew services start postgresql@15
   ```

3. **Verify connection string in `.env`:**
   ```bash
   cat .env | grep DATABASE_URL
   # Should match your PostgreSQL configuration
   ```

4. **Test connection manually:**
   ```bash
   psql -h localhost -U postgres -d signhex
   # Enter password when prompted
   ```

#### Issue: "Cannot connect to MinIO"

**Error:**
```
Error: connect ECONNREFUSED 127.0.0.1:9000
```

**Solutions:**

1. **Check if MinIO is running:**
   ```bash
   # Docker
   docker ps | grep minio
   
   # Check if port 9000 is in use
   netstat -an | grep 9000  # Linux/Mac
   netstat -an | findstr 9000  # Windows
   ```

2. **Start MinIO:**
   ```bash
   # Docker
   docker-compose up -d minio
   
   # Manual
   minio server ~/minio/data --console-address ":9001"
   ```

3. **Verify MinIO credentials in `.env`:**
   ```bash
   cat .env | grep MINIO
   # Default: minioadmin / minioadmin
   ```

4. **Test MinIO access:**
   ```bash
   curl http://localhost:9000/minio/health/live
   # Should return: OK
   ```

#### Issue: "JWT_SECRET must be at least 32 characters"

**Error:**
```
Error: JWT_SECRET must be at least 32 characters long
```

**Solution:**

Generate a secure JWT secret:

```bash
# Linux/Mac
openssl rand -base64 32

# Windows PowerShell
$bytes = New-Object byte[] 32
[Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Update `.env`:
```bash
JWT_SECRET=<generated-secret-here>
```

#### Issue: "relation 'users' does not exist"

**Error:**
```
DatabaseError: relation "users" does not exist
```

**Solution:**

Push the database schema:

```bash
npm run db:push
```

If that doesn't work:

```bash
# Drop and recreate database
psql -U postgres
DROP DATABASE signhex;
CREATE DATABASE signhex;
\q

# Push schema again
npm run db:push

# Seed data
npm run seed
```

#### Issue: "Port 3000 is already in use"

**Error:**
```
Error: listen EADDRINUSE: address already in use :::3000
```

**Solutions:**

1. **Find and kill the process:**
   ```bash
   # Linux/Mac
   lsof -i :3000
   kill -9 <PID>
   
   # Windows
   netstat -ano | findstr :3000
   taskkill /PID <PID> /F
   ```

2. **Or change the port in `.env`:**
   ```bash
   PORT=3001
   ```

#### Issue: "MaxListenersExceededWarning"

**Warning:**
```
MaxListenersExceededWarning: Possible EventEmitter memory leak detected
```

**Solution:**

This warning is from tsx/nodemon (development tools) and is harmless. It's already fixed in the application code. You can safely ignore it.

To suppress the warning:
```bash
# Add to your shell profile
export NODE_NO_WARNINGS=1
```

#### Issue: "Queue cleanup not found" (pg-boss)

**Error:**
```
DatabaseError: Queue cleanup not found
Code: 23503
```

**Solution:**

This is expected and handled gracefully. The server continues without scheduled jobs. No action needed.

If you want to fix it permanently:

```sql
-- Connect to database
psql -U postgres -d signhex

-- Manually create queue entries
INSERT INTO pgboss.queue (name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds)
VALUES ('cleanup', 'standard', 2, 60, true, 900);

INSERT INTO pgboss.queue (name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds)
VALUES ('archive', 'standard', 2, 60, true, 900);
```

### 6.2 Production Issues

#### Issue: "502 Bad Gateway" (Nginx)

**Error:**
Browser shows "502 Bad Gateway"

**Solutions:**

1. **Check if application is running:**
   ```bash
   # PM2
   pm2 status
   
   # systemd
   sudo systemctl status hexmon-signage
   
   # Docker
   docker ps
   ```

2. **Check application logs:**
   ```bash
   # PM2
   pm2 logs hexmon-signage-api
   
   # systemd
   sudo journalctl -u hexmon-signage -f
   
   # Docker
   docker logs hexmon-api-prod
   ```

3. **Check Nginx configuration:**
   ```bash
   sudo nginx -t
   sudo systemctl status nginx
   ```

4. **Verify proxy_pass URL:**
   ```bash
   cat /etc/nginx/sites-available/hexmon-signage | grep proxy_pass
   # Should be: http://localhost:3000
   ```

#### Issue: "Database connection pool exhausted"

**Error:**
```
Error: Connection pool exhausted
```

**Solutions:**

1. **Increase connection pool size:**

   Edit `src/db/index.ts`:
   ```typescript
   export const pool = new Pool({
     connectionString: config.DATABASE_URL,
     max: 20,  // Increase from default 10
     idleTimeoutMillis: 30000,
     connectionTimeoutMillis: 2000,
   });
   ```

2. **Check for connection leaks:**
   ```sql
   -- Check active connections
   SELECT count(*) FROM pg_stat_activity WHERE datname = 'signhex_prod';
   
   -- Kill idle connections
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE datname = 'signhex_prod'
   AND state = 'idle'
   AND state_change < current_timestamp - INTERVAL '5 minutes';
   ```

3. **Restart application:**
   ```bash
   pm2 restart hexmon-signage-api
   ```

#### Issue: "Out of memory"

**Error:**
```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

**Solutions:**

1. **Increase Node.js memory limit:**

   PM2 ecosystem.config.js:
   ```javascript
   module.exports = {
     apps: [{
       name: 'hexmon-signage-api',
       script: './dist/index.js',
       node_args: '--max-old-space-size=2048',  // 2GB
       max_memory_restart: '2G',
     }]
   };
   ```

2. **Check for memory leaks:**
   ```bash
   pm2 monit
   # Watch memory usage over time
   ```

3. **Optimize queries and reduce memory usage**

#### Issue: "SSL certificate errors"

**Error:**
```
Error: unable to verify the first certificate
```

**Solutions:**

1. **For MinIO with self-signed certificates:**

   Add to `.env`:
   ```bash
   NODE_TLS_REJECT_UNAUTHORIZED=0  # Development only!
   ```

   **⚠️ Never use this in production!**

2. **For production, use proper SSL certificates:**
   ```bash
   # Let's Encrypt
   sudo certbot --nginx -d api.example.com
   ```

3. **Verify certificate chain:**
   ```bash
   openssl s_client -connect api.example.com:443 -showcerts
   ```

### 6.3 Getting Help

If you're still experiencing issues:

1. **Check the logs:**
   ```bash
   # Application logs
   pm2 logs hexmon-signage-api
   
   # System logs
   sudo journalctl -u hexmon-signage -f
   
   # Nginx logs
   sudo tail -f /var/log/nginx/hexmon-error.log
   ```

2. **Enable debug logging:**

   Update `.env`:
   ```bash
   LOG_LEVEL=debug
   ```

   Restart the application.

3. **Run verification scripts:**
   ```bash
   npm run check
   npm run verify
   npm run test:all
   ```

4. **Check documentation:**
   - `README.md` - Project overview
   - `DEVELOPMENT_GUIDE.md` - Development workflow
   - `FIXES_APPLIED.md` - Recent fixes
   - API docs: http://localhost:3000/docs

5. **Report an issue:**
   - GitHub Issues: <repository-url>/issues
   - Include: Error message, logs, environment details
   - Provide steps to reproduce

---

## 7. Additional Resources

### 7.1 Documentation

- **Project Documentation:**
  - `README.md` - Project overview and features
  - `DEVELOPMENT_GUIDE.md` - Development workflow and tips
  - `FIXES_APPLIED.md` - Recent bug fixes
  - `COMPREHENSIVE_CHECK_REPORT.md` - Project status

- **API Documentation:**
  - Swagger UI: http://localhost:3000/docs
  - OpenAPI JSON: http://localhost:3000/docs/json

- **External Documentation:**
  - [Fastify](https://www.fastify.io/docs/latest/)
  - [Drizzle ORM](https://orm.drizzle.team/docs/overview)
  - [pg-boss](https://github.com/timgit/pg-boss)
  - [MinIO](https://min.io/docs/minio/linux/index.html)
  - [PostgreSQL](https://www.postgresql.org/docs/)

### 7.2 Useful Commands Reference

```bash
# Development
npm run dev              # Start dev server with hot-reload
npm run dev:watch        # Alternative dev server
npm run build            # Build for production
npm start                # Start production server

# Database
npm run db:push          # Push schema to database
npm run db:generate      # Generate migration files
npm run db:studio        # Open Drizzle Studio

# Testing
npm run check            # Check services
npm run verify           # Verify build
npm run test:code        # Run code tests
npm run test:all         # Run all tests
npm test                 # Run integration tests

# Admin
npm run seed             # Seed initial data
npm run admin-cli        # Admin CLI tools

# Code Quality
npm run lint             # Run ESLint
npm run format           # Format with Prettier
npx tsc --noEmit         # Check TypeScript

# Process Management (PM2)
pm2 start ecosystem.config.js
pm2 status
pm2 logs
pm2 restart hexmon-signage-api
pm2 stop hexmon-signage-api
pm2 delete hexmon-signage-api

# Docker
docker-compose up -d                    # Start services
docker-compose down                     # Stop services
docker-compose logs -f api              # View logs
docker-compose restart api              # Restart service
docker ps                               # List containers
docker exec -it hexmon-postgres psql -U postgres  # Access database
```

### 7.3 Environment Variables Quick Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | development | Environment (development/production/test) |
| `PORT` | Yes | 3000 | Main API server port |
| `DEVICE_PORT` | Yes | 8443 | Device server port (mTLS) |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `JWT_SECRET` | Yes | - | JWT signing secret (32+ chars) |
| `JWT_EXPIRY` | Yes | 900 | JWT expiry in seconds |
| `MINIO_ENDPOINT` | Yes | localhost | MinIO server hostname |
| `MINIO_PORT` | Yes | 9000 | MinIO server port |
| `MINIO_ACCESS_KEY` | Yes | minioadmin | MinIO access key |
| `MINIO_SECRET_KEY` | Yes | minioadmin | MinIO secret key |
| `MINIO_USE_SSL` | Yes | false | Use SSL for MinIO |
| `MINIO_REGION` | Yes | us-east-1 | MinIO region |
| `ADMIN_EMAIL` | Yes | - | Default admin email |
| `ADMIN_PASSWORD` | Yes | - | Default admin password |
| `LOG_LEVEL` | No | info | Log level (trace/debug/info/warn/error/fatal) |
| `FFMPEG_PATH` | No | ffmpeg | Path to FFmpeg binary |
| `PG_BOSS_SCHEMA` | No | pgboss | pg-boss schema name |
| `TLS_CERT_PATH` | No | - | TLS certificate path |
| `TLS_KEY_PATH` | No | - | TLS private key path |
| `CA_CERT_PATH` | No | - | CA certificate path |

### 7.4 Port Reference

| Port | Service | Description |
|------|---------|-------------|
| 3000 | API Server | Main HTTP API |
| 8443 | Device Server | mTLS device connections |
| 5432 | PostgreSQL | Database |
| 9000 | MinIO API | Object storage API |
| 9001 | MinIO Console | MinIO web interface |
| 4983 | Drizzle Studio | Database management UI |

### 7.5 Default Credentials

**⚠️ CHANGE THESE IN PRODUCTION!**

| Service | Username | Password |
|---------|----------|----------|
| Admin User | admin@hexmon.local | ChangeMe123! |
| PostgreSQL | postgres | postgres |
| MinIO | minioadmin | minioadmin |

---

## Congratulations! 🎉

You've successfully set up the Hexmon Signage Backend!

**Next Steps:**
1. ✅ Change the default admin password
2. ✅ Explore the API documentation at http://localhost:3000/docs
3. ✅ Create your first organization
4. ✅ Add devices and media
5. ✅ Build amazing digital signage experiences!

**Need Help?**
- 📖 Read the documentation in the `docs/` folder
- 🐛 Report issues on GitHub
- 💬 Ask questions in team chat
- 📧 Contact support

**Happy Building! 🚀**

---

**Document Version:** 1.0.0  
**Last Updated:** 2025-11-05  
**Maintained By:** Hexmon Team
