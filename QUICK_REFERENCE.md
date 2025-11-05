# Hexmon Signage - Quick Reference

## Common Commands

### Development
```bash
npm run dev              # Start dev server with hot reload
npm run build            # Build for production
npm run lint             # Check code style
npm run format           # Format code
npm test                 # Run tests
npm run test:coverage    # Run tests with coverage
```

### Database
```bash
npm run migrate          # Run pending migrations
npm run migrate:generate # Generate migration from schema changes
npm run seed             # Seed initial data
```

### Admin CLI
```bash
npm run admin-cli create-admin      # Create admin user
npm run admin-cli list-users        # List all users
npm run admin-cli reset-password    # Reset user password
npm run admin-cli deactivate-user   # Deactivate user
npm run admin-cli cleanup-sessions  # Clean expired sessions
```

### Docker
```bash
docker-compose up -d                # Start local environment
docker-compose down                 # Stop local environment
docker-compose logs -f              # View logs
docker build -t hexmon-api .        # Build production image
```

### Backup
```bash
./scripts/backup_postgres.sh /path  # Backup PostgreSQL
./scripts/backup_minio.sh /path     # Backup MinIO
```

## API Endpoints

### Authentication
```
POST   /v1/auth/login       # Login
POST   /v1/auth/logout      # Logout
GET    /v1/auth/me          # Current user
```

### Users
```
POST   /v1/users            # Create user
GET    /v1/users            # List users
GET    /v1/users/:id        # Get user
PATCH  /v1/users/:id        # Update user
DELETE /v1/users/:id        # Delete user
```

### Media
```
POST   /v1/media/presign-upload  # Get upload URL
POST   /v1/media                 # Create media
GET    /v1/media                 # List media
GET    /v1/media/:id             # Get media
```

### Schedules
```
POST   /v1/schedules             # Create schedule
GET    /v1/schedules             # List schedules
GET    /v1/schedules/:id         # Get schedule
PATCH  /v1/schedules/:id         # Update schedule
POST   /v1/schedules/:id/publish # Publish schedule
```

### Screens
```
POST   /v1/screens           # Create screen
GET    /v1/screens           # List screens
GET    /v1/screens/:id       # Get screen
PATCH  /v1/screens/:id       # Update screen
DELETE /v1/screens/:id       # Delete screen
```

## Environment Variables

```bash
NODE_ENV=production
PORT=3000
DEVICE_PORT=8443
DATABASE_URL=postgresql://user:pass@host:5432/db
JWT_SECRET=your-secret-key-min-32-chars
JWT_EXPIRY=900
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_USE_SSL=false
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=password
LOG_LEVEL=info
```

## Project Structure

```
src/
├── auth/          # JWT, password hashing
├── config/        # Configuration
├── db/            # Database & repositories
├── rbac/          # Authorization
├── routes/        # API endpoints
├── s3/            # MinIO integration
├── schemas/       # Validation
├── server/        # Fastify setup
├── test/          # Test utilities
└── utils/         # Helpers
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Application entry point |
| `src/server/index.ts` | Fastify server setup |
| `src/db/schema.ts` | Database schema |
| `src/routes/` | API route handlers |
| `docker-compose.yml` | Local dev stack |
| `Dockerfile` | Production image |
| `.env.example` | Environment template |

## Ports

| Port | Service |
|------|---------|
| 3000 | API (HTTP) |
| 8443 | Device API (mTLS) |
| 5432 | PostgreSQL |
| 9000 | MinIO API |
| 9001 | MinIO Console |

## Roles & Permissions

| Role | Permissions |
|------|-------------|
| ADMIN | All operations |
| OPERATOR | View/manage content |
| DEPARTMENT | View/manage own content |

## Database Tables

- users
- sessions
- departments
- media
- presentations
- schedules
- screens
- device_certificates
- device_commands
- heartbeats
- proof_of_play
- screenshots
- requests
- notifications
- audit_logs
- system_logs
- login_attempts
- log_archives
- emergency_status
- settings

## Useful URLs

| URL | Purpose |
|-----|---------|
| http://localhost:3000 | API |
| http://localhost:3000/docs | Swagger UI |
| http://localhost:3000/health | Health check |
| http://localhost:9001 | MinIO Console |

## Troubleshooting

### Port in use
```bash
lsof -ti:3000 | xargs kill -9
```

### Database connection error
```bash
psql $DATABASE_URL
```

### MinIO connection error
```bash
mc alias set hexmon http://localhost:9000 minioadmin minioadmin
mc ls hexmon
```

### View logs
```bash
sudo journalctl -u signhex-api -f
```

## Documentation

- `README.md` - Quick start
- `API.md` - API documentation
- `DEPLOYMENT.md` - Production deployment
- `DEVELOPER_GUIDE.md` - Development guide
- `IMPLEMENTATION_STATUS.md` - Status & roadmap
- `PRODUCTION_CHECKLIST.md` - Deployment checklist

## Support

For issues:
1. Check logs: `npm run dev` or `journalctl -u signhex-api -f`
2. Review documentation
3. Check environment variables
4. Verify database/MinIO connectivity
5. Run tests: `npm test`

## Performance Tips

- Use pagination for list endpoints
- Add indexes for frequently queried columns
- Enable query caching
- Monitor database performance
- Use presigned URLs for direct uploads
- Implement rate limiting

## Security Reminders

- ✅ Always validate inputs with Zod
- ✅ Check authorization with CASL
- ✅ Use HTTPS in production
- ✅ Rotate secrets regularly
- ✅ Audit all mutations
- ✅ Keep dependencies updated
- ✅ Use environment variables for secrets

