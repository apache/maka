---
name: deploying-custom-domain-rest-api
description: >
  Deploys a Regional REST API with a custom domain name, a Lambda backend function,
  and a request-based Lambda authorizer using AWS CLI. Covers ACM certificate
  provisioning, API Gateway REST API creation, Lambda function deployment, request
  authorizer setup, custom domain configuration, base path mapping, and Route 53
  DNS record creation. Trigger keywords: custom domain, REST API, Lambda, Route 53,
  API Gateway, regional endpoint, request authorizer, base path mapping.
version: 1
---

# Custom Domain REST API with Lambda and Request Authorizer

## Overview

This SOP deploys a REST API with a Regional custom domain name, a Lambda backend function, and a request-based Lambda authorizer. It handles ACM certificate provisioning, IAM role creation, Lambda function deployment, API Gateway REST API creation with a custom authorizer, custom domain configuration, base path mapping, and Route 53 DNS setup.

The architecture includes:

- An API Gateway REST API with an endpoint type of REGIONAL
- A request-based Lambda authorizer that validates headers, query string parameters, and stage variables
- A Lambda backend function at `GET /example`
- A custom domain name with TLS 1.2
- A base path mapping connecting the custom domain to the API stage
- A Route 53 A-alias record pointing the custom domain to the API Gateway Regional endpoint

Important: This SOP uses Regional endpoints. If the user requests a private endpoint, inform them that this skill covers Regional endpoints only. Private endpoints require VPC endpoint configuration.

## Parameters

- custom_domain_name (required): Fully qualified domain name for the API (e.g., `api.example.com`)
- region (required): AWS Region for all resources. The ACM certificate must be in this same Region for Regional endpoints
- hosted_zone_id (required): Route 53 hosted zone ID for the domain
- acm_certificate_arn (optional): ARN of an existing ACM certificate covering the custom domain. If not provided, Step 2 creates one
- stage_name (optional, default: "dev"): API Gateway stage name

Constraints for parameter acquisition:

- You MUST ask for all required parameters upfront in a single prompt rather than one at a time
- You MUST support multiple input methods (direct input, file path, URL)
- You MUST confirm successful acquisition of all parameters before proceeding
- You MUST inform the user that this skill uses hardcoded demo authorization values (headerValue1, queryValue1, stageValue1) that are NOT suitable for production. For production, use AWS Secrets Manager or Systems Manager Parameter Store to manage authorization credentials. See: https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html
- You MUST validate that custom_domain_name is a valid FQDN

## Steps

### 0. Verify Dependencies

Constraints:

- You MUST verify the following tools are available: aws-cli, python3, sed, node (v22+)
- You MUST inform the user about any missing tools with a clear message
- You MUST ask if the user wants to proceed despite missing tools
- You MUST respect the customer's decision to abort at any point
- You MUST explain to the customer what step is being executed, why, and which tool is being called

### 1. Retrieve AWS Account ID

This step MUST be performed before all other steps.

Constraints:

- You MUST retrieve the account ID with: `aws sts get-caller-identity --query 'Account' --output text`
- You MUST store the result as {account_id} and reuse it in all subsequent steps that reference {account_id}
- You MUST abort if credentials are not configured

### 2. Request ACM Certificate

Skip this step if acm_certificate_arn is already provided.

Constraints:

- You MUST request the certificate with: `aws acm request-certificate --domain-name {custom_domain_name} --validation-method DNS --region {region}`
- You MUST capture the CertificateArn from the response
- You MUST retrieve the DNS validation record with: `aws acm describe-certificate --certificate-arn {cert_arn} --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --region {region}`
- You MUST create the validation CNAME in Route 53 with: `aws route53 change-resource-record-sets --hosted-zone-id {hosted_zone_id} --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"{validation_name}","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"{validation_value}"}]}}]}'`
- You MUST wait for certificate validation with: `aws acm wait certificate-validated --certificate-arn {cert_arn} --region {region}`
- The wait command may take up to 30 minutes. If it times out, check status manually with: `aws acm describe-certificate --certificate-arn {cert_arn} --query 'Certificate.Status' --region {region}` and retry the wait if status is still PENDING_VALIDATION
- You MUST NOT proceed until the certificate status is ISSUED
- You MUST store the certificate ARN as acm_certificate_arn for use in Step 7

### 3. Create IAM Execution Roles

Constraints:

