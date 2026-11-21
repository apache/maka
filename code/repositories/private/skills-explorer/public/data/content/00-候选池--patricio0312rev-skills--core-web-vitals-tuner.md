---
name: core-web-vitals-tuner
description: Systematically improves Largest Contentful Paint (LCP), Interaction to Next Paint (INP), and Cumulative Layout Shift (CLS) with prioritized fixes and verification. Use for "Core Web Vitals", "performance", "LCP", "INP", or "CLS".
---

# Core Web Vitals Tuner

Improve LCP, INP, and CLS systematically.

## LCP Optimization (<2.5s)

**Prioritized Fixes:**

1. **Optimize images** (Biggest impact)

   ```html
   <!-- Before -->
   <img src="hero.jpg" />

   <!-- After -->
   <img
     src="hero.jpg"
     srcset="hero-400.webp 400w, hero-800.webp 800w, hero-1200.webp 1200w"
     sizes="(max-width: 600px) 400px, (max-width: 1200px) 800px, 1200px"
     loading="eager"
     fetchpriority="high"
   />
   ```

2. **Preload LCP resource**

   ```html
   <link rel="preload" as="image" href="/hero.webp" fetchpriority="high" />
   ```

3. **Inline critical CSS**

   ```html
   <style>
     /* Above-the-fold styles */
     .hero {
       display: flex;
       height: 100vh;
     }
   </style>
   ```

4. **Use CDN**
   - Serve images from CloudFront/Cloudflare
   - Enable HTTP/2 or HTTP/3

## INP Optimization (<200ms)

**Fixes:**

1. **Debounce expensive interactions**

   ```typescript
   import { debounce } from "lodash";

   const handleSearch = debounce((query) => {
     fetchResults(query);
   }, 300);
   ```

2. **Use Web Workers for heavy tasks**

   ```typescript
   const worker = new Worker("processor.js");
   worker.postMessage(largeData);
   worker.onmessage = (e) => console.log(e.data);
   ```

3. **Code splitting**
   ```typescript
   const HeavyComponent = lazy(() => import("./HeavyComponent"));
   ```

## CLS Optimization (<0.1)

**Fixes:**

1. **Reserve space for images/ads**

   ```html
   <img src="banner.jpg" width="1200" height="600" />
   ```

2. **Use CSS aspect-ratio**

   ```css
   .video-container {
     aspect-ratio: 16 / 9;
   }
   ```

3. **Avoid injecting content above existing**
   ```css
   .notification {
     position: fixed;
     top: 0;
   }
   ```

## Verification

```bash
# Lighthouse CI
npm run lighthouse -- --url=https://example.com

# Web Vitals in production
import { getCLS, getFID, getLCP } from 'web-vitals';

getCLS(console.log);
getFID(console.log);
getLCP(console.log);
```

## Output Checklist

- [ ] LCP optimized (<2.5s)
- [ ] INP optimized (<200ms)
- [ ] CLS optimized (<0.1)
- [ ] Monitoring in place
- [ ] Performance regression tests
      ENDFILE
