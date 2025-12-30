# Hexmon Signage Backend - Quick Start Guide

**⚡ Get up and running in 5 minutes!**

This is a condensed version of the full [SETUP_GUIDE.md](./SETUP_GUIDE.md). For detailed instructions, troubleshooting, and production deployment, please refer to the complete guide.

---

## Prerequisites

- ✅ Node.js 18+ installed
- ✅ Docker Desktop installed (recommended)
- ✅ Git installed

**Check your versions:**
```bash
node --version  # Should be v18.x.x or higher
docker --version # Should be 20.x.x or higher
```

---

## Quick Setup (5 Steps)

### Step 1: Clone and Install

```bash
# Clone the repository
git clone <repository-url>
cd server

# Install dependencies
npm install
```

### Step 2: Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Generate a secure JWT secret
openssl rand -base64 32

# Edit .env and paste the JWT secret
# Windows: notepad .env
# Mac/Linux: nano .env
```

**Minimum required changes in `.env`:**
```bash
JWT_SECRET=<paste-your-generated-secret-here>
```

**Optional: Change database name if needed:**
```bash
DATABASE_URL=postgresql://postgres:root@localhost:5432/signhex
```

### Step 3: Start Services

```bash
# Start PostgreSQL and MinIO with Docker
docker-compose up -d postgres minio

# Wait 10 seconds for services to start
# Then verify they're running
npm run check
```

**Expected output:**
```
✓ PostgreSQL is running on localhost:5432
✓ MinIO is running on localhost:9000
✓ All services are ready!
```

### Step 4: Initialize Database

```bash
# Create database tables
npm run db:push

# Create default admin user
npm run seed
```

**Default admin credentials:**
- **Email:** admin@hexmon.local
- **Password:** ChangeMe123!

### Step 5: Start Development Server

```bash
# Start the server with hot-reload
npm run dev
```

**Expected output:**
```
[INFO] Server listening on port 3000
```

---

## Access the Application

Once the server is running:

- **API Base URL:** http://localhost:3000/api/v1
- **API Documentation (Swagger):** http://localhost:3000/docs
- **Health Check:** http://localhost:3000/health
- **MinIO Console:** http://localhost:9001 (minioadmin / minioadmin)

---

## Test the API

### Option 1: Using Swagger UI

1. Open http://localhost:3000/docs
2. Click on `POST /api/v1/auth/login`
3. Click "Try it out"
4. Enter:
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
9. Now you can test all endpoints!

### Option 2: Using cURL

```bash
# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hexmon.local","password":"ChangeMe123!"}'

# Copy the token from the response

# Get your profile
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <your-token>"
```

---

## Common Issues

### Issue: "Cannot connect to PostgreSQL"

**Solution:**
```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# If not running, start it
docker-compose up -d postgres

# Verify
npm run check
```

### Issue: "Cannot connect to MinIO"

**Solution:**
```bash
# Check if MinIO is running
docker ps | grep minio

# If not running, start it
docker-compose up -d minio

# Verify
npm run check
```

### Issue: "JWT_SECRET must be at least 32 characters"

**Solution:**
```bash
# Generate a new secret
openssl rand -base64 32

# Update .env file with the generated secret
```

### Issue: "Port 3000 is already in use"

**Solution:**
```bash
# Find and kill the process
# Linux/Mac:
lsof -i :3000
kill -9 <PID>

# Windows:
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Or change the port in .env
echo "PORT=3001" >> .env
```

### Issue: "relation 'users' does not exist"

**Solution:**
```bash
# Push database schema
npm run db:push

# Seed data
npm run seed
```

---

## Useful Commands

```bash
# Development
npm run dev              # Start dev server with hot-reload
npm run build            # Build for production
npm start                # Start production server

# Database
npm run db:push          # Push schema to database
npm run db:studio        # Open database UI (http://localhost:4983)
npm run seed             # Create admin user

# Verification
npm run check            # Check if services are running
npm run verify           # Verify build
npm run test:code        # Run tests
npm run test:all         # Run all tests

