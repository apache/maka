---
name: "cloudwatch"
displayName: "AWS CloudWatch Observability"
description: "Query metrics, alarms, and logs from AWS CloudWatch for troubleshooting and root cause analysis"
keywords: ["cloudwatch", "aws", "observability", "monitoring", "metrics", "alarms", "logs", "troubleshooting"]
author: "AWS"
---

# Overview

The AWS CloudWatch Observability Power provides comprehensive access to your AWS monitoring data across logs, metrics, APM traces, Real User Monitoring (RUM), incidents, and monitors, for production debugging (incident response), performance monitoring, and root cause analysis.

## Available MCP Servers

### awslabs.cloudwatch-mcp-server
**Package:** `awslabs.cloudwatch-mcp-server`

#### Configuration

Requires AWS credentials (AWS CLI profile or IAM role) and appropriate IAM permissions for CloudWatch access. Configure via `mcp.json`:

Parametrized fields:
- `${REGION}` - AWS region (e.g., us-east-1)
- `${AWS_PROFILE}` - AWS CLI profile name (optional, uses default if not set)

```json
{
  "mcpServers": {
    "awslabs.cloudwatch-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.cloudwatch-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "default",
        "AWS_REGION": "us-east-1",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    }
  }
}
```

#### Metrics Tools

##### get_metric_data
Retrieves metric data for CloudWatch metrics with multiple statistics and time ranges. Supports both standard metric queries and Metrics Insights queries for advanced filtering and grouping.

**Parameters:**
- `namespace` (required, string): CloudWatch namespace (e.g., "AWS/EC2", "AWS/Lambda")
- `metric_name` (required, string): Metric name (e.g., "CPUUtilization")
- `start_time` (required, string): Start time in ISO 8601 format or datetime
- `dimensions` (optional, array): List of dimension objects to filter metrics (default: [])
- `end_time` (optional, string): End time in ISO 8601 format or datetime (default: current time)
- `statistic` (optional, string): Statistic to use - "AVG", "COUNT", "MAX", "MIN", "SUM", "Average", "Sum", "Maximum", "Minimum", "SampleCount" (default: "AVG")
- `target_datapoints` (optional, number): Target number of data points to return, controls granularity (default: 60)
- `group_by_dimension` (optional, string): Dimension name to group by in Metrics Insights mode (must be in schema_dimension_keys)
- `schema_dimension_keys` (optional, array): List of dimension keys for Metrics Insights SCHEMA definition (default: [])
- `limit` (optional, number): Maximum number of results in Metrics Insights mode
- `sort_order` (optional, string): Sort order for results - "ASC" or "DESC"
- `order_by_statistic` (optional, string): Statistic for ORDER BY clause - "AVG", "COUNT", "MAX", "MIN", "SUM" (required if sort_order specified)
- `region` (optional, string): AWS region to query (default: "us-east-1")

##### get_metric_metadata
Retrieves metadata for a CloudWatch metric including semantic description, recommended statistics to use in other metric tools and when defining alarm configurations.

**Parameters:**
- `namespace` (required, string): CloudWatch namespace
- `metric_name` (required, string): Metric name

##### get_recommended_metric_alarms
Provides recommended alarm configurations based on AWS best practices.

**Parameters:**
- `namespace` (required, string): CloudWatch namespace
- `metric_name` (required, string): Metric name
- `dimensions` (optional, object): Specific resource dimensions

##### analyze_metric
Analyzes metric time-series data for trends, seasonality, anomalies, and statistical properties.

**Parameters:**
- `namespace` (required, string): CloudWatch namespace
- `metric_name` (required, string): Metric name
- `dimensions` (optional, object): Metric dimensions
- `start_time` (required, string): Start time in ISO 8601 format
- `end_time` (required, string): End time in ISO 8601 format
- `statistic` (optional, string): Statistic to analyze (default: "Average")
- `region` (optional, string): AWS region to query (default: "us-east-1")

#### Alarms Tools

##### get_active_alarms
Identifies currently active CloudWatch alarms across the AWS account.

**Parameters:**
- `state_value` (optional, string): Filter by state ("ALARM", "OK", "INSUFFICIENT_DATA")
- `alarm_name_prefix` (optional, string): Filter by name prefix
- `alarm_types` (optional, array): Filter by alarm type (["MetricAlarm", "CompositeAlarm"])
- `max_records` (optional, number): Maximum alarms to return (default: 100)

##### get_alarm_history
Retrieves historical state changes and configuration updates for a specific alarm.

**Parameters:**
- `alarm_name` (required, string): Alarm name
- `history_item_type` (optional, string): Filter by type ("StateUpdate", "ConfigurationUpdate", "Action")
- `start_time` (optional, string): Start time in ISO 8601 format
- `end_time` (optional, string): End time in ISO 8601 format
- `max_records` (optional, number): Maximum history items to return (default: 100)
- `region` (optional, string): AWS region to query (default: "us-east-1")

