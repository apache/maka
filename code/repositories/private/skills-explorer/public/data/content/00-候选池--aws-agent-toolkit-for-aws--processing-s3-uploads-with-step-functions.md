---
name: processing-s3-uploads-with-step-functions
description: >
  Deploy an event-driven workflow that routes S3 uploads to either Lambda or Fargate
  via Step Functions based on file size. Uses EventBridge to trigger a Step Functions
  state machine when objects are uploaded to S3. Small files are processed by Lambda,
  large files by a Fargate task. Includes VPC, ECR repository, ECS cluster, and scoped
  IAM roles. Trigger keywords: Step Functions, Fargate, Lambda, S3 event, EventBridge,
  ECS, ECR, file processing, workflow orchestration, serverless.
version: 1
---

# Step Functions Workflow: Route S3 Uploads to Lambda or Fargate

## Overview

This skill deploys an event-driven workflow using AWS CLI. When a file is uploaded to
an S3 bucket, EventBridge triggers a Step Functions state machine. The state machine
checks the file size and routes processing to either a Lambda function (files ≤ 6 MB)
or a Fargate task (files > 6 MB).

The architecture includes:

- An S3 bucket with EventBridge notifications enabled
- An EventBridge rule that triggers Step Functions on S3 object creation
- A Step Functions state machine with a Choice state for routing
- A Lambda function for processing small files
- An ECS Fargate task for processing large files
- A VPC with two subnets, internet gateway, and security group
- An ECR repository for the Fargate container image
- Scoped IAM roles for Lambda, Step Functions, and ECS tasks

Use this skill when:

- You need to process S3 uploads with different compute based on file size
- You want a serverless workflow that can handle both small and large files
- You need Step Functions orchestration with Lambda and Fargate

Do not use this skill when:

- All files are small enough for Lambda (use S3 → Lambda directly)
- You need real-time streaming (use Kinesis)
- You don't need file-size-based routing

## Prerequisites

1. **AWS CLI v2** — Installed and configured. Verify with `aws sts get-caller-identity`.
2. **Python 3.12** — For the Lambda function runtime.
3. **Docker** — For building and pushing the Fargate container image.

## Parameters

- bucket_name (required): Name for the S3 bucket (globally unique, lowercase, 3-63 characters)
- region (required): AWS region for all resources
- ecr_repo_name (required): Name for the ECR repository
- state_machine_name (required): Name for the Step Functions state machine
- kms_key_arn (optional): ARN of a KMS key for CloudWatch Logs encryption. If not provided, create one with `aws kms create-key --description "Key for CloudWatch Logs encryption" --region {region}`

Constraints for parameter acquisition:

- You MUST ask for all required parameters upfront in a single prompt
- You MUST support multiple input methods (direct input, file path, URL)
- You MUST confirm successful acquisition of all parameters before proceeding
- You MUST validate that bucket_name follows S3 naming rules

## Procedures

### Step 0: Verify Dependencies

Constraints:

- You MUST verify the following tools are available: aws-cli, python3 (3.12+), docker
- You MUST inform the user about any missing tools with a clear message
- You MUST ask if the user wants to proceed despite missing tools
- You MUST respect the customer's decision to abort at any point
- You MUST explain to the customer what step is being executed, why, and which tool is being called

### Step 1: Retrieve AWS Account ID

Constraints:

- You MUST retrieve the account ID with: `aws sts get-caller-identity --query 'Account' --output text`
- You MUST store the result as {account_id} for use in all subsequent steps
- You MUST abort if credentials are not configured

### Step 2: Get the Default VPC and Networking

Constraints:

- You MUST retrieve the default VPC ID with:
  `aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text --region {region}`
- If no default VPC exists, inform the user they must create one with `aws ec2 create-default-vpc --region {region}` or provide a VPC ID manually
- You MUST retrieve two subnet IDs from the default VPC:
  `aws ec2 describe-subnets --filters Name=vpc-id,Values={vpc_id} --query 'Subnets[0:2].SubnetId' --output text --region {region}`
