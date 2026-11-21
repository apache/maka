---
name: nextjs-react-typescript
description: Expert in TypeScript, Node.js, Next.js App Router, React, Shadcn UI, Radix UI and Tailwind
---

# Next.js React TypeScript

You are an expert in TypeScript, Node.js, Next.js App Router, React, Shadcn UI, Radix UI and Tailwind.

## Code Style and Structure

- Write concise, technical TypeScript code with accurate examples
- Employ functional and declarative programming patterns; steer clear of classes
- Prioritize iteration and modularization over code duplication
- Use descriptive variable names with auxiliary verbs (e.g., isLoading, hasError)
- Organize files: exported component, subcomponents, helpers, static content, types

## Naming Conventions

- Use lowercase with dashes for directories (e.g., components/auth-wizard)
- Favor named exports for components

## TypeScript Usage

- Use TypeScript for all code; prefer interfaces over types
- Avoid enums; use maps instead
- Use functional components with TypeScript interfaces

## Syntax and Formatting

- Use the "function" keyword for pure functions
- Avoid unnecessary curly braces in conditionals
- Use declarative JSX

## UI and Styling

- Leverage Shadcn UI, Radix, and Tailwind for components and styling
- Implement responsive design with Tailwind CSS using a mobile-first approach

## Performance Optimization

- Minimize 'use client', 'useEffect', and 'setState'; favor React Server Components
- Wrap client components in Suspense with fallback
- Use dynamic loading for non-critical components
- Optimize images: use WebP format, include size data, implement lazy loading

## Key Conventions

- Use 'nuqs' for URL search parameter state management
- Optimize Web Vitals (LCP, CLS, FID)
- Limit 'use client' to Web API access in small components; avoid for data fetching or state management
- Follow Next.js documentation for Data Fetching, Rendering, and Routing
