import { resolveSystemUiLocale, type UiLocale } from '@maka/core/ui-locale';
import { useEffect, useState } from 'react';

export function readSystemUiLocale(): UiLocale {
  if (typeof navigator === 'undefined') return 'en';
  return resolveSystemUiLocale(navigator.languages);
}

/** Keep Follow system reactive when the operating-system language changes. */
export function useSystemUiLocale(): UiLocale {
  const [locale, setLocale] = useState(readSystemUiLocale);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleLanguageChange = () => setLocale(readSystemUiLocale());
    window.addEventListener('languagechange', handleLanguageChange);
    return () => window.removeEventListener('languagechange', handleLanguageChange);
  }, []);

  return locale;
}
