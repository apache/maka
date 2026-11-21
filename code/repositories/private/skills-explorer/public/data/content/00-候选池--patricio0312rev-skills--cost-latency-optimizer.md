---
name: cost-latency-optimizer
description: Reduces LLM costs and improves response times through caching, model selection, batching, and prompt optimization. Provides cost breakdowns, latency hotspots, and configuration recommendations. Use for "cost reduction", "performance optimization", "latency improvement", or "efficiency".
---

# Cost & Latency Optimizer

Optimize LLM applications for cost and performance.

## Cost Breakdown Analysis

```python
class CostAnalyzer:
    def __init__(self):
        self.costs = {
            "llm_calls": 0,
            "embeddings": 0,
            "tool_calls": 0,
        }
        self.counts = {
            "llm_calls": 0,
            "embeddings": 0,
        }

    def track_llm_call(self, tokens_in: int, tokens_out: int):
        # GPT-4 pricing
        cost = (tokens_in / 1000) * 0.03 + (tokens_out / 1000) * 0.06
        self.costs["llm_calls"] += cost
        self.counts["llm_calls"] += 1

    def report(self):
        return {
            "total_cost": sum(self.costs.values()),
            "breakdown": self.costs,
            "avg_cost_per_call": self.costs["llm_calls"] / self.counts["llm_calls"],
        }
```

## Caching Strategy

```python
import hashlib
from functools import lru_cache

class LLMCache:
    def __init__(self, redis_client):
        self.cache = redis_client
        self.ttl = 3600  # 1 hour

    def get_cache_key(self, prompt: str, model: str) -> str:
        content = f"{model}:{prompt}"
        return f"llm_cache:{hashlib.sha256(content.encode()).hexdigest()}"

    def get(self, prompt: str, model: str):
        key = self.get_cache_key(prompt, model)
        return self.cache.get(key)

    def set(self, prompt: str, model: str, response: str):
        key = self.get_cache_key(prompt, model)
        self.cache.setex(key, self.ttl, response)

# Usage
cache = LLMCache(redis_client)

def cached_llm_call(prompt: str, model: str = "gpt-4"):
    # Check cache
    cached = cache.get(prompt, model)
    if cached:
        return cached

    # Call LLM
    response = llm(prompt, model=model)

    # Cache result
    cache.set(prompt, model, response)

    return response
```

## Model Selection

```python
MODEL_PRICING = {
    "gpt-4": {"input": 0.03, "output": 0.06},
    "gpt-3.5-turbo": {"input": 0.0005, "output": 0.0015},
    "claude-3-opus": {"input": 0.015, "output": 0.075},
    "claude-3-sonnet": {"input": 0.003, "output": 0.015},
}

def select_model_by_complexity(query: str) -> str:
    """Use cheaper models for simple queries"""
    # Classify complexity
    complexity = classify_complexity(query)

    if complexity == "simple":
        return "gpt-3.5-turbo"  # 60x cheaper
    elif complexity == "medium":
        return "claude-3-sonnet"
    else:
        return "gpt-4"

def classify_complexity(query: str) -> str:
    # Simple heuristics
    if len(query) < 100 and "?" in query:
        return "simple"
    elif any(word in query.lower() for word in ["analyze", "complex", "detailed"]):
        return "complex"
    return "medium"
```

## Prompt Optimization

```python
def optimize_prompt(prompt: str) -> str:
    """Reduce token count while preserving meaning"""
    optimizations = [
        # Remove extra whitespace
        lambda p: re.sub(r'\s+', ' ', p),

        # Remove examples if not critical
        lambda p: p.split("Examples:")[0] if "Examples:" in p else p,

        # Use abbreviations
        lambda p: p.replace("For example", "E.g."),
    ]

    for optimize in optimizations:
        prompt = optimize(prompt)

    return prompt.strip()

# Example: 500 tokens → 350 tokens = 30% cost reduction
```

## Batching

```python
async def batch_llm_calls(prompts: List[str], batch_size: int = 5):
    """Process multiple prompts in parallel"""
    results = []

    for i in range(0, len(prompts), batch_size):
        batch = prompts[i:i + batch_size]

        # Parallel execution
        batch_results = await asyncio.gather(*[
            llm_async(prompt) for prompt in batch
        ])

        results.extend(batch_results)

    return results

# 10 sequential calls: ~30 seconds
# 10 batched calls (5 parallel): ~6 seconds
```

## Latency Hotspot Analysis

```python
import time

class LatencyTracker:
    def __init__(self):
        self.timings = {}

    def track(self, operation: str):
        def decorator(func):
            def wrapper(*args, **kwargs):
                start = time.time()
                result = func(*args, **kwargs)
                duration = time.time() - start

                if operation not in self.timings:
                    self.timings[operation] = []
                self.timings[operation].append(duration)

                return result
            return wrapper
        return decorator

    def report(self):
        return {
            op: {
                "count": len(times),
                "total": sum(times),
                "avg": sum(times) / len(times),
                "p95": sorted(times)[int(len(times) * 0.95)]
            }
            for op, times in self.timings.items()
        }

# Usage
tracker = LatencyTracker()

@tracker.track("llm_call")
def call_llm(prompt):
    return llm(prompt)

# After 100 calls
print(tracker.report())
# {"llm_call": {"avg": 2.3, "p95": 4.1, ...}}
```

## Optimization Recommendations

```python
def generate_recommendations(cost_analysis, latency_analysis):
    recs = []

    # High LLM costs
    if cost_analysis["costs"]["llm_calls"] > 10:
        recs.append({
            "issue": "High LLM costs",
            "recommendation": "Implement caching for repeated queries",
            "impact": "50-80% cost reduction",
        })

        if cost_analysis["avg_cost_per_call"] > 0.01:
            recs.append({
                "issue": "Using expensive model for all queries",
                "recommendation": "Use gpt-3.5-turbo for simple queries",
                "impact": "60% cost reduction",
            })

    # High latency
    if latency_analysis["llm_call"]["avg"] > 3:
        recs.append({
            "issue": "High LLM latency",
            "recommendation": "Batch parallel calls, use streaming",
            "impact": "50% latency reduction",
        })

    return recs
```

## Streaming for Faster TTFB

```python
async def streaming_llm(prompt: str):
    """Stream tokens as they're generated"""
    async for chunk in llm_stream(prompt):
        yield chunk
        # User sees partial response immediately

# Time to First Byte: ~200ms (streaming) vs ~2s (waiting for full response)
```

## Best Practices

1. **Cache aggressively**: Identical queries cached
2. **Model selection**: Use cheaper models when possible
3. **Prompt optimization**: Reduce unnecessary tokens
4. **Batching**: Parallel execution for throughput
5. **Streaming**: Faster perceived latency
6. **Monitor costs**: Track per-user, per-feature
7. **Set budgets**: Alert on anomalies

## Output Checklist

- [ ] Cost tracking implementation
- [ ] Caching layer
- [ ] Model selection logic
- [ ] Prompt optimization
- [ ] Batching for parallel calls
- [ ] Latency tracking
- [ ] Hotspot analysis
- [ ] Optimization recommendations
- [ ] Budget alerts
- [ ] Performance dashboard
