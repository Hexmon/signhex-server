# Hexmon Signage - Production Checklist

## Pre-Deployment

### Code Quality
- [ ] All tests passing (`npm test`)
- [ ] Test coverage ≥70% (`npm run test:coverage`)
- [ ] No linting errors (`npm run lint`)
- [ ] Code formatted (`npm run format`)
- [ ] TypeScript compilation successful (`npm run build`)
- [ ] No security vulnerabilities (`npm audit`)

### Documentation
- [ ] README.md reviewed and updated
- [ ] API.md complete with all endpoints
- [ ] DEPLOYMENT.md reviewed
- [ ] DEVELOPER_GUIDE.md complete
- [ ] Environment variables documented
- [ ] Architecture diagram created
- [ ] Runbooks written for common tasks

### Configuration
- [ ] `.env.example` created with all variables
- [ ] Production `.env` configured
- [ ] Database URL verified
- [ ] MinIO credentials configured
- [ ] JWT secret generated (min 32 chars)
- [ ] Admin credentials set
- [ ] TLS certificates prepared

### Database
- [ ] PostgreSQL 14+ installed
- [ ] Database created
- [ ] User created with proper permissions
- [ ] Migrations tested on fresh database
- [ ] Backup strategy defined
- [ ] Restore procedure tested

### Storage
- [ ] MinIO installed and configured
- [ ] All 10 buckets created
- [ ] Bucket policies configured
- [ ] Backup strategy defined
- [ ] Restore procedure tested

### Infrastructure
- [ ] Server provisioned (CPU, RAM, disk)
- [ ] Network configured (firewall, ports)
- [ ] SSL/TLS certificates obtained
- [ ] Reverse proxy (Nginx) configured
- [ ] Load balancer configured (if needed)
- [ ] Monitoring tools installed

### Security
- [ ] Firewall rules configured
- [ ] SSH key-based authentication enabled
- [ ] Sudo access restricted
- [ ] Secrets management configured
- [ ] Audit logging enabled
- [ ] Rate limiting configured
- [ ] CORS properly configured
- [ ] Security headers enabled

## Deployment

### Pre-Deployment
- [ ] Backup current database
- [ ] Backup current MinIO data
- [ ] Notify stakeholders
- [ ] Prepare rollback plan
- [ ] Test deployment in staging

### Deployment Steps
- [ ] Build Docker image
- [ ] Push to registry
- [ ] Pull latest code
- [ ] Install dependencies (`npm ci`)
- [ ] Run migrations (`npm run migrate`)
- [ ] Seed initial data (`npm run seed`)
- [ ] Start application
- [ ] Verify health check (`GET /health`)
- [ ] Test critical endpoints

### Post-Deployment
- [ ] Verify all endpoints working
- [ ] Check logs for errors
- [ ] Monitor resource usage
- [ ] Test user authentication
- [ ] Test media upload
- [ ] Test schedule publishing
- [ ] Verify audit logs
- [ ] Confirm backups running

## Monitoring & Maintenance

### Daily
- [ ] Check application logs
- [ ] Monitor error rates
- [ ] Verify backups completed
- [ ] Check disk space
- [ ] Monitor database performance

### Weekly
- [ ] Review audit logs
- [ ] Check security alerts
- [ ] Verify backup integrity
- [ ] Review performance metrics
- [ ] Check for updates

### Monthly
- [ ] Full backup test
- [ ] Disaster recovery drill
- [ ] Security audit
- [ ] Performance optimization
- [ ] Capacity planning

### Quarterly
- [ ] Dependency updates
- [ ] Security patches
- [ ] Database optimization
- [ ] Architecture review
- [ ] Capacity upgrade planning

## Operational Procedures

### User Management
```bash
# Create admin user
npm run admin-cli create-admin

# List users
npm run admin-cli list-users

# Reset password
npm run admin-cli reset-password

# Deactivate user
npm run admin-cli deactivate-user
```

### Database Maintenance
```bash
# Backup database
./scripts/backup_postgres.sh /var/backups/hexmon

# Backup MinIO
./scripts/backup_minio.sh /var/backups/hexmon

# Cleanup expired sessions
npm run admin-cli cleanup-sessions
```

### Service Management
```bash
# Start service
sudo systemctl start signhex-api

# Stop service
sudo systemctl stop signhex-api

# Restart service
sudo systemctl restart signhex-api

# View logs
sudo journalctl -u signhex-api -f

# Check status
sudo systemctl status signhex-api
```

## Troubleshooting

### Application Won't Start
1. Check logs: `sudo journalctl -u signhex-api -f`
2. Verify environment variables: `cat /etc/hexmon/api.env`
3. Test database connection: `psql $DATABASE_URL`
4. Test MinIO connection: `mc ls hexmon`

### High Memory Usage
1. Check for memory leaks: `node --inspect`
2. Review logs for errors
3. Restart application
4. Scale horizontally if needed

### Database Connection Issues
1. Verify PostgreSQL is running
2. Check connection string
3. Verify firewall rules
4. Check database user permissions

### MinIO Connection Issues
1. Verify MinIO is running
2. Check credentials
3. Verify firewall rules
4. Check bucket permissions

## Rollback Procedure

If deployment fails:

```bash
# Stop application
sudo systemctl stop signhex-api

# Restore previous version
git checkout <previous-tag>
npm ci --production
npm run build

# Restore database from backup
psql hexmon < /var/backups/hexmon/hexmon_postgres_*.sql

# Start application
sudo systemctl start signhex-api

# Verify
curl http://localhost:3000/health
```

## Performance Targets

- API Response Time: <200ms (p95)
- Database Query Time: <100ms (p95)
- Uptime: 99.9%
- Error Rate: <0.1%
- CPU Usage: <70%
- Memory Usage: <80%
- Disk Usage: <85%

## Escalation Contacts

- **On-Call Engineer**: [Contact Info]
- **Database Admin**: [Contact Info]
- **Infrastructure Team**: [Contact Info]
- **Security Team**: [Contact Info]

## Sign-Off

- [ ] DevOps Lead: _________________ Date: _______
- [ ] Security Lead: ________________ Date: _______
- [ ] Product Manager: ______________ Date: _______
- [ ] Engineering Lead: _____________ Date: _______