- You MUST create two IAM roles: one for the authorizer Lambda and one for the example function Lambda
- Both roles use the same trust policy from `scripts/lambda-trust-policy.json`. The trust policy includes an `aws:SourceAccount` condition scoped to the user's account ID
- You MUST create a working copy of the trust policy and replace the `ACCOUNT_ID` placeholder with the actual account ID from Step 1. Use: `sed 's/ACCOUNT_ID/{account_id}/' scripts/lambda-trust-policy.json > /tmp/lambda-trust-policy.json`
- You MUST create the authorizer role with: `aws iam create-role --role-name request-authorizer-role --assume-role-policy-document file:///tmp/lambda-trust-policy.json`
- You MUST attach the basic execution policy to the authorizer role with: `aws iam attach-role-policy --role-name request-authorizer-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`
- You MUST create the example function role with: `aws iam create-role --role-name example-function-role --assume-role-policy-document file:///tmp/lambda-trust-policy.json`
- You MUST attach the basic execution policy to the example function role with: `aws iam attach-role-policy --role-name example-function-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`
- You MUST capture the role ARNs from each create-role response for use in Step 4
- You MUST wait at least 10 seconds after role creation before creating Lambda functions because IAM role propagation is eventually consistent

### 4. Create and Deploy Lambda Functions

Constraints:

- You MUST create two Lambda functions: the request authorizer and the example function
- For the authorizer function:
  - You MUST create the function with inline code. First write the code to a file and package it:
    `python3 -c "import zipfile,io,base64; z=io.BytesIO(); f=zipfile.ZipFile(z,'w'); f.writestr('index.mjs', open('scripts/authorizer.mjs').read()); f.close(); open('/tmp/authorizer.zip','wb').write(z.getvalue())"`
  - Then create the function with: `aws lambda create-function --function-name request-authorizer --runtime nodejs22.x --handler index.handler --role {authorizer_role_arn} --zip-file fileb:///tmp/authorizer.zip --timeout 10 --region {region}`
- For the example function:
  - You MUST create the function with inline code. First write the code to a file and package it:
    `python3 -c "import zipfile,io; z=io.BytesIO(); f=zipfile.ZipFile(z,'w'); f.writestr('index.mjs', open('scripts/example_function.mjs').read()); f.close(); open('/tmp/example_function.zip','wb').write(z.getvalue())"`
  - Then create the function with: `aws lambda create-function --function-name example-function --runtime nodejs22.x --handler index.handler --role {example_role_arn} --zip-file fileb:///tmp/example_function.zip --timeout 10 --region {region}`
- You MUST verify each function was created by calling: `aws lambda get-function --function-name {function_name} --region {region}`

### 5. Create REST API with Request Authorizer

Constraints:

- You MUST create the REST API with: `aws apigateway create-rest-api --name custom-domain-api --endpoint-configuration types=REGIONAL --region {region}`
- You MUST capture the API id and get the root resource ID with: `aws apigateway get-resources --rest-api-id {api_id} --region {region}`
- You MUST create the request-based Lambda authorizer with: `aws apigateway create-authorizer --rest-api-id {api_id} --name request-authorizer --type REQUEST --authorizer-uri 'arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/arn:aws:lambda:{region}:{account_id}:function:request-authorizer/invocations' --identity-source 'method.request.header.HeaderAuth1,method.request.querystring.QueryString1,context.stage' --region {region}`
- You MUST capture the authorizer ID from the response
- You MUST grant API Gateway permission to invoke the authorizer with: `aws lambda add-permission --function-name request-authorizer --statement-id apigateway-auth-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn 'arn:aws:execute-api:{region}:{account_id}:{api_id}/authorizers/{authorizer_id}' --region {region}`
- You MUST create the /example resource with: `aws apigateway create-resource --rest-api-id {api_id} --parent-id {root_resource_id} --path-part example --region {region}`
- You MUST create the GET method with: `aws apigateway put-method --rest-api-id {api_id} --resource-id {example_resource_id} --http-method GET --authorization-type CUSTOM --authorizer-id {authorizer_id} --region {region}`
- You MUST create the Lambda proxy integration with: `aws apigateway put-integration --rest-api-id {api_id} --resource-id {example_resource_id} --http-method GET --type AWS_PROXY --integration-http-method POST --uri 'arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/arn:aws:lambda:{region}:{account_id}:function:example-function/invocations' --region {region}`
- You MUST grant API Gateway permission to invoke the example function with: `aws lambda add-permission --function-name example-function --statement-id apigateway-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn 'arn:aws:execute-api:{region}:{account_id}:{api_id}/*/GET/example' --region {region}`
- You MUST NOT create the deployment until all resources, methods, and integrations are configured
- You MUST configure request validation to reject malformed query parameters and headers by validating that QueryString1 and HeaderAuth1 match expected patterns and enforcing size limits

