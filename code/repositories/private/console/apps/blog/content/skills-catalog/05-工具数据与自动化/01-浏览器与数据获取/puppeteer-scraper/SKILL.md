---
name: puppeteer-scraper
description: Browser automation and web scraping via Puppeteer/Playwright. Supports page interaction, form filling, screenshots, and DOM extraction. Use this when the user needs to automate browser tasks or scrape dynamic web content.
allowed-tools:
  - Bash(npx puppeteer *)
  - Bash(npx playwright *)
---

# Chrome DevTools — Browser Automation & Scraping

Browser automation using Puppeteer/Playwright. Navigate pages, fill forms, extract data, capture screenshots.

## Usage

### Basic Page Scrape
```bash
npx puppeteer browser --url "https://example.com" --action scrape
```

### Screenshot Capture
```bash
npx puppeteer browser --url "https://example.com" --action screenshot --output page.png
```

### Form Interaction
```bash
npx puppeteer browser --url "https://example.com/search" \
  --action interact \
  --steps '[{"type": "fill", "selector": "#search", "value": "query"}, {"type": "click", "selector": "#submit"}, {"type": "wait", "ms": 2000}]'
```

## Best Practices

1. Use wait steps for SPA/JS-rendered content
2. Reuse browser context for session persistence
3. Respect robots.txt and implement rate limiting
