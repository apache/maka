---
name: troubleshooting-s3-files
description: >
  Diagnoses and resolves Amazon S3 Files issues including mount failures,
  permission errors, synchronization problems, and performance issues. Use when
  the user has an S3 file system that is not mounting, returning access denied,
  not syncing changes to S3, showing files in lost+found, or performing slower
  than expected.
version: 1
---

# Troubleshooting S3 Files

## Overview

Diagnoses and resolves Amazon S3 Files issues: mount failures, IAM
permissions, synchronization, conflict resolution, and performance.

For authoritative guidance, see [S3 Files Troubleshooting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-troubleshooting.html).

## Common Tasks

### 0. Verify Dependencies

- You MUST verify `aws` CLI is available with `s3files` subcommand support
- You MUST confirm valid AWS credentials
- You MUST ONLY check for tool existence and version — MUST NOT execute destructive or mutating commands during verification
- You MUST inform the user if any required tools are missing
- You MUST respect the user's decision to abort if tools are unavailable
- You SHOULD explain steps before executing and wait for user confirmation on write commands

### 1. Classify the Issue

| Symptom                                | Category                  |
| -------------------------------------- | ------------------------- |
| mount.s3files: command not found       | A: Client Installation    |
| Connection timed out during mount      | B: Network/Security Group |
| Mount hangs indefinitely (no timeout)  | B: Network/Security Group |
| Access denied during mount             | C: IAM Permissions        |
| File system stuck in "creating"        | C: IAM Permissions        |
| Permission denied on file operations   | C: IAM Permissions        |
| Files not appearing in S3 after write  | D: Synchronization        |
| Files in .s3files-lost+found directory | E: Conflict Resolution    |
| Slow reads or high latency             | F: Performance            |
| NFS server error                       | G: Encryption/KMS         |
| DNS name resolution fails              | H: VPC DNS                |

### 2. Category A — Client Installation

`mount.s3files: command not found` means `amazon-efs-utils` is missing or < v3.0.0.

```bash
sudo yum -y install amazon-efs-utils  # Amazon Linux
```

### 3. Category B — Network/Security Group

Connection timeout is the #1 mount failure — almost always security groups.

Verify mount target exists in the instance's AZ:

```bash
aws s3files list-mount-targets --file-system-id fs-ID --region REGION
```

Cross-AZ mounting works but adds latency.

Verify security groups — most common fix:

- Mount target SG MUST have inbound TCP 2049 from compute SG
- Compute SG MUST have outbound TCP 2049 to mount target SG
- Fix: `aws ec2 authorize-security-group-ingress --group-id sg-MT --protocol tcp --port 2049 --source-group sg-COMPUTE`

Test connectivity:

```bash
nc -zv az-ID.fs-ID.s3files.REGION.on.aws 2049
```

> **Note:** These SG troubleshooting steps also apply to EFS — use `aws efs describe-mount-targets` instead.

**Mount hangs in isolated VPC**: If the VPC has no internet access, S3 Files requires a CloudWatch Logs VPC endpoint (`com.amazonaws.REGION.logs`) for mount to complete.

### 4. Category C — IAM Permissions

**File system stuck in "creating" status:**
S3 Files does NOT validate IAM role permissions at creation time. Wrong trust policy or missing permissions → stuck in `creating` with access denied in `statusMessage`.

Check status:

```bash
aws s3files get-file-system --file-system-id fs-ID --region REGION
```

Check `statusMessage`. If access denied, fix the IAM role and delete/recreate.

**Mount access denied:** Compute role needs `s3files:ClientMount`. For dev/test only, `AmazonS3FilesClientFullAccess` is acceptable — avoid in production.

**Write permission denied:** Compute role needs `s3files:ClientWrite`

**Root access denied:** Compute role needs `s3files:ClientRootAccess`. ⚠️ Bypasses POSIX permissions — prefer access points with scoped POSIX users.

**Check file system policy:**

```bash
aws s3files get-file-system-policy --file-system-id fs-ID --region REGION
```

### 5. Category D — Synchronization

**Files not appearing in S3:** Writes sync within ~60 seconds. Check status:

```bash
getfattr -n "user.s3files.status;$(date -u +%s)" filename --only-values
```

Common ExportError values:

| Error                     | Fix                                             |
| ------------------------- | ----------------------------------------------- |
| S3AccessDenied            | File system IAM role lacks S3 write permissions |
| S3BucketNotFound          | Bucket deleted or renamed                       |
| RoleAssumptionFailed      | Trust policy misconfigured                      |
| EncryptionKeyInaccessible | KMS key disabled or permissions revoked         |
| PathTooLong               | File path exceeds 1,024 byte S3 key limit       |

Monitor: `PendingExports` CloudWatch metric. Growing = exceeds 800 files/sec rate.

### 6. Category E — Conflict Resolution

Files in `.s3files-lost+found-{fs-id}` = sync conflict (modified via FS and S3 simultaneously). S3 wins; FS version moved to lost+found.

### 7. Category F — Performance

**First access latency:** Normal — first directory access imports metadata.

**Intelligent read routing not working:** Compute role needs `s3:GetObject` on the bucket.

**Slow writes:** If `PendingExports` growing, distribute across multiple file systems.

### 8. Category G — Encryption/KMS

NFS server error with encrypted FS = KMS issue. Verify key is enabled and role has KMS permissions.

### 9. Category H — VPC DNS

DNS resolution failure = VPC DNS settings disabled.

```bash
aws ec2 describe-vpc-attribute --vpc-id vpc-ID --attribute enableDnsHostnames
aws ec2 describe-vpc-attribute --vpc-id vpc-ID --attribute enableDnsSupport
```

Both MUST be `true`. If not:

```bash
aws ec2 modify-vpc-attribute --vpc-id vpc-ID --enable-dns-hostnames Value=true
aws ec2 modify-vpc-attribute --vpc-id vpc-ID --enable-dns-support Value=true
```

## Troubleshooting

### AWS CLI endpoint URL cannot be resolved

CLI is too old for S3 Files. Run `aws --version` — if v1.x, upgrade to AWS CLI v2: [Installing the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).

### ECS task fails with DNS resolution error

Used `efsVolumeConfiguration` instead of `s3filesVolumeConfiguration`. Fix: use `fileSystemArn` in S3 Files-specific volume config.

### S3 Files vs other products confusion

S3 Files is NOT Mountpoint for S3, S3 File Gateway, or File Cache. Uses `aws s3files` CLI, `s3files:` IAM actions, `mount -t s3files`.

### Enable Debug Logs

Set `logging_level = DEBUG` in `/etc/amazon/efs/s3files-utils.conf`. Logs at `/var/log/amazon/efs/mount.log`.

### Collect Logs for AWS Support

```bash
sudo tar -czf /tmp/s3files-logs.tar.gz /var/log/amazon/efs/ /etc/amazon/efs/s3files-utils.conf
```

## Security Considerations

- When diagnosing IAM issues, verify least-privilege — avoid FullAccess as a shortcut
- Without a file system policy, any VPC client can mount
- Restrict `/var/log/amazon/efs/` access — logs contain S3 key names

## Additional Resources

- [S3 Files Troubleshooting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-troubleshooting.html)
- [S3 Files Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-best-practices.html)
- [S3 Files Quotas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-quotas.html)