# Admin Tools
npm run admin-cli        # Admin CLI utilities
```

---

## Next Steps

Now that your development environment is set up:

1. ✅ **Change the admin password** (important!)
   - Login at http://localhost:3000/docs
   - Use the `PUT /api/v1/auth/password` endpoint

2. ✅ **Explore the API**
   - Check out http://localhost:3000/docs
   - Try different endpoints
   - Read the API documentation

3. ✅ **Read the documentation**
   - [SETUP_GUIDE.md](./SETUP_GUIDE.md) - Complete setup guide
   - [DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md) - Development workflow
   - [README.md](./README.md) - Project overview

4. ✅ **Start building**
   - Create organizations
   - Add devices
   - Upload media
   - Create playlists
   - Schedule content

---

## Need Help?

### Documentation

- **[SETUP_GUIDE.md](./SETUP_GUIDE.md)** - Complete setup and deployment guide
- **[DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)** - Development workflow and tips
- **[FIXES_APPLIED.md](./FIXES_APPLIED.md)** - Recent bug fixes
- **[README.md](./README.md)** - Project overview

### Troubleshooting

If you encounter issues:

1. Check the [Common Issues](#common-issues) section above
2. Read the full troubleshooting guide in [SETUP_GUIDE.md](./SETUP_GUIDE.md#6-common-issues-and-solutions)
3. Check application logs: `npm run dev` (watch the console output)
4. Enable debug logging: Set `LOG_LEVEL=debug` in `.env`
5. Run verification: `npm run check` and `npm run verify`

### Getting Support

- 📖 Read the documentation
- 🐛 Report issues on GitHub
- 💬 Ask in team chat
- 📧 Contact support

---

## Production Deployment

For production deployment instructions, including:
- Production environment configuration
- Building and deploying with PM2, systemd, or Docker
- Nginx reverse proxy setup
- SSL/TLS configuration
- Security best practices
- Database migration strategies
- Monitoring and logging

**Please refer to the complete [SETUP_GUIDE.md](./SETUP_GUIDE.md#4-production-environment-setup)**

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                     Signhex Backend                        │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Fastify    │  │  PostgreSQL  │  │    MinIO     │      │
│  │  Web Server  │──│   Database   │  │   Storage    │      │
│  │  (Port 3000) │  │  (Port 5432) │  │  (Port 9000) │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                  │                  │            │
│         │                  │                  │            │
│  ┌──────▼──────────────────▼──────────────────▼──────┐     │
│  │                                                   │     │
│  │              Application Layer                    │     │
│  │                                                   │     │
│  │  • JWT Authentication                             │     │
│  │  • RBAC (Role-Based Access Control)               │     │
│  │  • RESTful API Endpoints                          │     │
│  │  • Background Jobs (pg-boss)                      │     │
│  │  • Media Processing (FFmpeg)                      │     │
│  │  • Audit Logging                                  │     │
│  │  • WebSocket Support                              │     │
│  │  • mTLS Device Authentication                     │     │
│  │                                                   │     │
│  └───────────────────────────────────────────────────┘     │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
server/
├── src/
│   ├── auth/              # JWT, password hashing
│   ├── config/            # Configuration management
│   ├── db/                # Database schema & repositories
│   ├── jobs/              # Background jobs (pg-boss)
│   ├── middleware/        # Fastify middleware
│   ├── rbac/              # Role-based access control
│   ├── routes/            # API route handlers
│   ├── s3/                # MinIO/S3 integration
│   ├── schemas/           # Zod validation schemas
│   ├── server/            # Fastify server setup
│   ├── test/              # Test helpers
│   ├── utils/             # Utility functions
│   └── index.ts           # Application entry point
├── scripts/               # Utility scripts
├── .env                   # Environment variables (create from .env.example)
├── .env.example           # Environment template
├── docker-compose.yml     # Docker services
├── drizzle.config.ts      # Drizzle ORM config
├── nodemon.json           # Nodemon config
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
└── README.md              # Project documentation
```

---

## API Endpoints Overview

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login and get JWT token
- `POST /api/v1/auth/logout` - Logout (invalidate token)
- `GET /api/v1/auth/me` - Get current user profile
- `PUT /api/v1/auth/password` - Change password

### Users
- `GET /api/v1/users` - List users
- `GET /api/v1/users/:id` - Get user by ID
- `PUT /api/v1/users/:id` - Update user
- `DELETE /api/v1/users/:id` - Delete user

### Organizations
- `GET /api/v1/organizations` - List organizations
- `POST /api/v1/organizations` - Create organization
- `GET /api/v1/organizations/:id` - Get organization
- `PUT /api/v1/organizations/:id` - Update organization
- `DELETE /api/v1/organizations/:id` - Delete organization

### Devices
- `GET /api/v1/devices` - List devices
- `POST /api/v1/devices` - Register device
- `GET /api/v1/devices/:id` - Get device
- `PUT /api/v1/devices/:id` - Update device
- `DELETE /api/v1/devices/:id` - Delete device

### Media
- `GET /api/v1/media` - List media files
- `POST /api/v1/media` - Upload media
- `GET /api/v1/media/:id` - Get media details
- `PUT /api/v1/media/:id` - Update media
- `DELETE /api/v1/media/:id` - Delete media

### Playlists
- `GET /api/v1/playlists` - List playlists
- `POST /api/v1/playlists` - Create playlist
- `GET /api/v1/playlists/:id` - Get playlist
- `PUT /api/v1/playlists/:id` - Update playlist
- `DELETE /api/v1/playlists/:id` - Delete playlist

### Schedules
- `GET /api/v1/schedules` - List schedules
- `POST /api/v1/schedules` - Create schedule
- `GET /api/v1/schedules/:id` - Get schedule
- `PUT /api/v1/schedules/:id` - Update schedule
- `DELETE /api/v1/schedules/:id` - Delete schedule

**For complete API documentation, visit:** http://localhost:3000/docs

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | development | Environment mode |
| `PORT` | Yes | 3000 | Main API port |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `JWT_SECRET` | Yes | - | JWT signing secret (32+ chars) |
| `JWT_EXPIRY` | Yes | 900 | JWT expiry (seconds) |
| `MINIO_ENDPOINT` | Yes | localhost | MinIO hostname |
| `MINIO_PORT` | Yes | 9000 | MinIO port |
| `MINIO_ACCESS_KEY` | Yes | minioadmin | MinIO access key |
| `MINIO_SECRET_KEY` | Yes | minioadmin | MinIO secret key |
| `ADMIN_EMAIL` | Yes | - | Default admin email |
| `ADMIN_PASSWORD` | Yes | - | Default admin password |
| `LOG_LEVEL` | No | info | Log level |

**For complete environment variables reference, see:** [SETUP_GUIDE.md](./SETUP_GUIDE.md#73-environment-variables-quick-reference)

---

## Success! 🎉

You're all set! Your Hexmon Signage Backend is now running.

**What's next?**
1. Explore the API at http://localhost:3000/docs
2. Change the default admin password
3. Create your first organization
4. Add devices and media
5. Build amazing digital signage experiences!

**Happy coding! 🚀**

---

**Document Version:** 1.0.0  
**Last Updated:** 2025-11-05  
**For detailed instructions:** [SETUP_GUIDE.md](./SETUP_GUIDE.md)