### 6. Deploy the API

Constraints:

- You MUST create the deployment with: `aws apigateway create-deployment --rest-api-id {api_id} --stage-name {stage_name} --region {region}`
- You MUST set the stage variable required by the authorizer with: `aws apigateway update-stage --rest-api-id {api_id} --stage-name {stage_name} --patch-operations op=replace,path=/variables/StageVar1,value=stageValue1 --region {region}`
- You MUST verify the deployment and stage variable by calling: `aws apigateway get-stage --rest-api-id {api_id} --stage-name {stage_name} --region {region}` and confirming StageVar1 is present in the variables
- You MUST enable access logging on the stage. First create the log group: `aws logs create-log-group --log-group-name api-gw-access-logs --region {region}`. Then enable logging with format: `aws apigateway update-stage --rest-api-id {api_id} --stage-name {stage_name} --patch-operations op=replace,path=/accessLogSettings/destinationArn,value=arn:aws:logs:{region}:{account_id}:log-group:api-gw-access-logs op=replace,path=/accessLogSettings/format,value='{"requestId":"$context.requestId","ip":"$context.identity.sourceIp","requestTime":"$context.requestTime","httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath","status":"$context.status"}' --region {region}`

### 7. Create Custom Domain and Base Path Mapping

Constraints:

- You MUST create the custom domain with: `aws apigateway create-domain-name --domain-name {custom_domain_name} --regional-certificate-arn {acm_certificate_arn} --endpoint-configuration types=REGIONAL --security-policy TLS_1_2 --region {region}`
- You MUST capture the regionalDomainName and regionalHostedZoneId from the response for use in Step 8
- You MUST create the base path mapping with: `aws apigateway create-base-path-mapping --domain-name {custom_domain_name} --rest-api-id {api_id} --stage {stage_name} --base-path '(none)' --region {region}`
- You MUST verify the domain was created by calling: `aws apigateway get-domain-name --domain-name {custom_domain_name} --region {region}`
- You MUST NOT downgrade the security policy below TLS_1_2

### 8. Create Route 53 DNS Record

Constraints:

- You MUST create a working copy of `scripts/dns-record.json` with placeholders replaced: `sed -e 's/CUSTOM_DOMAIN_NAME/{custom_domain_name}/' -e 's/REGIONAL_DOMAIN_NAME/{regional_domain_name}/' -e 's/REGIONAL_HOSTED_ZONE_ID/{regional_hosted_zone_id}/' scripts/dns-record.json > /tmp/dns-record.json`
- The command is: `aws route53 change-resource-record-sets --hosted-zone-id {hosted_zone_id} --change-batch file:///tmp/dns-record.json`
- You MUST use the regionalDomainName and regionalHostedZoneId captured from Step 7, not the user's hosted zone ID for the AliasTarget
- You MUST use an A-alias record (not CNAME) when using Route 53 as the DNS provider
- You SHOULD inform the user that DNS propagation can take up to 48 hours

### 9. Validate Final Setup

Constraints:

- You SHOULD run `scripts/validate.sh {custom_domain_name} {api_id} {region}` to check all resources
- You MUST inform the user to test with: `curl 'https://{custom_domain_name}/example?QueryString1=queryValue1' -H 'HeaderAuth1: headerValue1'`
- You MUST explain that the expected response is a 200 with `{"message": "Hello from the example function!"}`
- You MUST explain that requests missing the correct HeaderAuth1 header or QueryString1 query parameter will be denied by the authorizer
- You MUST provide a summary of all created resources including:
  - ACM certificate ARN
  - IAM role ARNs
  - Lambda function ARNs
  - REST API ID and stage name
  - Authorizer ID
  - Custom domain name and Regional domain name
  - Route 53 DNS record

## Examples

### Example Input

```
custom_domain_name: api.example.com
region: us-east-2
hosted_zone_id: Z2OJLYMUO9EFXC
stage_name: prod
```

### Example Output

