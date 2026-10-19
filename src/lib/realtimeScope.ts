/**
 * Egress-safe Realtime helpers.
 * - branchFilter: builds a server-side postgres_changes filter so we only
 *   receive events for the branches in scope (never the whole table).
 * - debounce: coalesces bursts (e.g. a sale touching 10 batches) into a
 *   single refetch instead of N full-list downloads.
 */
export function branchFilter(branchIds: string[], column = 'branch_id'): string | undefined {
  if (branchIds.length === 0) return undefined;
  if (branchIds.length === 1) return `${column}=eq.${branchIds[0]}`;
  // Realtime supports `in` with up to 100 values.
  return `${column}=in.(${branchIds.slice(0, 100).join(',')})`;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms = 1500) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => t && clearTimeout(t);
  return wrapped;
}
