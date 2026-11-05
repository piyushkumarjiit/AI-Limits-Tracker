import { useEffect, useState } from 'react';

/**
 * Hash routes with query parameters, e.g. #/accounts?status=exhausted&from=overview.
 * Every drill-down filter lives in the URL, so Back works and a filtered view can be
 * bookmarked or shared.
 */
export interface Route {
  path: string;
  param?: string;
  params: URLSearchParams;
}

const REPLACED = 'fqd:route-replaced';

export function parseHash(hash = location.hash): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [p, q] = raw.split('?');
  const [path, param] = p.split('/').filter(Boolean);
  return { path: path || 'overview', param, params: new URLSearchParams(q || '') };
}

export function href(path: string, params: Record<string, string | number | undefined | null> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `#/${path === 'overview' ? '' : path}${s ? `?${s}` : ''}`;
}

/** Navigate (adds a history entry). */
export function go(path: string, params?: Record<string, string | number | undefined | null>): void {
  location.hash = href(path, params);
}

/** Change filters on the current page without piling up history entries. */
export function setParams(patch: Record<string, string | number | undefined | null>): void {
  const { path, param, params } = parseHash();
  const next: Record<string, string> = Object.fromEntries(params.entries());
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') delete next[k];
    else next[k] = String(v);
  }
  history.replaceState(null, '', href(param ? `${path}/${param}` : path, next));
  window.dispatchEvent(new Event(REPLACED));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      window.scrollTo(0, 0);
    };
    const onReplace = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    window.addEventListener(REPLACED, onReplace);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener(REPLACED, onReplace);
    };
  }, []);
  return route;
}
