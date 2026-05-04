export function formatChatTimestamp(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  return value.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function formatRelativeTimestamp(iso?: string | null): string {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';

  const diffSeconds = Math.round((Date.now() - value.getTime()) / 1000);
  if (diffSeconds < 5) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatAbsoluteTimestamp(iso?: string | null): string {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';

  return value.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

export function formatDetailedTimestamp(iso?: string | null): string {
  if (!iso) return 'n/a';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return 'n/a';
  return value.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function formatTaskDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt || !completedAt) return 'n/a';

  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(completed)) return 'n/a';

  const durationMs = Math.max(0, completed - started);
  if (durationMs < 1000) return `${durationMs}ms`;

  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (remainderSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainderSeconds}s`;
}