```
ACM certificate issued for api.example.com
  ARN: arn:aws:acm:us-east-2:123456789012:certificate/abc-123

IAM roles created
  Authorizer: arn:aws:iam::123456789012:role/request-authorizer-role
  Example: arn:aws:iam::123456789012:role/example-function-role

Lambda functions deployed
  Authorizer: arn:aws:lambda:us-east-2:123456789012:function:request-authorizer
  Example: arn:aws:lambda:us-east-2:123456789012:function:example-function

REST API deployed
  API ID: a1b2c3d4e5
  Stage: prod (StageVar1=stageValue1)
  Authorizer: request-authorizer (REQUEST type)

Custom domain configured
  Domain: api.example.com
  Regional endpoint: d-abc123.execute-api.us-east-2.amazonaws.com
  TLS: 1.2

Route 53 DNS record created
  A-alias: api.example.com -> d-abc123.execute-api.us-east-2.amazonaws.com

Test command (authorized):
  curl 'https://api.example.com/example?QueryString1=queryValue1' -H 'HeaderAuth1: headerValue1'

Test command (denied):
  curl 'https://api.example.com/example'
```

## Troubleshooting

### Certificate Stuck in PENDING_VALIDATION

Verify the DNS validation CNAME record exists in Route 53 by running `aws acm describe-certificate --certificate-arn {arn} --query 'Certificate.DomainValidationOptions'`. Ensure the CNAME was created in the correct hosted zone.

### 403 Forbidden on API Calls

The request authorizer checks three values: `HeaderAuth1` header must be `headerValue1`, `QueryString1` query parameter must be `queryValue1`, and stage variable `StageVar1` must be `stageValue1`. Verify all three are present and correct. Check CloudWatch Logs for the authorizer function for detailed error messages.

### 401 Unauthorized

API Gateway returns 401 when the authorizer function cannot be invoked. Verify the Lambda permission was added for API Gateway to invoke the authorizer. Check that the authorizer URI is correct.

### Missing Authentication Token (403)

The request path doesn't match a configured resource. Verify the `/example` resource exists with `aws apigateway get-resources --rest-api-id {api_id}`. Ensure the API was deployed after creating all resources.

### Custom Domain Returns No Response

DNS propagation can take up to 48 hours. Check with `dig {custom_domain_name}`. Verify the A-alias record points to the correct regionalDomainName and regionalHostedZoneId from the create-domain-name response.

### Stage Variable Not Set

If the authorizer denies all requests, verify the stage variable was set with `aws apigateway get-stage --rest-api-id {api_id} --stage-name {stage_name} --query 'variables'`. The StageVar1 variable must be set to `stageValue1`.

### IAM Role Not Found When Creating Lambda

IAM role propagation is eventually consistent. Wait at least 10 seconds after role creation before creating Lambda functions. Verify the role ARN with `aws iam get-role --role-name {role_name}`.

### Base Path Mapping Not Working

Verify with `aws apigateway get-base-path-mappings --domain-name {custom_domain_name}`. The base path `(none)` maps the domain root to the stage. Ensure the deployment to the stage completed successfully.

## Security Considerations

- The hardcoded authorization values (`headerValue1`, `queryValue1`, `stageValue1`) in the Lambda authorizer are **for demonstration only** and are NOT suitable for production. Replace with proper authentication mechanisms (JWT validation, API keys from AWS Secrets Manager, or OAuth) before deploying to production.
- Enable request throttling on the API stage to prevent abuse. Configure rate and burst limits with: `aws apigateway update-stage --rest-api-id {api_id} --stage-name {stage_name} --patch-operations op=replace,path=/throttle/rateLimit,value=1000 op=replace,path=/throttle/burstLimit,value=2000`
- Enable CloudWatch Logs encryption for Lambda log groups. Associate a KMS key with: `aws logs associate-kms-key --log-group-name /aws/lambda/request-authorizer --kms-key-arn <KMS_KEY_ARN>`
- Protect the public API with AWS WAF to mitigate common exploits (SQL injection, XSS, rate-based rules): `aws wafv2 associate-web-acl --web-acl-arn <WAF_ACL_ARN> --resource-arn arn:aws:apigateway:{region}::/restapis/{api_id}/stages/{stage_name}`

## Additional Resources

- [API Gateway custom domain names](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-custom-domains.html)
- [ACM certificate validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html)
- [Route 53 alias records](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html)
- [API Gateway Regional endpoints](https://docs.aws.amazon.com/apigateway/latest/developerguide/create-regional-api.html)
