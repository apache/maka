---
name: backup-restore-runbook-generator
description: Creates comprehensive disaster recovery procedures with automated backup scripts, restore procedures, validation checks, and role assignments. Use for "database backup", "disaster recovery", "data restore", or "DR planning".
---

# Backup/Restore Runbook Generator

Create reliable disaster recovery procedures for your databases.

## Backup Strategy

````markdown
# Database Backup Strategy

## Backup Types

### 1. Full Backup (Daily)

- **When**: 2:00 AM UTC
- **Retention**: 30 days
- **Storage**: S3 `s3://backups/full/`
- **Size**: ~50 GB
- **Duration**: ~45 minutes

### 2. Incremental Backup (Hourly)

- **When**: Every hour
- **Retention**: 7 days
- **Storage**: S3 `s3://backups/incremental/`
- **Size**: ~500 MB
- **Duration**: ~5 minutes

### 3. Transaction Log Backup (Every 15 min)

- **When**: Every 15 minutes
- **Retention**: 3 days
- **Storage**: S3 `s3://backups/wal/`
- **Point-in-time recovery capability**

## Backup Automation

### PostgreSQL

```bash
#!/bin/bash
# scripts/backup-postgres.sh

set -e

# Configuration
DB_NAME="production"
DB_USER="postgres"
DB_HOST="postgres.example.com"
BACKUP_DIR="/var/backups/postgres"
S3_BUCKET="s3://my-backups/postgres"
DATE=$(date +%Y%m%d_%H%M%S)
FILENAME="${DB_NAME}_${DATE}.sql.gz"

# Create backup directory
mkdir -p $BACKUP_DIR

echo "🔄 Starting backup: $FILENAME"

# Full backup with pg_dump
pg_dump \
  --host=$DB_HOST \
  --username=$DB_USER \
  --dbname=$DB_NAME \
  --format=custom \
  --compress=9 \
  --file=$BACKUP_DIR/$FILENAME \
  --verbose

# Verify backup
if [ -f "$BACKUP_DIR/$FILENAME" ]; then
  SIZE=$(du -h "$BACKUP_DIR/$FILENAME" | cut -f1)
  echo "✅ Backup created: $SIZE"
else
  echo "❌ Backup failed"
  exit 1
fi

# Upload to S3
echo "📤 Uploading to S3..."
aws s3 cp $BACKUP_DIR/$FILENAME $S3_BUCKET/ \
  --storage-class STANDARD_IA

# Verify upload
if aws s3 ls $S3_BUCKET/$FILENAME; then
  echo "✅ Uploaded to S3"
else
  echo "❌ S3 upload failed"
  exit 1
fi

# Cleanup old local backups (keep last 7 days)
find $BACKUP_DIR -type f -name "*.sql.gz" -mtime +7 -delete
echo "🗑️  Cleaned up old local backups"

# Send notification
curl -X POST $SLACK_WEBHOOK \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"✅ Database backup complete: $FILENAME ($SIZE)\"}"

echo "✅ Backup complete!"
```
````

### MySQL

```bash
#!/bin/bash
# scripts/backup-mysql.sh

set -e

DB_NAME="production"
DB_USER="root"
DB_PASSWORD=$MYSQL_PASSWORD
DATE=$(date +%Y%m%d_%H%M%S)
FILENAME="${DB_NAME}_${DATE}.sql.gz"

echo "🔄 Starting MySQL backup..."

# Backup with mysqldump
mysqldump \
  --user=$DB_USER \
  --password=$DB_PASSWORD \
  --single-transaction \
  --quick \
  --lock-tables=false \
  --databases $DB_NAME \
  | gzip > /var/backups/mysql/$FILENAME

# Upload to S3
aws s3 cp /var/backups/mysql/$FILENAME s3://my-backups/mysql/

echo "✅ Backup complete!"
```

## Restore Procedures

### Full Restore

