import { useEffect, useState } from 'react';

/**
 * Installable app (PWA) support: the service worker in public/sw.js, and the
 * browser's install prompt, offered from our own button instead of only the
 * small icon in the address bar.
 */
export function registerServiceWorker(): void {
  // Only for the built app: in `vite dev` a service worker would get in the way of hot reload.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Not fatal: the app works the same, it just cannot be installed.
    });
  });
}

/** The `beforeinstallprompt` event (Chromium); not in the DOM typings. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** An install function while the browser offers installation, otherwise null. */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const offered = (e: Event): void => {
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    const installed = (): void => setEvent(null);
    window.addEventListener('beforeinstallprompt', offered);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', offered);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  if (event === null) return null;
  return async () => {
    await event.prompt();
    await event.userChoice;
    setEvent(null);
  };
}
