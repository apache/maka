---
name: hot-reload-optimizer
description: Optimizes hot module replacement and fast refresh for development speed with Vite, Next.js, and webpack configurations. Use when users request "hot reload", "HMR optimization", "fast refresh", "dev server speed", or "development performance".
---

# Hot Reload Optimizer

Optimize development experience with fast hot module replacement.

## Core Workflow

1. **Analyze bottlenecks**: Identify slow rebuilds
2. **Configure HMR**: Framework-specific setup
3. **Optimize bundler**: Exclude heavy dependencies
4. **Setup caching**: Persistent caching
5. **Monitor performance**: Dev server metrics
6. **Fine-tune**: Incremental improvements

## Vite Configuration

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    react({
      // Use SWC for faster transforms
      jsxRuntime: "automatic",
      // Fast Refresh options
      fastRefresh: true,
    }),
    tsconfigPaths(),
  ],

  // Optimize dependencies
  optimizeDeps: {
    // Pre-bundle these dependencies
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "zustand",
      "lodash-es",
    ],
    // Exclude from pre-bundling
    exclude: ["@vite/client"],
    // Force re-optimization
    force: false,
    // Increase timeout for slow deps
    entries: ["./src/**/*.{ts,tsx}"],
  },

  // Server configuration
  server: {
    port: 3000,
    // Enable HMR
    hmr: {
      overlay: true,
      protocol: "ws",
      host: "localhost",
    },
    // Watch options
    watch: {
      // Use polling in containers/VMs
      usePolling: false,
      // Ignore patterns
      ignored: ["**/node_modules/**", "**/.git/**"],
    },
    // Faster startup
    warmup: {
      clientFiles: ["./src/main.tsx", "./src/App.tsx"],
    },
  },

  // Build optimizations for dev
  build: {
    // Source maps for development
    sourcemap: true,
    // Chunk size warnings
    chunkSizeWarningLimit: 1000,
  },

  // Resolve configuration
  resolve: {
    alias: {
      "@": "/src",
    },
  },

  // CSS configuration
  css: {
    devSourcemap: true,
    modules: {
      localsConvention: "camelCase",
    },
  },

  // Define environment variables
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== "production"),
  },
});
```

### Vite with SWC

```typescript
// vite.config.ts with SWC
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [
    react({
      // SWC options
      jsxImportSource: "@emotion/react",
      plugins: [
        // SWC plugins
        ["@swc/plugin-emotion", {}],
      ],
    }),
  ],
});
```

## Next.js Configuration

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable SWC compiler
  swcMinify: true,

  // Experimental features for faster dev
  experimental: {
    // Turbopack (when stable)
    // turbo: {},

    // Optimize package imports
    optimizePackageImports: ["@heroicons/react", "lucide-react", "date-fns", "lodash"],
  },

  // Webpack customization
  webpack: (config, { dev, isServer }) => {
    if (dev) {
      // Faster source maps in development
      config.devtool = "eval-source-map";

      // Ignore large modules in watch
      config.watchOptions = {
        ignored: ["**/node_modules/**", "**/.git/**"],
        aggregateTimeout: 200,
        poll: false,
      };

      // Cache configuration
      config.cache = {
        type: "filesystem",
        buildDependencies: {
          config: [__filename],
        },
      };
    }

    return config;
  },

  // Disable type checking during dev (use IDE)
  typescript: {
    ignoreBuildErrors: process.env.NODE_ENV === "development",
  },

  // Disable linting during dev (use IDE)
  eslint: {
    ignoreDuringBuilds: process.env.NODE_ENV === "development",
  },

  // Image optimization
  images: {
    domains: ["example.com"],
    deviceSizes: [640, 750, 828, 1080, 1200],
  },
};

module.exports = nextConfig;
```

### Next.js Turbopack

```javascript
// next.config.js with Turbopack
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    turbo: {
      rules: {
        "*.svg": {
          loaders: ["@svgr/webpack"],
          as: "*.js",
        },
      },
      resolveAlias: {
        "@": "./src",
      },
    },
  },
};

module.exports = nextConfig;
```

```bash
# Run with Turbopack
next dev --turbo
```

## Webpack Configuration

```javascript
// webpack.config.js
const path = require("path");
const webpack = require("webpack");
const ReactRefreshPlugin = require("@pmmmwh/react-refresh-webpack-plugin");
const ForkTsCheckerWebpackPlugin = require("fork-ts-checker-webpack-plugin");

module.exports = (env, argv) => {
  const isDev = argv.mode === "development";

  return {
    mode: isDev ? "development" : "production",

    // Fast rebuild source maps
    devtool: isDev ? "eval-cheap-module-source-map" : "source-map",

    entry: "./src/index.tsx",

    output: {
      path: path.resolve(__dirname, "dist"),
      filename: isDev ? "[name].js" : "[name].[contenthash].js",
      clean: true,
    },

    // Caching for faster rebuilds
    cache: isDev
      ? {
          type: "filesystem",
          cacheDirectory: path.resolve(__dirname, ".cache"),
          buildDependencies: {
            config: [__filename],
          },
        }
      : false,

    // Module resolution
    resolve: {
      extensions: [".tsx", ".ts", ".js"],
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },

    module: {
      rules: [
        {
          test: /\.[jt]sx?$/,
          exclude: /node_modules/,
          use: {
            loader: "swc-loader",
            options: {
              jsc: {
                parser: {
                  syntax: "typescript",
                  tsx: true,
                },
                transform: {
                  react: {
                    runtime: "automatic",
                    development: isDev,
                    refresh: isDev,
                  },
                },
              },
            },
          },
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader", "postcss-loader"],
        },
      ],
    },

    plugins: [
      // React Fast Refresh
      isDev &&
        new ReactRefreshPlugin({
          overlay: {
            sockIntegration: "whm",
          },
        }),

      // TypeScript type checking in separate process
      isDev &&
        new ForkTsCheckerWebpackPlugin({
          async: true,
          typescript: {
            configFile: path.resolve(__dirname, "tsconfig.json"),
            diagnosticOptions: {
              semantic: true,
              syntactic: true,
            },
          },
        }),

      // HMR
      isDev && new webpack.HotModuleReplacementPlugin(),
    ].filter(Boolean),

    // Dev server configuration
    devServer: {
      port: 3000,
      hot: true,
      liveReload: false, // Use HMR instead
      client: {
        overlay: {
          errors: true,
          warnings: false,
        },
        progress: true,
      },
      static: {
        directory: path.join(__dirname, "public"),
      },
      historyApiFallback: true,
      compress: true,
      watchFiles: ["src/**/*"],
    },

    // Optimization
    optimization: {
      moduleIds: "deterministic",
      runtimeChunk: "single",
      splitChunks: {
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: "vendors",
            chunks: "all",
          },
        },
      },
    },

    // Performance hints
    performance: {
      hints: isDev ? false : "warning",
    },

    // Stats configuration
    stats: isDev ? "errors-warnings" : "normal",
  };
};
```

