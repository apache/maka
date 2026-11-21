---
name: analyze-account-health
description: Summarizes B2B account health by analyzing usage patterns, engagement trends, risk signals, and expansion opportunities. Use for customer success reviews, renewal preparation, QBRs, or account prioritization.
---

# Analyze Account Health

Deep-dive into a B2B account's product usage to prepare for QBRs, assess renewal risk, identify expansion opportunities, or prioritize CS outreach.

## Instructions

### Step 0: Identify Account & Discover Context

**Get the account identifier:**

- Company name, org ID, account ID, or group property value
- Ask user if not provided

**Search for existing work:**
Use `Amplitude:search_amp_entities` to find existing dashboards, charts, or notebooks for this account. If found, ask user if they want fresh analysis or to review existing.

**Resolve how accounts are modelled — do this before any query.**
Every step below breaks down "by account", and there are three different ways a
project represents one. Check in this order and reuse the answer throughout:

1. Use the connected catalog's group-type discovery capability. If the project
   has a group type (commonly `org id` or `company`), that is the account. Read
   its attributes from the active taxonomy reader's group-property surface,
   then reference them with `scope: 'group'` plus `group_type`. To count
   accounts rather than users, set `count_unique_by` to the group type.
2. If there is no group type, the account is usually a **user property**
   (`company`, `org_name`) — `scope: 'user'`.
3. Failing both, an **event property** carrying the org (`org id`, `org url`).

If a group property comes back as `Invalid group property … for group type …`,
the query engine's registry is missing it — that is a platform gap, not a
naming mistake. Do not retry spelling variants. Fall back to the user- or
event-level equivalent from (2)/(3), and tell the user which representation you
used, since the numbers are not interchangeable.

---

### Step 1: Quick Health Triage

Use `Amplitude:query_amplitude_data` to run these queries in parallel:

**Usage Trend:**

- Event: `_active`, Metric: `uniques`, Group by: the account property resolved in Step 0 (with its scope)
- Time: Last 60 days, daily interval
- **Shows:** Activity increasing or decreasing?

**Engagement Quality:**

- Calculate DAU and MAU for account
- Get DAU/MAU ratio (stickiness)
- **Shows:** How engaged are active users?

**User Momentum:**

- Active user count week-over-week
- **Shows:** Team growing or shrinking?

**Classify Health:**

- **Healthy**: Growing MAU, DAU/MAU >40%, positive WoW
- **At-Risk**: Flat/declining MAU, DAU/MAU 20-40%, negative WoW
- **Critical**: Steep decline, DAU/MAU <20%, sustained negative WoW

---

### Step 2: User-Level Analysis

Use `Amplitude:query_amplitude_data` with user-level groupBy:

**Power Users:**

- Top 3-5 users by event volume (champions to leverage)

**Churned Users:**

- Users active in previous period but not current (retention risks)

**License Utilization:**

- Active users in last 30 days vs total seats

---

### Step 3: Feature Usage Analysis

Use `Amplitude:query_amplitude_data` grouped by events/features:

**Feature Breadth:**

- Which core features are being used (ask user for 5-10 key features)
- Adoption rate per feature

**Feature Trends:**

- Usage over last 90 days per feature
- Identify growing vs declining features

**Focus based on health:**

- **If At-Risk/Critical:** Find abandoned features (used 60-90 days ago, not in last 30)
- **If Healthy:** Find expansion opportunities (premium features not yet tried)

---

### Step 4: Account Feedback Analysis

**Get feedback sources:**
Use `Amplitude:use_amplitude_ai_feedback` with `facet: "sources"` to see what's available.

**Get feedback insights:**
Use `Amplitude:use_amplitude_ai_feedback` with `facet: "insights"` filtered by:

- ampId for each user in the account
- dateStart/dateEnd: Last 90 days
- types: `bug`, `painPoint`, `complaint`, `request`, `lovedFeature`

**Get specific mentions:**
For top 3-5 insights, use `Amplitude:use_amplitude_ai_feedback` with `facet: "mentions"` to get quotes.

**Correlate with behavior:**

- Complaint about Feature X? Query their usage of Feature X
- Request for Feature Y? Check if they hit limits Y would solve
- Praise for Feature Z? Validate they're heavy users of Z

---

### Step 5: Present Account Health Report

Structure output as follows:

# Account Health Report: [Account Name]

## Executive Summary

[2-3 sentences: Health score, key trend, primary recommendation]

## Health Score: [🟢 Healthy | 🟡 At-Risk | 🔴 Critical]

[One sentence rationale with key metric]

---

## Key Metrics

| Metric              | Current | Trend  | Status |
| ------------------- | ------- | ------ | ------ |
| MAU                 | X       | ↑↓→ Y% | 🟢🟡🔴 |
| DAU/MAU             | X%      | ↑↓→ Y% | 🟢🟡🔴 |
| License Utilization | X%      | ↑↓→    | 🟢🟡🔴 |
| Features Adopted    | X/Y     | ↑↓→    | 🟢🟡🔴 |

---

## 🚨 Risk Factors (if any)

1. **[Issue]** - [Impact]
   - Usage data: [metric/trend]
   - Customer feedback: [theme with X mentions] - [representative quote]

## ✅ Positive Signals

1. **[What's working]** - [Evidence from usage + feedback]

---

## 👥 User Intelligence

### Champions (Leverage)

- **[User ID/Name]**: [Activity summary] - _Action: [Specific CS recommendation]_

### At Risk (Engage)

- **[User ID/Name]**: [Last active date / declining pattern] - _Action: [Check-in recommendation]_

### Inactive (>30 days)

- [Count] users ([X]% of licenses)

---

## 💡 Top Pain Points & Requests

### Pain Points

1. **[Theme]** (X mentions)
   - [Concise description]
   - Evidence: [Behavioral data] + "[Quote]" - [Source, Date]
   - _Action: [What to do]_

### Feature Requests

1. **[Theme]** (X mentions)
   - [What they want]
   - Evidence: "[Quote]" - [Source, Date]
   - _Roadmap status: [On roadmap/Not planned/Considering]_

### What They Love ❤️

1. **[Feature]**: "[Quote]"

---

## 📊 Feature Adoption

**High Usage:** [Feature] - [X users] (↑Y%)
**Declining:** [Feature] - [X users] (↓Y%) - _Investigate_
**Untapped (Upsell):** [Premium feature] - Could solve [pain point]

---

## 🎯 Recommendations

### 🔥 This Week

1. [Specific action with user/contact name]

### 📅 This Month

1. [Strategic action with context]

### 💰 Expansion Opportunities

1. [Upsell signal with evidence]

---

## 📎 Details

- **Analysis Date:** [Date]
- **Timeframe:** [Last X days]
- **Confidence:** [High/Medium/Low based on data volume]

---

## Best Practices

- **Always name users** - CS needs who to contact, not aggregates
- **Connect feedback to behavior** - Validate complaints with usage data
- **Be specific in recommendations** - "Call Sarah about Feature X" not "improve engagement"
- **Show trends, not snapshots** - Direction matters more than point-in-time
- **Flag data gaps** - Note low volume, missing properties, or incomplete data
- **Prioritize by impact** - Focus on issues affecting multiple users or champions

## Common Patterns

**Churn Risks:**

- Champion churned + declining overall usage
- Multiple complaints about same issue + behavioral evidence of friction
- License utilization declining + negative feedback

**Expansion Signals:**

- Hitting plan limits (users, API, storage)
- Requests for premium features + high engagement
- New users being added + positive feedback