- You MUST create a security group in the default VPC:
  `aws ec2 create-security-group --group-name fargate-sg --description "Security group for Fargate tasks" --vpc-id {vpc_id} --region {region}`
- You MUST configure security group egress rules to allow only HTTPS and DNS outbound. First revoke the default allow-all egress rule:
  `aws ec2 revoke-security-group-egress --group-id {sg_id} --ip-permissions IpProtocol=-1,IpRanges='[{CidrIp=0.0.0.0/0}]' --region {region}`
  Then add scoped rules:
  `aws ec2 authorize-security-group-egress --group-id {sg_id} --protocol tcp --port 443 --cidr 0.0.0.0/0 --region {region}` and
  `aws ec2 authorize-security-group-egress --group-id {sg_id} --protocol udp --port 53 --cidr 0.0.0.0/0 --region {region}`
- You MUST recommend VPC endpoints for S3 and CloudWatch Logs for production workloads to avoid internet-routed traffic and eliminate the need for broad egress rules
- You MUST capture {vpc_id}, {subnet1_id}, {subnet2_id}, and {sg_id} for use in later steps

### Step 3: Create the ECR Repository

Constraints:

- You MUST create the repository with:
  `aws ecr create-repository --repository-name {ecr_repo_name} --region {region}`
- You MUST capture the repositoryUri from the response

### Step 4: Build and Push the Container Image

Constraints:

- You MUST verify Docker is installed by running `docker --version`. If Docker is not installed, instruct the user to install it from https://docs.docker.com/get-docker/ and abort until it is available
- You MUST authenticate Docker with ECR:
  `aws ecr get-login-password --region {region} | docker login --username AWS --password-stdin {account_id}.dkr.ecr.{region}.amazonaws.com`
- The Dockerfile and processor code are in `scripts/Dockerfile` and `scripts/fargate_processor.py`
- You MUST build and push the image from the scripts directory:

  ```
  cd scripts
  docker build --platform linux/amd64 -t {ecr_repo_name} .
  docker tag {ecr_repo_name}:latest {account_id}.dkr.ecr.{region}.amazonaws.com/{ecr_repo_name}:latest
  docker push {account_id}.dkr.ecr.{region}.amazonaws.com/{ecr_repo_name}:latest
  cd ..
  ```

### Step 5: Create IAM Roles

Follow the detailed instructions in `references/iam-roles.md` to create all IAM roles (Lambda, ECS task execution, ECS task, Step Functions, and EventBridge roles).

- You MUST wait at least 10 seconds for IAM role propagation

### Step 6: Create the Lambda Function

Constraints:

- The function code is in `scripts/lambda_function.py`
- You MUST be in the skill root directory before packaging and creating the function
- You MUST package it with: `python3 -c "import zipfile,io; z=io.BytesIO(); f=zipfile.ZipFile(z,'w'); f.writestr('lambda_function.py', open('scripts/lambda_function.py').read()); f.close(); open('/tmp/lambda_function.zip','wb').write(z.getvalue())"`
- You MUST create the function with:

  ```
  aws lambda create-function \
      --function-name sfn-file-processor \
      --runtime python3.12 \
      --handler lambda_function.lambda_handler \
      --role arn:aws:iam::{account_id}:role/sfn-lambda-role \
      --zip-file fileb:///tmp/lambda_function.zip \
      --timeout 60 \
      --architectures x86_64 \
      --region {region}
  ```

- You MUST verify the function was created with:
  `aws lambda get-function --function-name sfn-file-processor --region {region}`

### Step 7: Create the CloudWatch Log Group

Constraints:

- You MUST create the log group for Fargate:
  `aws logs create-log-group --log-group-name /StepFunctionFargateTask --region {region}`
- You MUST encrypt the log group with a KMS key:
  `aws logs associate-kms-key --log-group-name /StepFunctionFargateTask --kms-key-arn {kms_key_arn} --region {region}`