#### Logs Tools

##### describe_log_groups
Discovers CloudWatch log groups with metadata including retention settings and storage size.

**Parameters:**
- `log_group_name_prefix` (optional, string): Filter by name prefix
- `log_group_name_pattern` (optional, string): Filter by name pattern (supports wildcards)
- `limit` (optional, number): Maximum log groups to return (default: 50, max: 50)
- `next_token` (optional, string): Pagination token
- `region` (optional, string): AWS region to query (default: "us-east-1")

##### analyze_log_group
Analyzes a log group for anomalies, error patterns, message patterns, and log volume trends.

**Parameters:**
- `log_group_name` (required, string): Log group name
- `start_time` (optional, string): Start time in ISO 8601 format (default: 1 hour ago)
- `end_time` (optional, string): End time in ISO 8601 format (default: now)
- `region` (optional, string): AWS region to query (default: "us-east-1")

##### execute_log_insights_query
Executes a CloudWatch Logs Insights query to search and analyze log data.

**Parameters:**
- `log_group_names` (required, array): Array of log group names to query
- `query_string` (required, string): Logs Insights query using CloudWatch query syntax
- `start_time` (required, string): Start time in ISO 8601 format
- `end_time` (required, string): End time in ISO 8601 format
- `limit` (optional, number): Maximum log events to return (default: 1000, max: 10000)
- `region` (optional, string): AWS region to query (default: "us-east-1")

##### get_logs_insight_query_results
Retrieves the results of a previously executed CloudWatch Logs Insights query.

**Parameters:**
- `query_id` (required, string): Query ID from execute_log_insights_query
- `region` (optional, string): AWS region to query (default: "us-east-1")

##### cancel_logs_insight_query
Cancels a running CloudWatch Logs Insights query.

**Parameters:**
- `query_id` (required, string): Query ID to cancel
- `region` (optional, string): AWS region to query (default: "us-east-1")

## Tool Usage Examples

### Querying Metrics

**Get Lambda function duration:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_metric_data", {
  "namespace": "AWS/Lambda",
  "metric_name": "Duration",
  "dimensions": {
    "FunctionName": "data-processor"
  },
  "statistics": ["p99"],
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "period": 300,
  "region": "us-east-1"
})
// Returns: Time-series data showing function execution duration
```

**Get TOP 10 EC2 Instance High CPU utilization:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_metric_data", {
  "namespace": "AWS/EC2",
  "metric_name": "CPUUtilization",
  "schema_dimension_keys": ["InstanceId"],
  "group_by_dimension": "InstanceId"
  "statistic": "AVG",
  "order_by_statistic": "MAX",
  "limit": 10,
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "region": "us-east-1"
})
// Returns: CPU usage data points over time for top 10 EC2 Instances
```

**Analyze metric trends:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "analyze_metric", {
  "namespace": "AWS/RDS",
  "metric_name": "CPUUtilization",
  "dimensions": {
    "DBInstanceIdentifier": "prod-database"
  },
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "statistic": "Average",
  "region": "us-east-1"
})
// Returns: Trend analysis, anomalies, statistical summary
```

### Managing Alarms

**Get active alarms:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_active_alarms", {
  "state_value": "ALARM",
  "region": "us-east-1"
})
// Returns: All alarms currently in ALARM state
```

**Get alarm history:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_alarm_history", {
  "alarm_name": "prod-api-high-error-rate",
  "history_item_type": "StateUpdate",
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "region": "us-east-1"
})
// Returns: Timeline of alarm state changes
```

**Get recommended alarms for Lambda errors:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_recommended_metric_alarms", {
  "namespace": "AWS/Lambda",
  "metric_name": "Errors",
  "dimensions": [
    {"name": "FunctionName", "value": "my-function"}
  ],
  "statistic": "Sum"  // Use 'Sum' for count metrics like Errors, Invocations
})
// Returns: Recommended alarm thresholds, evaluation periods, and configurations
```

**Get recommended alarms for EC2 CPU:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_recommended_metric_alarms", {
  "namespace": "AWS/EC2",
  "metric_name": "CPUUtilization",
  "dimensions": [
    {"name": "InstanceId", "value": "i-1234567890abcdef0"}
  ],
  "statistic": "Average"  // Use 'Average' for utilization metrics
})
// Returns: Best practice alarm configurations for CPU monitoring
```

**Get recommended alarms for RDS connections:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_recommended_metric_alarms", {
  "namespace": "AWS/RDS",
  "metric_name": "DatabaseConnections",
  "dimensions": [
    {"name": "DBInstanceIdentifier", "value": "prod-database"}
  ],
  "statistic": "Average"
})
// Returns: Connection threshold recommendations based on instance type
```

### Searching Logs