## React Fast Refresh Boundaries

```typescript
// src/components/ErrorBoundary.tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <div>Something went wrong</div>;
    }

    return this.props.children;
  }
}

// Fast Refresh will reset error boundaries automatically
```

```typescript
// src/App.tsx - Proper export for Fast Refresh
import { useState } from 'react';

// Named export works with Fast Refresh
export function App() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <h1>Count: {count}</h1>
      <button onClick={() => setCount(c => c + 1)}>Increment</button>
    </div>
  );
}

// Don't mix component and non-component exports in same file
// This breaks Fast Refresh:
// export const API_URL = 'https://api.example.com';
```

## CSS HMR Optimization

```typescript
// vite.config.ts - CSS optimization
export default defineConfig({
  css: {
    // Enable CSS source maps
    devSourcemap: true,

    // PostCSS configuration
    postcss: {
      plugins: [require("tailwindcss"), require("autoprefixer")],
    },

    // CSS Modules
    modules: {
      localsConvention: "camelCase",
      generateScopedName: "[name]__[local]___[hash:base64:5]",
    },
  },
});
```

```javascript
// tailwind.config.js - Optimize for HMR
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],

  // JIT mode is default in v3+
  // Reduces CSS generation time

  // Disable unused features
  corePlugins: {
    preflight: true,
    // Disable unused utilities
    // float: false,
    // clear: false,
  },
};
```

## Development Scripts

```json
// package.json
{
  "scripts": {
    "dev": "vite --host",
    "dev:debug": "DEBUG=vite:* vite",
    "dev:profile": "vite --profile",
    "dev:force": "vite --force",
    "analyze": "vite-bundle-analyzer",
    "typecheck": "tsc --noEmit --watch",
    "typecheck:fast": "tsc --noEmit --incremental"
  }
}
```

## Performance Monitoring

```typescript
// vite.config.ts - Plugin for performance monitoring
import { defineConfig, type Plugin } from "vite";

function hmrTimingPlugin(): Plugin {
  let startTime: number;

  return {
    name: "hmr-timing",
    handleHotUpdate({ file }) {
      startTime = performance.now();
      console.log(`[HMR] File changed: ${file}`);
      return;
    },
    transform() {
      if (startTime) {
        const duration = performance.now() - startTime;
        console.log(`[HMR] Transform took: ${duration.toFixed(2)}ms`);
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [hmrTimingPlugin()],
});
```

```typescript
// src/dev-utils.ts - Client-side HMR monitoring
if (import.meta.hot) {
  let lastUpdate = Date.now();

  import.meta.hot.on("vite:beforeUpdate", () => {
    lastUpdate = Date.now();
    console.log("[HMR] Update starting...");
  });

  import.meta.hot.on("vite:afterUpdate", () => {
    const duration = Date.now() - lastUpdate;
    console.log(`[HMR] Update complete in ${duration}ms`);
  });

  import.meta.hot.on("vite:error", (error) => {
    console.error("[HMR] Error:", error);
  });
}
```

## Docker Development

```dockerfile
# Dockerfile.dev
FROM node:20-alpine

WORKDIR /app

# Install dependencies separately for caching
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Use polling for file watching in Docker
ENV CHOKIDAR_USEPOLLING=true
ENV WATCHPACK_POLLING=true

EXPOSE 3000

CMD ["npm", "run", "dev"]
```

```yaml
# docker-compose.dev.yml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      # Mount source for HMR
      - ./src:/app/src
      - ./public:/app/public
      # Exclude node_modules
      - /app/node_modules
    ports:
      - "3000:3000"
    environment:
      - CHOKIDAR_USEPOLLING=true
      - WATCHPACK_POLLING=true
```

## Best Practices

1. **Use SWC/esbuild**: Faster than Babel
2. **Pre-bundle dependencies**: Avoid re-bundling
3. **Filesystem caching**: Persist build cache
4. **Separate type checking**: Fork process
5. **Optimize imports**: Tree-shake properly
6. **Minimize watchers**: Exclude unnecessary files
7. **Use Turbopack**: When stable in Next.js
8. **Profile regularly**: Identify bottlenecks

## Output Checklist

Every HMR optimization should include:

- [ ] Fast compiler (SWC/esbuild)
- [ ] Dependency pre-bundling
- [ ] Filesystem cache enabled
- [ ] Source maps configured
- [ ] Watch options optimized
- [ ] Type checking separated
- [ ] CSS HMR working
- [ ] Error overlay configured
- [ ] Docker polling setup
- [ ] Performance monitoring