```bash
#!/bin/bash
# scripts/restore-postgres.sh

set -e

BACKUP_FILE=$1
RESTORE_DB="production_restored"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore-postgres.sh <backup-file>"
  exit 1
fi

echo "🔄 Starting restore from: $BACKUP_FILE"

# 1. Download from S3
echo "📥 Downloading backup..."
aws s3 cp s3://my-backups/postgres/$BACKUP_FILE /tmp/

# 2. Create new database
echo "🗄️  Creating database..."
psql -h $DB_HOST -U postgres -c "CREATE DATABASE $RESTORE_DB;"

# 3. Restore backup
echo "🔄 Restoring data..."
pg_restore \
  --host=$DB_HOST \
  --username=postgres \
  --dbname=$RESTORE_DB \
  --verbose \
  /tmp/$BACKUP_FILE

# 4. Verify restore
echo "✅ Verifying restore..."
TABLE_COUNT=$(psql -h $DB_HOST -U postgres -d $RESTORE_DB -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")
echo "  Tables restored: $TABLE_COUNT"

ROW_COUNT=$(psql -h $DB_HOST -U postgres -d $RESTORE_DB -t -c "SELECT COUNT(*) FROM users;")
echo "  User rows: $ROW_COUNT"

echo "✅ Restore complete!"
echo "  Database: $RESTORE_DB"
echo "  To use: UPDATE application config to point to $RESTORE_DB"
```

### Point-in-Time Recovery (PITR)

```bash
#!/bin/bash
# scripts/pitr-restore.sh

TARGET_TIME=$1  # Format: 2024-01-15 14:30:00

echo "🔄 Point-in-Time Restore to: $TARGET_TIME"

# 1. Restore base backup
echo "📦 Restoring base backup..."
pg_basebackup -D /var/lib/postgresql/data -X stream

# 2. Configure recovery
cat > /var/lib/postgresql/data/recovery.conf << EOF
restore_command = 'aws s3 cp s3://my-backups/wal/%f %p'
recovery_target_time = '$TARGET_TIME'
recovery_target_action = 'promote'
EOF

# 3. Start PostgreSQL
echo "🚀 Starting PostgreSQL in recovery mode..."
systemctl start postgresql

# 4. Wait for recovery
while ! pg_isready; do
  echo "  Waiting for recovery..."
  sleep 5
done

echo "✅ PITR complete!"
```

## Validation Checks

```bash
#!/bin/bash
# scripts/validate-restore.sh

DB=$1

echo "🔍 Validating restore..."

# 1. Check table count
TABLES=$(psql -d $DB -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")
echo "Tables: $TABLES"

if [ "$TABLES" -lt 10 ]; then
  echo "❌ Too few tables restored"
  exit 1
fi

# 2. Check row counts
for table in users products orders; do
  ROWS=$(psql -d $DB -t -c "SELECT COUNT(*) FROM $table;")
  echo "  $table: $ROWS rows"

  if [ "$ROWS" -lt 1 ]; then
    echo "❌ Table $table is empty"
    exit 1
  fi
done

# 3. Check constraints
CONSTRAINTS=$(psql -d $DB -t -c "SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY';")
echo "Foreign keys: $CONSTRAINTS"

# 4. Check indexes
INDEXES=$(psql -d $DB -t -c "SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public';")
echo "Indexes: $INDEXES"

# 5. Test query performance
START=$(date +%s%N)
psql -d $DB -c "SELECT COUNT(*) FROM users WHERE email LIKE '%@example.com%';" > /dev/null
END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))
echo "Query performance: ${DURATION}ms"

if [ "$DURATION" -gt 1000 ]; then
  echo "⚠️  Slow query - missing indexes?"
fi

echo "✅ Validation complete!"
```

## Disaster Recovery Runbook

````markdown
# Disaster Recovery Runbook

## Incident Response

### 1. Assess Situation (5 minutes)

- [ ] Identify incident severity (P0/P1/P2)
- [ ] Determine data loss window
- [ ] Notify stakeholders

**Contacts:**

- DBA On-Call: [phone]
- Engineering Lead: [phone]
- CTO: [phone]

### 2. Stop the Bleeding (10 minutes)

- [ ] Enable maintenance mode
- [ ] Stop writes to corrupted database
- [ ] Preserve evidence (logs, backups)

```bash
# Enable maintenance mode
kubectl scale deployment/api --replicas=0
```
````

### 3. Identify Recovery Point (15 minutes)

- [ ] Determine last good backup
- [ ] Check backup integrity
- [ ] Calculate data loss

```bash
# List available backups
aws s3 ls s3://my-backups/postgres/ | tail -20

# Check backup size
aws s3 ls s3://my-backups/postgres/production_20240115_020000.sql.gz --human-readable
```

