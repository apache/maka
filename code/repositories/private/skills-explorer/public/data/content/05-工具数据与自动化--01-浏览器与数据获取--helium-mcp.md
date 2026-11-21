---
name: helium-mcp
description: Search real-time news with bias scoring, get live stock/ETF/crypto data with AI analysis, ML options pricing, balanced news synthesis, and meme search via the Helium MCP server.
---

# Helium MCP — News, Markets & AI Intelligence

Use this skill when you need to search news, analyze media bias, get stock/crypto market data, price options, or find balanced perspectives on current events.

## Prerequisites

The Helium MCP server must be configured. Add to your MCP settings:

```json
{
  "mcpServers": {
    "helium": {
      "url": "https://heliumtrades.com/mcp"
    }
  }
}
```

Free tier: 50 queries, no signup or API key needed.

## Available Tools

### News & Bias Analysis

- **search_news** — Search 3.2M+ articles from 5,000+ sources with bias scores across 15+ dimensions (political lean, emotionality, factfulness, prescriptiveness, etc.)
- **search_balanced_news** — Get AI-synthesized balanced articles aggregating left/right/center perspectives on any topic
- **get_trending_topics** — Get currently trending news topics across all sources
- **get_source_bias** — Get detailed bias profile for any news source (e.g., CNN, Fox News, Reuters)
- **get_article_bias** — Get full multi-dimensional bias analysis for a specific article

### Market Data & Analysis

- **get_ticker** — Live stock/ETF/crypto price data with AI-generated bull/bear cases, 5 probability-weighted scenarios, and price forecasts
- **get_option_price** — ML-predicted fair value and probability ITM for any option contract
- **get_top_trading_strategies** — Top-ranked options strategies with risk/reward analysis

### Other

- **search_memes** — Semantic search across trending memes with OCR text and engagement data

## Usage Patterns

- **Compare media coverage**: Use `search_news` with a topic query, then compare bias scores across different sources
- **Get balanced views**: Use `search_balanced_news` for multi-perspective synthesis on any controversial topic
- **Stock research**: `get_ticker` for price + AI analysis + probability-weighted scenarios, then `get_option_price` for derivatives pricing
- **Discover trades**: `get_top_trading_strategies` for AI-ranked options setups with full Greeks
- **Bias audit**: `get_source_bias` to understand a source's typical framing patterns

## Notes

- All tools are read-only
- More info: https://heliumtrades.com/mcp-page/
