---
name: aws-sdk-python-usage
description: |
  AWS SDK for Python (boto3/botocore) development patterns. You MUST use this skill when writing Python code that uses AWS services via boto3 or botocore. This includes creating service clients or resources, configuring sessions and credentials, handling errors with ClientError, using paginators and waiters, S3 file transfers and presigned URLs, DynamoDB table operations, and any boto3/botocore client configuration. Use this skill whenever Python code imports boto3 or botocore, or when the user asks about AWS operations in Python.
---

> Do not use emojis in any code, comments, or output when this skill is active.

# AWS SDK for Python (boto3)

boto3 is the high-level Python SDK for AWS. It wraps botocore (the low-level
SDK) and provides two distinct interfaces: **clients** (low-level, 1:1 API
mapping) and **resources** (high-level, object-oriented). Understanding which to
use and when is essential.

## Client vs Resource

**Clients** map directly to AWS service APIs. Every service has a client.
Responses are plain dicts.

**Resources** provide an object-oriented interface with attributes and actions.
Only some services have resources (S3, DynamoDB, EC2, IAM, SQS, SNS,
CloudFormation, CloudWatch, Glacier). Resources auto-marshal types (especially
useful for DynamoDB).

```python
import boto3

# Client - low-level, all services
s3_client = boto3.client("s3")
response = s3_client.list_buckets()
buckets = response["Buckets"]  # plain dicts

# Resource - high-level, select services
s3_resource = boto3.resource("s3")
for bucket in s3_resource.buckets.all():
    print(bucket.name)  # attribute access, not dict keys
```

Use clients when you need full API coverage or the service has no resource
interface. Use resources when they exist and simplify your code (especially
DynamoDB and S3).

## Session and Client Creation

```python
import boto3

# Default session implicitly created
client = boto3.client("s3")
resource = boto3.resource("dynamodb")

# Explicit session use when you need to customize how
# clients are created, use an explicit profile, etc.
session = boto3.Session(
    profile_name="my-profile",
    region_name="us-west-2",
)
client = session.client("s3")
```

Do not create clients inside loops - reuse a single client instance. Clients
are thread safe and can be shared across threads once they're instantiated.

## Making API Calls

```python
# Client - pass parameters as keyword arguments, get dicts back
response = client.get_object(Bucket="my-bucket", Key="my-key")
data = response["Body"].read()

# Resource - use object methods and attributes
obj = s3_resource.Object("my-bucket", "my-key")
response = obj.get()
data = response["Body"].read()
```

Parameter names match the exact casing of the AWS API,
which is typically PascalCase, not snake\_case.

## Error Handling

Only catch exceptions when you have something actionable to do - return a
fallback value, retry, take a different code path. Catching an exception just to
print it and swallow it is wrong: it hides the real error and prevents callers
from reacting. Let exceptions propagate by default.

When you do catch, prefer typed exceptions on the client over generic
`ClientError` with string code matching through the `client.exceptions`
attribute:

```python
lambda_client = boto3.client("lambda")

def get_function_config(name: str) -> dict | None:
    """Return function configuration, or None if it doesn't exist."""
    try:
        return lambda_client.get_function_configuration(FunctionName=name)
    except lambda_client.exceptions.ResourceNotFoundException:
        return None  # actionable: convert missing function to None
    # Everything else propagates - caller or main() handles it
```

Use generic `ClientError` only as a catch-all in a top-level error handler, not
in business logic functions. It lives in botocore, not boto3:

```python
from botocore.exceptions import ClientError

def main() -> int:
    try:
        result = do_the_work()
        print(result)
        return 0
    except ClientError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
```

For the full error hierarchy and botocore exceptions, see `references/error-handling.md`.

## Script Structure

When asked to write a script that uses `boto3` or `botocore`, keep `if __name__
== "__main__"` to a single function call. Argument parsing, error presentation,
and exit codes belong in `main()`, not scattered across business logic
functions:

```python
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bucket")
    args = parser.parse_args()

    try:
        do_the_work(args.bucket)
        return 0
    except ClientError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
```

Never call `sys.exit()` from a business logic function -- it makes the function
untestable and unusable as a library. Raise an exception or return an error
value instead, and let `main()` decide how to present it.

## Pagination

Never manually loop with `NextToken` -- use paginators. When you only need
specific fields, use `.search()` with a JMESPath expression to extract and
flatten across pages:

```python
paginator = iam.get_paginator("list_users")
for name in paginator.paginate().search("Users[].UserName"):
    print(name)

# Filter and project
for arn in paginator.paginate().search("Users[?Path == '/admin/'][].Arn"):
    print(arn)
```

When you need the full response object per item, or need per-page control (e.g.
counting pages, batching by page), iterate pages directly:

```python
for page in paginator.paginate():
    for user in page.get("Users", []):
        process(user)
```

For more details on pagination, see: `references/pagination.md`.

## Waiters

Wait for a resource to reach a desired state:

```python
waiter = client.get_waiter("bucket_exists")
waiter.wait(
    Bucket="my-bucket",
    WaiterConfig={"Delay": 5, "MaxAttempts": 20},
)
```

For more details on waiters, see `references/waiters.md`.

## Client Configuration

Use `botocore.config.Config` for retries, timeouts, and connection pool
settings, etc.:

```python
from botocore.config import Config

config = Config(
    retries={"total_max_attempts": 2, "mode": "adaptive"},
    connect_timeout=5,
    read_timeout=10,
    max_pool_connections=50,
)
client = boto3.client("s3", config=config)
```

When creating custom configuration for a client, see `references/configuration.md`.

## Logging

Both boto3 and botocore use the standard library `logging` module. You can
configure logging through the standard `logging` APIs, or you can use
helpers provided by boto3 and botocore for convenience:

```python
# Quick: log all botocore wire-level details to stderr
boto3.set_stream_logger("")  # root logger -- everything
boto3.set_stream_logger("botocore")  # just botocore

# Botocore, log all botocore details
import logging

from botocore.session import Session

session = Session()

session.set_stream_logger('botocore', logging.DEBUG)
# OR: Configure logging to a file.
session.set_file_logger(logging.DEBUG, '/tmp/botocore.log')
```

`set_stream_logger(name, level=logging.DEBUG)` adds a
`StreamHandler` to the named logger. This is the idiomatic way to get
request/response debug output from the SDK.

## Common Issues

### Issue: ClientError import location

**Wrong:** `from boto3.exceptions import ClientError`
**Right:** `from botocore.exceptions import ClientError`

## Service specific customizations

When writing any Python code that uses the following services, you MUST load
these additional reference files for best practices and custom high level APIs:

- S3 - you MUST load `references/s3.md`.
- Dynamodb - you MUST load `references/dynamodb.md`.

## References

- Client configuration (retries, timeouts, endpoints): `references/configuration.md`
- Credentials and sessions: `references/credentials.md`
- Error handling patterns: `references/error-handling.md`
- Pagination: `references/pagination.md`
- Waiters: `references/waiters.md`
- S3 transfers and presigned URLs: `references/s3.md`
- DynamoDB operations: `references/dynamodb.md`
