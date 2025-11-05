# Hexmon Signage - Deployment Guide

## Prerequisites

- Ubuntu 20.04 LTS or later
- Docker & Docker Compose
- PostgreSQL 14+ (or use Docker)
- MinIO (or use Docker)
- Node.js 18+ (for building)
- FFmpeg (for media processing)

## Production Deployment

### 1. System Setup

```bash
# Create application user
sudo useradd -m -s /bin/bash signhex

# Create application directory
sudo mkdir -p /opt/hexmon-api
sudo chown signhex:signhex /opt/hexmon-api

# Create configuration directory
sudo mkdir -p /etc/hexmon
sudo chown signhex:signhex /etc/hexmon

# Create backup directory
sudo mkdir -p /var/backups/hexmon
sudo chown signhex:signhex /var/backups/hexmon
```

### 2. Database Setup

```bash
# Create PostgreSQL database
sudo -u postgres createdb hexmon
sudo -u postgres createuser hexmon_user
sudo -u postgres psql -c "ALTER USER hexmon_user WITH PASSWORD 'secure_password';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE hexmon TO hexmon_user;"
```

### 3. MinIO Setup

```bash
# Create MinIO data directory
sudo mkdir -p /var/lib/minio
sudo chown signhex:signhex /var/lib/minio

# Create MinIO configuration
sudo mkdir -p /etc/minio
sudo chown signhex:signhex /etc/minio
```

### 4. Application Deployment

```bash
# Clone repository
cd /opt/hexmon-api
git clone <repository> .

# Install dependencies
npm ci --production

# Build application
npm run build

# Set permissions
sudo chown -R signhex:signhex /opt/hexmon-api
```

### 5. Environment Configuration

Create `/etc/hexmon/api.env`:

```bash
NODE_ENV=production
PORT=3000
DEVICE_PORT=8443

DATABASE_URL=postgresql://hexmon_user:secure_password@localhost:5432/hexmon

JWT_SECRET=your-very-secure-secret-key-min-32-chars
JWT_EXPIRY=900

MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_USE_SSL=false
MINIO_FORCE_PATH_STYLE=true

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=secure_admin_password

LOG_LEVEL=info
```

### 6. systemd Service Setup

```bash
# Copy service file
sudo cp signhex-api.service /etc/systemd/system/

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable signhex-api
sudo systemctl start signhex-api

# Check status
sudo systemctl status signhex-api
```

### 7. Nginx Reverse Proxy

Create `/etc/nginx/sites-available/hexmon`:

```nginx
upstream hexmon_api {
    server localhost:3000;
}

server {
    listen 80;
    server_name api.hexmon.local;

    location / {
        proxy_pass http://hexmon_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/hexmon /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 8. SSL/TLS Setup (Let's Encrypt)

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d api.hexmon.local
```

### 9. Backup Configuration

Create a cron job for automated backups:

```bash
# Edit crontab
sudo crontab -e

# Add backup jobs
0 2 * * * /opt/hexmon-api/scripts/backup_postgres.sh /var/backups/hexmon
0 3 * * * /opt/hexmon-api/scripts/backup_minio.sh /var/backups/hexmon
```

### 10. Monitoring

Install monitoring tools:

```bash
# Prometheus
sudo apt-get install prometheus

# Grafana
sudo apt-get install grafana-server
```

Configure Prometheus to scrape `/metrics` endpoint.

## Docker Compose Deployment

For containerized deployment:

```bash
docker-compose -f docker-compose.yml up -d
```

## Troubleshooting

### Check logs

```bash
sudo journalctl -u signhex-api -f
```

### Database connection issues

```bash
psql postgresql://hexmon_user:password@localhost:5432/hexmon
```

### MinIO connectivity

```bash
mc alias set hexmon http://localhost:9000 minioadmin minioadmin
mc ls hexmon
```

## Scaling

For high-availability deployments:

1. **Load Balancing**: Use HAProxy or Nginx
2. **Database Replication**: PostgreSQL streaming replication
3. **MinIO Clustering**: MinIO distributed mode
4. **API Instances**: Run multiple API instances behind load balancer

## Security Hardening

1. **Firewall**: Restrict access to ports 3000, 8443, 5432, 9000
2. **TLS**: Enable TLS for all connections
3. **Secrets**: Use environment variables or secrets management
4. **Backups**: Encrypt backups at rest
5. **Audit Logs**: Monitor and archive audit logs

## Maintenance

### Database Maintenance

```bash
# Vacuum and analyze
sudo -u postgres vacuumdb hexmon
sudo -u postgres analyzedb hexmon
```

### Log Rotation

Configure logrotate for application logs:

```bash
/var/log/hexmon/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 signhex signhex
    sharedscripts
}
```

## Rollback Procedure

```bash
# Stop service
sudo systemctl stop signhex-api

# Restore from backup
git checkout <previous-version>
npm ci --production
npm run build

# Restore database
psql hexmon < /var/backups/hexmon/hexmon_postgres_*.sql

# Start service
sudo systemctl start signhex-api
```