### 4. Prepare Recovery Environment (30 minutes)

- [ ] Spin up new database instance
- [ ] Configure networking
- [ ] Test connectivity

```bash
# Create RDS instance
aws rds create-db-instance \
  --db-instance-identifier production-recovery \
  --db-instance-class db.r6g.xlarge \
  --engine postgres \
  --master-username postgres \
  --master-user-password [secure-password]
```

### 5. Execute Restore (1-2 hours)

- [ ] Download backup from S3
- [ ] Run restore script
- [ ] Apply transaction logs (if PITR)
- [ ] Verify data integrity

```bash
# Run restore
./scripts/restore-postgres.sh production_20240115_020000.sql.gz

# Validate
./scripts/validate-restore.sh production_restored
```

### 6. Validate and Test (30 minutes)

- [ ] Run validation scripts
- [ ] Test critical queries
- [ ] Verify row counts
- [ ] Check data consistency

### 7. Cutover (15 minutes)

- [ ] Update application config
- [ ] Point DNS to new database
- [ ] Disable maintenance mode
- [ ] Monitor for errors

```bash
# Update connection string
kubectl set env deployment/api DATABASE_URL=postgresql://...

# Scale up
kubectl scale deployment/api --replicas=3
```

### 8. Post-Recovery (1 hour)

- [ ] Monitor system health
- [ ] Verify user reports
- [ ] Document incident
- [ ] Schedule postmortem

## Recovery Time Objective (RTO)

| Scenario        | Target     | Actual     |
| --------------- | ---------- | ---------- |
| Full restore    | 2 hours    | [measured] |
| PITR restore    | 3 hours    | [measured] |
| Region failover | 15 minutes | [measured] |

## Recovery Point Objective (RPO)

| Backup Type      | Data Loss Window |
| ---------------- | ---------------- |
| Full backup      | 24 hours         |
| Incremental      | 1 hour           |
| Transaction logs | 15 minutes       |

````

## Automated Backup Monitoring

```typescript
// scripts/monitor-backups.ts
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'us-east-1' });

async function checkBackupHealth() {
  const bucket = 'my-backups';
  const prefix = 'postgres/';

  // List recent backups
  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 10,
  });

  const response = await s3.send(command);
  const backups = response.Contents || [];

  // Check last backup age
  const latestBackup = backups[0];
  const age = Date.now() - new Date(latestBackup.LastModified!).getTime();
  const ageHours = age / (1000 * 60 * 60);

  if (ageHours > 25) {
    console.error('❌ No backup in last 24 hours!');
    // Send alert
    await sendSlackAlert('No recent database backup!');
    process.exit(1);
  }

  // Check backup size
  const size = latestBackup.Size! / (1024 * 1024 * 1024); // GB
  if (size < 10) {
    console.error('⚠️  Backup size suspiciously small');
  }

  console.log('✅ Backup health check passed');
  console.log(`  Latest: ${latestBackup.Key}`);
  console.log(`  Age: ${ageHours.toFixed(1)} hours`);
  console.log(`  Size: ${size.toFixed(2)} GB`);
}

checkBackupHealth();
````

## Role Assignments

```markdown
## DR Team Roles

### Database Administrator (Primary)

- Execute restore procedures
- Verify data integrity
- Monitor recovery progress

### Engineering Lead

- Coordinate response
- Communicate with stakeholders
- Make cutover decisions

### DevOps Engineer

- Provision infrastructure
- Update application configs
- Monitor system health

### Product Manager

- Assess business impact
- Prioritize recovery
- Customer communication

## Escalation Path

1. DBA on-call →
2. Engineering Lead →
3. CTO →
4. CEO (P0 incidents only)
```

## Best Practices

1. **Test restores regularly**: Quarterly DR drills
2. **Automate backups**: Never rely on manual processes
3. **Multiple locations**: Cross-region backup storage
4. **Monitor backup health**: Alert on failures
5. **Document procedures**: Keep runbook updated
6. **Encrypt backups**: Protect sensitive data
7. **Version control**: Track backup script changes

## Output Checklist

- [ ] Backup automation scripts
- [ ] Restore procedures documented
- [ ] Validation checks defined
- [ ] PITR procedure (if applicable)
- [ ] DR runbook created
- [ ] Role assignments documented
- [ ] RTO/RPO defined
- [ ] Backup monitoring configured
