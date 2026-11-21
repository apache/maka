---
name: troubleshooting-efs
description: >
  Diagnoses and resolves Amazon EFS issues including mount failures, NFS timeouts,
  permission errors, throughput problems, and burst credit exhaustion. Use when
  the user has an EFS file system that is not mounting, returning errors, performing
  slowly, or showing access denied.
version: 1
---

# Troubleshooting EFS

## Overview

Domain expertise for diagnosing and resolving Amazon EFS issues. Covers mount
failures, NFS connectivity, IAM and POSIX permissions, throughput and performance,
and encryption problems.

For authoritative guidance, see [EFS Troubleshooting](https://docs.aws.amazon.com/efs/latest/ug/troubleshooting.html).

## Common Tasks

### 0. Verify Dependencies

- You MUST verify `aws` CLI is available
- You MUST check if `amazon-efs-utils` or `nfs-utils` is installed on the instance
- You MUST ONLY check for tool existence and version — MUST NOT execute destructive or mutating commands during verification
- You MUST inform the user if any required tools are missing
- You MUST respect the user's decision to abort if tools are unavailable
- You SHOULD explain what each step does and why before executing it
- You SHOULD display write commands and wait for user confirmation before executing

### 1. Classify the Issue

| Symptom                                | Category                  |
| -------------------------------------- | ------------------------- |
| "wrong fs type" or mount command fails | A: Missing NFS Client     |
| Connection timed out (hangs 2+ min)    | B: Network/Security Group |
| "access denied by server"              | C: IAM/Permissions        |
| Slow throughput or high latency        | D: Performance            |
| NFS server error on encrypted FS       | E: Encryption/KMS         |
| DNS name resolution fails              | F: VPC DNS                |

### 2. Category A — Missing NFS Client

```bash
# Amazon Linux / RHEL / CentOS
sudo yum -y install amazon-efs-utils  # preferred (includes mount helper + TLS)
# OR
sudo yum -y install nfs-utils

# Ubuntu / Debian
sudo apt-get install nfs-common
```

### 3. Category B — Network/Security Group

Connection timeout is the #1 EFS mount failure — almost always security groups.

1. Verify mount target exists in the instance's AZ:

```bash
aws efs describe-mount-targets --file-system-id fs-ID --region REGION
```

1. Verify security groups — check BOTH directions:
   - Mount target SG: `aws ec2 describe-security-groups --group-ids sg-MT` — MUST have inbound TCP 2049 from compute SG
   - Compute SG: MUST have outbound TCP 2049 to mount target SG
   - Quick fix: `aws ec2 authorize-security-group-ingress --group-id sg-MT --protocol tcp --port 2049 --source-group sg-COMPUTE`

2. Test connectivity:

```bash
nc -zv fs-ID.efs.REGION.amazonaws.com 2049
```

> **Note:** These security group troubleshooting steps also apply to S3 Files. The only difference is S3 Files uses `aws s3files list-mount-targets` instead of `aws efs describe-mount-targets`.

### 4. Category C — IAM/Permissions

**"access denied by server" with `-o iam`:**

- Check identity-based IAM policy has `elasticfilesystem:ClientMount`
- Check file system resource policy:

```bash
aws efs describe-file-system-policy --file-system-id fs-ID --region REGION
```

**Note:** IAM authorization is only enforced when a file system policy exists that requires it. Without a file system policy, any client in the VPC with port 2049 access can mount — even with `-o iam`. To enforce IAM, you MUST create a file system policy that denies anonymous access.

**POSIX permission denied (not IAM):**

- Check file/directory ownership: `ls -la /mnt/efs/`
- Use access points to enforce UID/GID for consistent permissions

### 5. Category D — Performance

**Check throughput mode:**

```bash
aws efs describe-file-systems --file-system-id fs-ID --region REGION --query 'FileSystems[0].ThroughputMode'
```

**Burst credit exhaustion (Bursting mode only):**

```bash
aws cloudwatch get-metric-statistics --namespace AWS/EFS --metric-name BurstCreditBalance --dimensions Name=FileSystemId,Value=fs-ID --period 3600 --statistics Average --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S)
```

If credits near zero, switch to Elastic throughput:

```bash
aws efs update-file-system --file-system-id fs-ID --throughput-mode elastic --region REGION
```

**General Purpose vs Max I/O:**

- Check `PercentIOLimit` metric — if consistently >80%, consider Max I/O
- Note: performance mode is IMMUTABLE — must create new FS and migrate

### 6. Category E — Encryption/KMS

NFS server error on encrypted FS = KMS key issue.

- Verify key is enabled in KMS console
- Verify EFS service-linked role has KMS permissions
- If key deleted: cancel deletion if within grace period

### 7. Category F — VPC DNS

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

### Mount hangs then times out

Most common cause: security group. Verify TCP 2049 is open between compute and mount target.

### Auto-mount fails on reboot

`/etc/fstab` entry MUST include `_netdev` option to wait for network before mounting.

### "nfs not responding" after reconnect

Old kernel bug with TCP port reuse. Update kernel or add `noresvport` mount option.

### Enable Debug Logs

Set `logging_level = DEBUG` in `/etc/amazon/efs/efs-utils.conf`. Logs at `/var/log/amazon/efs/mount.log`.

### Collect Logs for AWS Support

```bash
sudo tar -czf /tmp/efs-logs.tar.gz /var/log/amazon/efs/ /etc/amazon/efs/efs-utils.conf
```

## Security Considerations

- IAM authorization is only enforced when a file system policy exists — without one, any VPC client with port 2049 access can mount
- When troubleshooting access denied, verify both identity-based and resource-based policies
- Use `-o tls` for encryption in transit — unencrypted NFS traffic is visible on the network
- Restrict `/var/log/amazon/efs/` access — logs may contain file system IDs and mount target IPs

## Additional Resources

- [EFS Troubleshooting](https://docs.aws.amazon.com/efs/latest/ug/troubleshooting.html)
- [EFS Performance](https://docs.aws.amazon.com/efs/latest/ug/performance.html)
- [EFS Mount Helper](https://docs.aws.amazon.com/efs/latest/ug/using-amazon-efs-utils.html)
