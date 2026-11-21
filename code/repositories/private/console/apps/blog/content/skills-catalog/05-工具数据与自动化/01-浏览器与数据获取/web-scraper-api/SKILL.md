---
name: web-scraper-api
description: Production-grade web scraping API — structured JSON extraction from web pages with proxy support, CAPTCHA handling, and JavaScript rendering. Use this skill when the user needs reliable large-scale data extraction from websites.
allowed-tools:
  - Bash(curl *)
---

# Web Scraper API

Production web scraping API for structured data extraction. Handles proxies, CAPTCHAs, JavaScript rendering, and returns clean JSON.

## Usage

### Basic Page Extraction
```bash
curl -X POST "https://api.oxylabs.io/v1/scraper" \
  -H "Authorization: Basic $OXYLABS_AUTH" \
  -d '{
    "source": "universal",
    "url": "https://example.com/products",
    "parse": true
  }'
```

### With JavaScript Rendering
```bash
curl -X POST "https://api.oxylabs.io/v1/scraper" \
  -H "Authorization: Basic $OXYLABS_AUTH" \
  -d '{
    "source": "universal",
    "url": "https://example.com/spa-page",
    "render": "js",
    "user_agent_type": "desktop"
  }'
```

## Best Practices

1. Use `parse: true` for structured JSON output from known targets
2. Enable JS rendering for SPAs and dynamic content
3. Implement appropriate rate limiting (1-5 req/s depending on target)
4. Rotate user agents and proxies for large-scale scraping
