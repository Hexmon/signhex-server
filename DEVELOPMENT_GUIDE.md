# Development Guide - Hexmon Signage Backend

**Quick reference for running and developing the Hexmon Signage Backend**

---

## 🚀 Quick Start

### Prerequisites

- ✅ Node.js 18+ installed
- ✅ PostgreSQL running (port 5432)
- ✅ MinIO running (port 9000)

### Start Development Server

```bash
# Start services (if using Docker)
docker-compose up -d postgres minio

# Verify services are running
npm run check

# Initialize database (first time only)
npm run db:push

# Seed initial data (first time only)
npm run seed

# Start development server with auto-reload
npm run dev
```

The server will start on `http://localhost:3000`

---

## 📝 Available Scripts

### Development

```bash
npm run dev          # Start dev server with nodemon (auto-reload)
npm run dev:watch    # Start dev server with tsx watch (alternative)
```

**Features:**
- ✅ Auto-restart on file changes
- ✅ Watches `src/**/*.ts` and `src/**/*.json`
- ✅ Type `rs` to manually restart
- ✅ 1-second delay before restart

### Building

```bash
npm run build        # Compile TypeScript to JavaScript
npm start            # Run compiled production build
```

### Database

```bash
npm run db:push      # Push schema changes to database
npm run db:generate  # Generate migration files
npm run db:studio    # Open Drizzle Studio (database UI)
npm run seed         # Seed initial data (admin user)
```

### Testing & Verification

```bash
npm run check        # Check if PostgreSQL and MinIO are running
npm run verify       # Verify build and imports
npm run test:code    # Run comprehensive code tests (no services needed)
npm run test:all     # Run all verification and tests
npm test             # Run integration tests (requires services)
npx tsc --noEmit     # Check TypeScript compilation
```

### Code Quality

```bash
npm run lint         # Run ESLint
npm run format       # Format code with Prettier
```

### Admin CLI

```bash
npm run admin-cli create-admin      # Create admin user
npm run admin-cli list-users        # List all users
npm run admin-cli reset-password    # Reset user password
npm run admin-cli deactivate-user   # Deactivate user
npm run admin-cli cleanup-sessions  # Clean expired sessions
```

---

## 🔧 Development Workflow

### 1. Starting Fresh

```bash
# Clone repository
git clone <repository-url>
cd server

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your settings
nano .env

# Start services
docker-compose up -d postgres minio

# Verify services
npm run check

# Initialize database
npm run db:push

# Seed data
npm run seed

# Start development
npm run dev
```

### 2. Daily Development

```bash
# Start services (if not running)
docker-compose up -d postgres minio

# Start development server
npm run dev

# Make changes to code
# Server will auto-reload on save

# To manually restart, type 'rs' in terminal
```

### 3. Testing Changes

```bash
# Run code tests (no services needed)
npm run test:code

# Run integration tests (requires services)
npm test

# Check TypeScript compilation
npx tsc --noEmit

# Verify build
npm run verify
```

### 4. Database Changes

```bash
# 1. Edit schema in src/db/schema.ts

# 2. Generate migration
npm run db:generate

# 3. Push changes to database
npm run db:push

# 4. Verify in Drizzle Studio
npm run db:studio
```

---

## 🐛 Troubleshooting

### Server Won't Start

**Error:** `ECONNREFUSED ::1:9000` or `ECONNREFUSED 127.0.0.1:9000`

**Solution:**
```bash
# Check if MinIO is running
docker ps | grep minio

# If not running, start it
docker-compose up -d minio

# Verify
npm run check
```

**Error:** `password authentication failed for user "postgres"`

**Solution:**
```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# If not running, start it
docker-compose up -d postgres

# Verify connection
npm run check

# Check .env file has correct credentials
cat .env | grep DATABASE_URL
```

### Database Errors

**Error:** `relation "users" does not exist`

**Solution:**
```bash
# Push schema to database
npm run db:push

# Seed initial data
npm run seed
```

**Error:** `Queue cleanup not found` (pg-boss)

**Solution:**
- This is expected and handled gracefully
- Server continues without scheduled jobs
- Jobs can be triggered manually via API
- No action needed

### TypeScript Errors

**Error:** `Cannot find module '@/...'`

**Solution:**
```bash
# Rebuild
npm run build

# Check tsconfig.json paths are correct
cat tsconfig.json | grep paths
```

### MaxListenersExceededWarning

**Warning:** `MaxListenersExceededWarning: Possible EventEmitter memory leak detected`

**Solution:**
- This warning is from tsx/nodemon (development tools)
- It's cosmetic and doesn't affect functionality
- Can be safely ignored
- Already fixed in application code

### Port Already in Use

**Error:** `EADDRINUSE: address already in use :::3000`

**Solution:**
```bash
# Find process using port 3000
# Windows:
netstat -ano | findstr :3000

# Linux/Mac:
lsof -i :3000

# Kill the process
# Windows:
taskkill /PID <PID> /F

# Linux/Mac:
kill -9 <PID>

# Or change port in .env
echo "PORT=3001" >> .env
```

---

## 📁 Project Structure

```
server/
├── src/
│   ├── auth/              # Authentication (JWT, passwords)
│   ├── config/            # Configuration management
│   ├── db/                # Database (schema, repositories)
│   ├── jobs/              # Background jobs (pg-boss)
│   ├── middleware/        # Fastify middleware
│   ├── rbac/              # Role-based access control
│   ├── routes/            # API routes
│   ├── s3/                # MinIO/S3 client
│   ├── schemas/           # Zod validation schemas
│   ├── server/            # Fastify server setup
│   ├── test/              # Test helpers
│   ├── utils/             # Utilities (logger, etc.)
│   └── index.ts           # Application entry point
├── scripts/               # Utility scripts
├── .env                   # Environment variables
├── .env.example           # Environment template
├── docker-compose.yml     # Docker services
├── drizzle.config.ts      # Drizzle ORM config
├── nodemon.json           # Nodemon config
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
└── README.md              # Project documentation
```

