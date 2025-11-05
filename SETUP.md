# Hexmon Signage Backend - Setup Guide

This guide will help you set up and run the Hexmon Signage Backend locally.

## Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose (recommended) OR
- PostgreSQL 14+ and MinIO installed locally

## Quick Start with Docker

### 1. Start Required Services

```bash
# Start PostgreSQL and MinIO
docker-compose up -d postgres minio

# Verify services are running
npm run check
```

### 2. Initialize Database

```bash
# Push database schema
npm run db:push

# Seed initial data (creates admin user)
npm run seed
```

### 3. Start Development Server

```bash
npm run dev
```

The API will be available at:
- Main API: http://localhost:3000
- API Documentation: http://localhost:3000/docs
- Device API (mTLS): https://localhost:8443

## Manual Setup (Without Docker)

### 1. Install PostgreSQL

**Windows:**
- Download from https://www.postgresql.org/download/windows/
- Install with default settings
- Create database: `createdb hexmon`

**macOS:**
```bash
brew install postgresql@15
brew services start postgresql@15
createdb hexmon
```

**Linux:**
```bash
sudo apt-get install postgresql-15
sudo systemctl start postgresql
sudo -u postgres createdb hexmon
```

### 2. Install MinIO

**Windows:**
- Download from https://min.io/download
- Run: `minio.exe server C:\minio-data --console-address ":9001"`

**macOS:**
```bash
brew install minio/stable/minio
minio server ~/minio-data --console-address ":9001"
```

**Linux:**
```bash
wget https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x minio
./minio server ~/minio-data --console-address ":9001"
```

### 3. Configure Environment

Copy `.env` file and update if needed:
```bash
cp .env .env.local
# Edit .env.local with your settings
```

### 4. Initialize Database

```bash
npm run db:push
npm run seed
```

### 5. Start Server

```bash
npm run dev
```

## Verification

### Check Services

```bash
npm run check
```

Expected output:
```
✅ PostgreSQL is accessible
✅ MinIO is accessible
✅ All services are healthy!
```

### Test API

```bash
# Health check
curl http://localhost:3000/health

# Login with default admin
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hexmon.local","password":"ChangeMe123!"}'
```

## Default Credentials

After running `npm run seed`:
- **Email:** admin@hexmon.local
- **Password:** ChangeMe123!

⚠️ **Change these credentials in production!**

## Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run check` - Check service health
- `npm run db:push` - Push schema to database
- `npm run db:generate` - Generate migrations
- `npm run db:studio` - Open Drizzle Studio
- `npm run seed` - Seed database with initial data
- `npm run admin-cli` - Admin CLI tool
- `npm test` - Run tests
- `npm run lint` - Lint code
- `npm run format` - Format code

## Troubleshooting

### PostgreSQL Connection Failed

1. Check if PostgreSQL is running:
   ```bash
   # Docker
   docker ps | grep postgres
   
   # Local (Linux/macOS)
   pg_isready
   ```

2. Verify credentials in `.env`:
   ```
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hexmon
   ```

3. Check PostgreSQL logs:
   ```bash
   # Docker
   docker logs hexmon-postgres
   ```

### MinIO Connection Failed

1. Check if MinIO is running:
   ```bash
   # Docker
   docker ps | grep minio
   
   # Test endpoint
   curl http://localhost:9000/minio/health/live
   ```

2. Verify credentials in `.env`:
   ```
   MINIO_ACCESS_KEY=minioadmin
   MINIO_SECRET_KEY=minioadmin
   ```

### Port Already in Use

If port 3000 or 8443 is already in use, change in `.env`:
```
PORT=3001
DEVICE_PORT=8444
```

## Next Steps

1. **Explore API Documentation:** http://localhost:3000/docs
2. **Create Users:** Use the admin CLI or API
3. **Upload Media:** Test media upload endpoints
4. **Configure Screens:** Set up digital signage screens
5. **Create Presentations:** Build content playlists
6. **Schedule Content:** Assign presentations to screens

## Production Deployment

See `docs/deployment.md` for production deployment instructions.

## Support

For issues and questions:
- Check documentation in `docs/` folder
- Review API documentation at `/docs` endpoint
- Check logs with `docker-compose logs` or application logs

