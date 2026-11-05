export function formatResetCountdown(resetsAt: string | null | undefined): string {
  // Providers omit the reset time for windows that have not started; say so rather than guess.
  if (!resetsAt) return 'time not reported';
  const target = new Date(resetsAt).getTime();
  if (isNaN(target)) return 'time not reported';
  const diffSec = Math.floor((target - Date.now()) / 1000);

  if (diffSec <= 0) return 'now';

  const d = new Date(resetsAt);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');

  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);

  if (days > 0) return `in ${days}d ${hours}h (${hh}:${mm} UTC)`;
  if (hours > 0) return `in ${hours}h ${minutes}m (${hh}:${mm} UTC)`;
  return `in ${minutes}m (${hh}:${mm} UTC)`;
}

import { useEffect, useState } from 'react';

export function formatTimeRemaining(resetsAt: string | null | undefined): string {
  if (!resetsAt) return '—';
  const target = new Date(resetsAt).getTime();
  if (isNaN(target)) return '—';
  const diffSec = Math.floor((target - Date.now()) / 1000);

  if (diffSec <= 0) return 'Reset';

  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  if (yesterday) return 'Yesterday';
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Good night,';
  if (h < 12) return 'Good morning,';
  if (h < 18) return 'Good afternoon,';
  return 'Good evening,';
}

/** English plural: plural(1, ['item', 'items', 'items']) → 'item'; any other n → forms[2] ('items'). */
export function plural(n: number, forms: [string, string, string]): string {
  return n === 1 ? forms[0] : forms[2];
}

/** Re-renders the caller every `intervalMs` so countdowns stay live. */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Upper-cases the first letter so upstream lowercase statuses match FQD's own labels. */
export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