---

## 🔐 Environment Variables

### Required Variables

```bash
# Server
NODE_ENV=development
PORT=3000
DEVICE_PORT=8443

# Database
DATABASE_URL=postgresql://postgres:root@localhost:5432/signhex

# JWT
JWT_SECRET=your-secret-key-min-32-chars-long-here
JWT_EXPIRY=900

# MinIO
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_USE_SSL=false
MINIO_REGION=us-east-1

# Admin User (for seeding)
ADMIN_EMAIL=admin@hexmon.local
ADMIN_PASSWORD=ChangeMe123!

# Logging
LOG_LEVEL=info
```

### Optional Variables

```bash
# TLS/mTLS (for device server)
TLS_CERT_PATH=./certs/server.crt
TLS_KEY_PATH=./certs/server.key
CA_CERT_PATH=./certs/ca.crt

# FFmpeg
FFMPEG_PATH=/usr/bin/ffmpeg

# pg-boss
PG_BOSS_SCHEMA=pgboss
```

---

## 🎯 Common Tasks

### Create Admin User

```bash
npm run seed
# or
npm run admin-cli create-admin
```

### Reset User Password

```bash
npm run admin-cli reset-password
```

### View Database

```bash
npm run db:studio
# Opens Drizzle Studio at http://localhost:4983
```

### Check Service Health

```bash
npm run check
```

### View Logs

```bash
# Development server logs are shown in terminal

# Docker logs
docker-compose logs -f postgres
docker-compose logs -f minio
```

### Restart Development Server

```bash
# In the terminal running npm run dev, type:
rs

# Or stop and restart:
Ctrl+C
npm run dev
```

---

## 📚 API Documentation

Once the server is running, access the API documentation at:

- **Swagger UI:** http://localhost:3000/docs
- **OpenAPI JSON:** http://localhost:3000/docs/json

---

## 🔄 Git Workflow

```bash
# Create feature branch
git checkout -b feature/my-feature

# Make changes and commit
git add .
git commit -m "feat: add new feature"

# Push to remote
git push origin feature/my-feature

# Create pull request on GitHub/GitLab
```

---

## 📦 Dependencies

### Production Dependencies

- **fastify** - Web framework
- **drizzle-orm** - Database ORM
- **pg** - PostgreSQL client
- **pg-boss** - Background job queue
- **@aws-sdk/client-s3** - MinIO/S3 client
- **jose** - JWT handling
- **argon2** - Password hashing
- **pino** - Logging
- **zod** - Schema validation
- **@casl/ability** - RBAC

### Development Dependencies

- **typescript** - TypeScript compiler
- **tsx** - TypeScript executor
- **nodemon** - Auto-reload dev server
- **drizzle-kit** - Database migrations
- **vitest** - Testing framework
- **eslint** - Code linting
- **prettier** - Code formatting

---

## 🎓 Learning Resources

### Documentation

- [Fastify Documentation](https://www.fastify.io/docs/latest/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [pg-boss Documentation](https://github.com/timgit/pg-boss)
- [MinIO Documentation](https://min.io/docs/minio/linux/index.html)
- [Zod Documentation](https://zod.dev/)

### Project Documentation

- `README.md` - Project overview
- `SETUP.md` - Setup instructions
- `FIXES_APPLIED.md` - Recent fixes
- `COMPREHENSIVE_CHECK_REPORT.md` - Project status
- `PROJECT_STATUS_DASHBOARD.md` - Visual dashboard

---

## 💡 Tips & Best Practices

### Development

1. **Use nodemon for development** - Auto-reload saves time
2. **Check services before starting** - Run `npm run check`
3. **Use Drizzle Studio** - Visual database management
4. **Test changes** - Run `npm run test:code` frequently
5. **Check TypeScript** - Run `npx tsc --noEmit` before committing

### Code Quality

1. **Follow TypeScript strict mode** - Enabled in tsconfig.json
2. **Use Zod for validation** - All API inputs validated
3. **Add JSDoc comments** - Document complex functions
4. **Handle errors gracefully** - Use try-catch blocks
5. **Log important events** - Use pino logger

### Database

1. **Always generate migrations** - Don't push schema directly in production
2. **Test migrations** - Verify in development first
3. **Backup before migrations** - In production
4. **Use transactions** - For multi-step operations
5. **Index frequently queried fields** - Improve performance

### Security

1. **Never commit .env** - Already in .gitignore
2. **Use strong JWT secrets** - Min 32 characters
3. **Hash passwords** - Using argon2
4. **Validate all inputs** - Using Zod schemas
5. **Use RBAC** - Check permissions on all routes

---

## 🆘 Getting Help

### Resources

1. **Project Documentation** - Check `docs/` folder
2. **API Documentation** - http://localhost:3000/docs
3. **GitHub Issues** - Report bugs and request features
4. **Team Chat** - Ask questions in team channel

### Debugging

1. **Check logs** - Server logs show detailed errors
2. **Use Drizzle Studio** - Inspect database state
3. **Run verification** - `npm run verify`
4. **Check services** - `npm run check`
5. **Read error messages** - They're usually helpful!

---

**Happy Coding! 🚀**
