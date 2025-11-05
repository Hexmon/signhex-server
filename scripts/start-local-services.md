# Starting Local Services for Hexmon Signage Backend

Since Docker is not available in your environment, you have several options to run the required services:

## Option 1: Install PostgreSQL Locally (Recommended)

### Windows Installation

1. **Download PostgreSQL:**
   - Visit: https://www.postgresql.org/download/windows/
   - Download the installer (PostgreSQL 15 or later)

2. **Install PostgreSQL:**
   - Run the installer
   - Set password for postgres user: `postgres`
   - Keep default port: `5432`
   - Complete installation

3. **Create Database:**
   ```powershell
   # Open PowerShell as Administrator
   cd "C:\Program Files\PostgreSQL\15\bin"
   .\psql.exe -U postgres
   # Enter password: postgres
   
   # In psql prompt:
   CREATE DATABASE hexmon;
   \q
   ```

4. **Verify Connection:**
   ```powershell
   npm run check
   ```

### Install MinIO Locally

1. **Download MinIO:**
   - Visit: https://min.io/download
   - Download Windows binary

2. **Run MinIO:**
   ```powershell
   # Create data directory
   mkdir C:\minio-data
   
   # Run MinIO server
   .\minio.exe server C:\minio-data --console-address ":9001"
   ```

3. **Keep MinIO running in a separate terminal**

## Option 2: Use Docker Desktop (If Available)

If you can install Docker Desktop:

1. **Install Docker Desktop:**
   - Download from: https://www.docker.com/products/docker-desktop/
   - Install and restart computer

2. **Start Services:**
   ```powershell
   docker-compose up -d postgres minio
   ```

3. **Verify:**
   ```powershell
   npm run check
   ```

## Option 3: Use Cloud Services (Development)

### PostgreSQL Cloud Options:
- **Supabase** (Free tier): https://supabase.com/
- **ElephantSQL** (Free tier): https://www.elephantsql.com/
- **Neon** (Free tier): https://neon.tech/

### MinIO Cloud Options:
- **MinIO Cloud**: https://min.io/product/cloud
- **AWS S3** (Compatible): https://aws.amazon.com/s3/

Update `.env` with cloud connection strings.

## Option 4: Development Mode (Limited Testing)

For basic code testing without full functionality, you can:

1. **Run TypeScript Verification:**
   ```powershell
   npx tsc --noEmit
   ```

2. **Run Build Verification:**
   ```powershell
   npm run verify
   ```

3. **Run Linting:**
   ```powershell
   npm run lint
   ```

4. **Build the Project:**
   ```powershell
   npm run build
   ```

## Recommended Setup for Development

**Easiest approach:**

1. Install PostgreSQL locally (15 minutes)
2. Install MinIO locally (5 minutes)
3. Run both services
4. Initialize database and start server

**Total setup time:** ~20 minutes

## After Services are Running

Once PostgreSQL and MinIO are running:

```powershell
# 1. Verify services
npm run check

# 2. Initialize database
npm run db:push

# 3. Seed initial data
npm run seed

# 4. Start development server
npm run dev

# 5. Access application
# - API: http://localhost:3000
# - Docs: http://localhost:3000/docs
# - Login: admin@hexmon.local / ChangeMe123!
```

## Troubleshooting

### PostgreSQL Connection Issues

**Error:** "password authentication failed"

**Solutions:**
1. Check password in `.env` matches PostgreSQL password
2. Verify PostgreSQL is running:
   ```powershell
   Get-Service -Name postgresql*
   ```
3. Check pg_hba.conf allows local connections

### MinIO Connection Issues

**Error:** "fetch failed"

**Solutions:**
1. Verify MinIO is running
2. Check port 9000 is not blocked
3. Test endpoint:
   ```powershell
   curl http://localhost:9000/minio/health/live
   ```

### Port Conflicts

If ports 3000, 5432, or 9000 are in use:

1. **Find process using port:**
   ```powershell
   netstat -ano | findstr :3000
   ```

2. **Kill process or change port in `.env`**

## Need Help?

If you're having trouble setting up services:

1. Check `SETUP.md` for detailed instructions
2. Review error messages from `npm run check`
3. Verify firewall settings allow local connections
4. Check Windows services are running

## Alternative: Request Docker Access

If you have administrative access, installing Docker Desktop is the easiest solution:
- One command starts all services
- Consistent environment
- Easy cleanup and reset
- No manual configuration needed

```powershell
# With Docker, it's just:
docker-compose up -d
npm run db:push
npm run seed
npm run dev
```

