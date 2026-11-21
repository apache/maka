---
name: creating-amazon-aurora-db-cluster-with-instances
description: Creates a complete Amazon Aurora database cluster with instances, handling cluster creation, instance provisioning, and Secrets Manager password management in the proper sequence. Use when setting up new Aurora MySQL or PostgreSQL clusters with production-ready configuration.
version: 1
---

# Creating Amazon Aurora DB Cluster with Instances

## Overview

Domain expertise for creating complete Amazon Aurora database setups including
cluster creation, instance provisioning, and managed password configuration via
AWS Secrets Manager. Supports both Aurora MySQL and Aurora PostgreSQL engines.

## Create an Aurora cluster with instances

To create a fully configured Aurora database cluster with attached instances,
follow the procedure exactly.
See [Aurora cluster creation procedure](references/create-amazon-aurora-db-cluster-with-instances.md).

The procedure creates an empty Aurora cluster first, then adds a database instance
to make it queryable. It uses AWS Secrets Manager for password management and
includes proper status monitoring with retry logic.

## Troubleshooting

### Cluster creation fails

Verify the engine version is supported in your region and that you have sufficient
permissions for RDS and Secrets Manager operations.

### Instance creation fails

Check that the instance class is compatible with the Aurora engine and available
in your region's availability zones.

### Long creation times

Aurora cluster and instance creation can take 10-20 minutes. Extended wait times
are normal for Aurora resources.