### Step 8: Create the ECS Cluster and Task Definition

Follow the detailed instructions in `references/ecs-task-definition.md` to create the ECS cluster and register the Fargate task definition.

- You MUST capture the task definition ARN from the response

### Step 9: Create the S3 Bucket with EventBridge Notifications

Constraints:

- You MUST create the bucket with:
  `aws s3api create-bucket --bucket {bucket_name} --region {region} --create-bucket-configuration LocationConstraint={region}`
- You MUST NOT include `--create-bucket-configuration` if region is us-east-1
- You MUST enable EventBridge notifications on the bucket:
  `aws s3api put-bucket-notification-configuration --bucket {bucket_name} --notification-configuration '{"EventBridgeConfiguration": {}}' --region {region}`
- You MUST enable default encryption on the bucket:
  `aws s3api put-bucket-encryption --bucket {bucket_name} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}' --region {region}`

### Step 10: Create the Step Functions State Machine

Constraints:

- The state machine definition is in `scripts/statemachine.asl.json`
- You MUST create a working copy and replace all placeholders:

  ```
  sed -e 's|${LambdaFunction}|arn:aws:lambda:{region}:{account_id}:function:sfn-file-processor|g' \
      -e 's|${Cluster}|arn:aws:ecs:{region}:{account_id}:cluster/sfn-cluster|g' \
      -e 's|${TaskDefinition}|{task_definition_arn}|g' \
      -e 's|${Subnet1}|{subnet1_id}|g' \
      -e 's|${Subnet2}|{subnet2_id}|g' \
      -e 's|${SecurityGroup}|{sg_id}|g' \
      scripts/statemachine.asl.json > /tmp/statemachine.asl.json
  ```

- You MUST create the state machine with:

  ```
  aws stepfunctions create-state-machine \
      --name {state_machine_name} \
      --definition file:///tmp/statemachine.asl.json \
      --role-arn arn:aws:iam::{account_id}:role/sfn-state-machine-role \
      --type STANDARD \
      --region {region}
  ```

- You MUST capture the stateMachineArn from the response

### Step 11: Create the EventBridge Rule

Constraints:

- You MUST create the EventBridge rule to trigger on S3 object creation:

  ```
  aws events put-rule \
      --name s3-to-stepfunctions \
      --event-pattern '{
        "source": ["aws.s3"],
        "detail-type": ["Object Created"],
        "detail": {
          "bucket": {
            "name": ["{bucket_name}"]
          }
        }
      }' \
      --region {region}
  ```

- You MUST add the state machine as a target:

  ```
  aws events put-targets \
      --rule s3-to-stepfunctions \
      --targets '[{
        "Id": "StepFunctionsTarget",
        "Arn": "{state_machine_arn}",
        "RoleArn": "arn:aws:iam::{account_id}:role/sfn-eventbridge-role"
      }]' \
      --region {region}
  ```

### Step 12: Configure Monitoring

Constraints:

- You MUST create a Dead Letter Queue for failed EventBridge invocations:
  `aws sqs create-queue --queue-name s3-to-stepfunctions-dlq --region {region}`
- You MUST update the EventBridge target to attach the DLQ:

  ```
  aws events put-targets \
      --rule s3-to-stepfunctions \
      --targets '[{
        "Id": "StepFunctionsTarget",
        "Arn": "{state_machine_arn}",
        "RoleArn": "arn:aws:iam::{account_id}:role/sfn-eventbridge-role",
        "DeadLetterConfig": {
          "Arn": "arn:aws:sqs:{region}:{account_id}:s3-to-stepfunctions-dlq"
        }
      }]' \
      --region {region}
  ```

- You MUST create a CloudWatch alarm for Step Functions execution failures:
  `aws cloudwatch put-metric-alarm --alarm-name sfn-execution-failures --metric-name ExecutionsFailed --namespace AWS/States --statistic Sum --period 300 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold --evaluation-periods 1 --dimensions Name=StateMachineArn,Value={state_machine_arn} --region {region}`

