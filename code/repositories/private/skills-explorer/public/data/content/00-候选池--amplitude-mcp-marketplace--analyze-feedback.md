---
name: analyze-feedback
description: Synthesizes customer feedback into actionable themes including feature requests, bugs, pain points, and praise. Use when planning product roadmap, understanding user sentiment, investigating specific issues, or preparing voice-of-customer reports.
---

# Analyze Feedback

Perform comprehensive feedback reviews, investigate specific feature requests, understand customer sentiment, then prepare concise but actionable voice-of-customer presentations

## Instructions

### Step 1: Understand Available Sources

Use `Amplitude:use_amplitude_ai_feedback` with `facet: "sources"` to see which feedback channels are connected (surveys, support, app reviews, etc.).

### Step 2: Get Themed Insights

Use `Amplitude:use_amplitude_ai_feedback` with `facet: "insights"` and appropriate filters:

- Filter by types: `request`, `complaint`, `lovedFeature`, `bug`, `painPoint`
- Filter by date range for recent feedback
- Filter by source for channel-specific analysis

### Step 3: Drill Into Specific Themes

For top insights, use `Amplitude:use_amplitude_ai_feedback` with `facet: "mentions"` to see the actual user feedback driving each theme.

### Step 4: Connect to User Segments

Use `Amplitude:use_amplitude_cohorts` with `action: "list"` to understand if feedback themes correlate with:

- User tenure (new vs. established)
- Plan type (free vs. paid)
- Usage level (power users vs. casual)

### Step 5: Present Findings

Structure as:

1. **Summary**: Concise one-liner explaining the number of feedback sources and mentions analyzed along with the key takeaways from the analysis.
2. **Urgent Issues 🚩**: Top bugs, issues, or pain-points noted by customers. Share 3-4 themes here unless prompted otherwise.
3. **Top Feature Requests 💡**: Top feature requests noted by customers. Share 3-4 themes here unless prompted otherwise.
4. **Praises ❤️**: Top praises or loved features noted by customers. Share 1-2 themes here unless prompted otherwise.
5. **Sentiment Analysis**: Share a very concise overview of the themes, sentiment on a scale from 1-5 (5 being highest), and snippets of evidence.
6. **Prioritized Recommendations**: Very concise section recapping the top 3-7 specific actionable recommendations (unless prompted otherwise) to follow-up on. Inlcude [p0],[p1],[p2],[p3] in front of each title to help size priority with p0 being most urgent and p3 being least.

## Best Practices

- Be comprehensive in your investigation and analysis but concise and actionable in your response.
- Do not repeat duplicate sections or the same takeaway multiple times.
- Include 1-2 representative quotes for each theme. Prioritize the best quotes that explains the theme. Include when it was received and what source it came from. If the quote is long, only quote the relevant section tied to the theme.
- When describing a theme, include the mention volumes, key sources, and recency in a concise manner.
- Each theme should have consistent formatting like:
  Concise But Descriptive Theme Name (X mentions)
  Actionable one-line description or multiple concise bullet-points explaining what the specific issue or request or praise is, what time period the feedback was relevant for, and key sources the theme came from
  - "Customer quote backing the theme" - Source name (Received date)
  - "Customer quote backing the theme" - Source name (Received date)
- For the Prioritized Recommendations section, each recommendation should just be 1 concise but actionable bullet-point instead of a long theme overview.
- Do not recap what you did at the very end and just end after the concise prioritized recommendations.
- Connect feedback to behavioral data when possible.
