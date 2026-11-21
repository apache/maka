---
name: enabling-lambda-vpc-internet-access
description: Enables internet access for AWS Lambda functions deployed in VPC subnets by creating NAT Gateway infrastructure, configuring public/private subnet routing, and updating security groups. Use when a VPC-attached Lambda function cannot reach the internet.
version: 1
---

# Enabling Lambda VPC Internet Access

## Overview

Domain expertise for enabling internet access from AWS Lambda functions running inside VPC private subnets. Lambda functions in a VPC cannot receive public IP addresses, so outbound internet access requires NAT Gateway infrastructure that routes traffic from private subnets through a public subnet to an Internet Gateway.

## Enable internet access for a VPC Lambda function

To set up NAT Gateway infrastructure and configure routing for a Lambda function that needs internet access, follow the procedure exactly.
See [Lambda VPC internet access setup procedure](references/lambda-vpc-internet-access.md).

## Troubleshooting

### NAT Gateway not working

Verify the route table associated with the Lambda subnets has a `0.0.0.0/0` route pointing to the NAT Gateway. See the full procedure for details.

### Lambda function timeout

Check that security group outbound rules allow the necessary ports and that both the NAT Gateway and Internet Gateway are properly configured.

### Network changes not taking effect

VPC networking changes can take 1–2 minutes to propagate. Wait before testing after creating a NAT Gateway or updating route tables.

### Route table association issues

Confirm the Lambda function's subnets are associated with the route table that has the `0.0.0.0/0` route to the NAT Gateway.