**Find Lambda log groups:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "describe_log_groups", {
  "log_group_name_prefix": "/aws/lambda/",
  "region": "us-east-1"
})
// Returns: All Lambda function log groups
```

**Analyze logs for anomalies:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "analyze_log_group", {
  "log_group_name": "/aws/lambda/my-function",
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "region": "us-east-1"
})
// Returns: Error patterns, frequencies, and trends
```

**Search logs with Insights query:**
```javascript
usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "execute_log_insights_query", {
  "log_group_names": ["/aws/lambda/my-function"],
  "query_string": "fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 100",
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "region": "us-east-1"
})
// Returns: A dictionary containing the final query results
```

## Combining Tools (Workflows)

### Workflow 1: Alarm Investigation

```javascript
// Step 1: Find active alarms
const alarms = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_active_alarms", {
  "state_value": "ALARM",
  "region": "us-east-1"
})

// Step 2: Get alarm history to see when it started
const history = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_alarm_history", {
  "alarm_name": alarms[0].alarm_name,
  "history_item_type": "StateUpdate",
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "region": "us-east-1"
})

// Step 3: Get the metric data that triggered the alarm
const metrics = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_metric_data", {
  "namespace": "AWS/Lambda",
  "metric_name": "Errors",
  "dimensions": {
    "FunctionName": "my-function"
  },
  "statistics": ["Sum"],
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "region": "us-east-1"
})

// Step 4: Search logs for error details
const query = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "execute_log_insights_query", {
  "log_group_names": ["/aws/lambda/my-function"],
  "query_string": "fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc",
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "region": "us-east-1"
})
```

### Workflow 2: Performance Analysis

```javascript
// Step 1: Analyze metric trends
const analysis = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "analyze_metric", {
  "namespace": "AWS/Lambda",
  "metric_name": "Duration",
  "dimensions": {
    "FunctionName": "data-processor"
  },
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "statistic": "Average",
  "region": "us-east-1"
})

// Step 2: Get detailed metric data
const metrics = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_metric_data", {
  "namespace": "AWS/Lambda",
  "metric_name": "Duration",
  "dimensions": {
    "FunctionName": "data-processor"
  },
  "statistics": ["Average", "Maximum", "p99"],
  "start_time": "2025-12-10T21:00:00+00:00",
  "end_time": "2025-12-15T21:00:00+00:00",
  "period": 60,
  "region": "us-east-1"
})
```

### Workflow 3: Generate CloudFormation Template from Alarm Recommendations

```javascript
// Step 1: Get alarm recommendations for Lambda function errors
const errorAlarms = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_recommended_metric_alarms", {
  "namespace": "AWS/Lambda",
  "metric_name": "Errors",
  "dimensions": [
    {"name": "FunctionName", "value": "my-function"}
  ],
  "statistic": "Sum"
})

// Step 2: Get alarm recommendations for Lambda function duration
const durationAlarms = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_recommended_metric_alarms", {
  "namespace": "AWS/Lambda",
  "metric_name": "Duration",
  "dimensions": [
    {"name": "FunctionName", "value": "my-function"}
  ],
  "statistic": "Average"
})

// Step 3: Get alarm recommendations for Lambda throttles
const throttleAlarms = usePower("cloudwatch", "awslabs.cloudwatch-mcp-server", "get_recommended_metric_alarms", {
  "namespace": "AWS/Lambda",
  "metric_name": "Throttles",
  "dimensions": [
    {"name": "FunctionName", "value": "my-function"}
  ],
  "statistic": "Sum"
})

// Step 4: Generate CloudFormation template from recommendations
// The agent will create a CloudFormation template with resources
```

## Best Practices

### ✅ Do:

- **Start with narrow time ranges** (1 hour) and expand if needed
- **Use specific dimensions** to filter metrics to exact resources
- **Leverage analyze_metric** for quick trend detection and anomalies
- **Use Logs Insights** for complex log queries with aggregations
- **Check active alarms first** when investigating issues
- **Get alarm history** to understand timing and patterns
- **Query multiple log groups** simultaneously for distributed traces
- **Use appropriate periods** (60s for recent data, 300s for longer ranges)
- **Store query_id** to retrieve results later if query is still running
- **Choose correct statistic for alarm recommendations and metric analysis**:
  - Use `Sum` for count metrics (Errors, Invocations, RequestCount, Throttles)
  - Use `Average` or `Maximum`/`Minimum` for utilization metrics (CPUUtilization, MemoryUtilization)
  - Use `Average` or percentiles (e.g.: `p99`) for latency/time metrics (Duration, Latency, ResponseTime)
  - Use `Average` for size metrics (PayloadSize, MessageSize)

### ❌ Don't:

- **Use very long time ranges** without reason (expensive and slow)
- **Forget to specify dimensions** - you'll get aggregated data across all resources
- **Query without time filters** - always specify start_time and end_time
- **Ignore query limits** - use limit parameter to control result size