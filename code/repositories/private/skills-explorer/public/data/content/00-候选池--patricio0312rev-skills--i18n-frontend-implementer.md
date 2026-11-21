---
name: i18n-frontend-implementer
description: Adds internationalization (i18n) infrastructure with translation plumbing, scalable key strategy, formatters for dates/numbers/currency, plural rules, and language switching. Use when implementing "internationalization", "translations", "multi-language support", or "i18n".
---

# i18n Frontend Implementer

Implement internationalization with next-intl, react-i18next, or similar libraries.

## Core Setup

**1. Install**: `npm install next-intl` or `react-i18next`
**2. Create dictionaries**: `locales/en.json`, `locales/es.json`
**3. Provider setup**: Wrap app with IntlProvider
**4. Translation keys**: Hierarchical namespace structure
**5. Formatters**: Date, number, currency formatting
**6. Language switcher**: Dropdown or flags UI

## Translation Structure

```json
{
  "common": { "nav": { "home": "Home", "about": "About" } },
  "auth": { "login": "Sign In", "logout": "Sign Out" },
  "errors": { "required": "{field} is required" }
}
```

## Usage Examples

```tsx
const t = useTranslations('common');
<h1>{t('nav.home')}</h1>

// With plurals
t('items', { count: 5 }) // "5 items"

// With formatting
<p>{formatDate(date, { dateStyle: 'long' })}</p>
```

## Best Practices

Use namespaces for organization, extract all text to translations, handle plurals properly, format dates/numbers per locale, provide language switcher, support RTL languages, lazy-load translations.
