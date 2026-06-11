const STORAGE_KEY = 'evogent-agent-traffic';

/**
 * Coding agents browsing the app for verification must not pollute the user's
 * activity record: their dwell-views would mark items as seen (removing them
 * from carry-forward eligibility forever) and their app-opens would shrink the
 * away gap. Agents visit with ?agent=1 once; the flag persists for the browser
 * profile. Real users never set this.
 */
export function isAgentBrowsing(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).has('agent')) {
      window.localStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