### Step 13: Validate

Constraints:

- You MUST test with a small file (< 6 MB) to verify Lambda processing:

  ```
  echo 'test data' > /tmp/small-file.txt
  aws s3 cp /tmp/small-file.txt s3://{bucket_name}/small-file.txt --region {region}
  ```

- You MUST wait 15 seconds then check the Step Functions execution:
  `aws stepfunctions list-executions --state-machine-arn {state_machine_arn} --region {region}`
- You MUST verify the execution succeeded and routed to Lambda
- You MUST provide a summary of all created resources including: VPC ID, subnet IDs, security group ID, ECR repo URI, ECS cluster ARN, task definition ARN, Lambda function ARN, state machine ARN, bucket name, and EventBridge rule name

## Troubleshooting

### EventBridge rule not triggering

- Verify EventBridge notifications are enabled on the bucket: `aws s3api get-bucket-notification-configuration --bucket {bucket_name}`
- Verify the rule exists: `aws events describe-rule --name s3-to-stepfunctions --region {region}`
- Check that the target has the correct state machine ARN and role

### Step Functions execution fails at Fargate task

- Verify the container image exists in ECR: `aws ecr describe-images --repository-name {ecr_repo_name} --region {region}`
- Check that the subnets have internet access (route table with IGW)
- Verify the security group allows outbound traffic
- Check CloudWatch Logs at `/StepFunctionFargateTask`

### Lambda invocation fails

- Check CloudWatch Logs: `aws logs tail /aws/lambda/sfn-file-processor --region {region}`
- Verify the Step Functions role has `lambda:InvokeFunction` permission

### IAM PassRole errors

- The Step Functions role must have `iam:PassRole` for both the ECS execution role and task role ARNs

### Fargate task stuck in PROVISIONING

- Verify the subnets have auto-assign public IP enabled
- Verify the internet gateway is attached and route table has 0.0.0.0/0 route

## Security Considerations

- Fargate tasks with public IPs are exposed to the internet. Revoke the default allow-all egress rule and configure scoped egress: `aws ec2 revoke-security-group-egress --group-id {sg_id} --ip-permissions IpProtocol=-1,IpRanges='[{CidrIp=0.0.0.0/0}]'` then add `aws ec2 authorize-security-group-egress --group-id {sg_id} --protocol tcp --port 443 --cidr 0.0.0.0/0` and `aws ec2 authorize-security-group-egress --group-id {sg_id} --protocol udp --port 53 --cidr 0.0.0.0/0`. For production, consider using VPC endpoints for S3 and CloudWatch Logs instead of internet-routed traffic.
- Scan container images for vulnerabilities before pushing to ECR. Enable ECR image scanning with: `aws ecr put-image-scanning-configuration --repository-name {ecr_repo_name} --image-scanning-configuration scanOnPush=true --region {region}`
- Use IAM roles for credentials — never hardcode access keys in container code.
- Enable encryption at rest for the S3 bucket: `aws s3api put-bucket-encryption --bucket {bucket_name} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'`
- Enable CloudWatch Logs encryption for Fargate container logs: `aws logs associate-kms-key --log-group-name /StepFunctionFargateTask --kms-key-arn <KMS_KEY_ARN>`
- Configure a Dead Letter Queue on the EventBridge rule for failed invocations
- Set up CloudWatch alarms on Step Functions execution failures for operational visibility

## Version information

- **AWS CLI**: 2.x
- **Python runtime**: 3.12
- **Last validated**: 2026-04-27

## Additional Resources

- [Step Functions developer guide](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [EventBridge S3 events](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html)
- [Fargate task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definitions.html)
- [ECR pushing images](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)
- [Step Functions Fargate integration](https://docs.aws.amazon.com/step-functions/latest/dg/connect-ecs.html)
