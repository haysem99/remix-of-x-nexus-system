/**
 * usePackaging
 * ----------------------------------------------------------------------------
 * Fetch the medicine_packaging row for a single medicine, or batch-fetch
 * many at once. Falls back to defaultPackaging() when missing.
 *
 * Cache invalidation:
 * - Listens to the global `app:refresh` event so edits made elsewhere
 *   (e.g. EditBranchItemDialog updating selling price) propagate to the
 *   Sales screen and inventory cards that derive prices from packaging.
 * - Subscribes to realtime changes on `medicine_packaging`.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/db';
import { Packaging, defaultPackaging } from '@/lib/packaging';

// Previously every usePackaging() caller opened its own table-wide realtime
// channel (one per row rendered!). Packaging changes rarely and edits in-app
// already invalidate the cache, so we only listen to the manual refresh event,
// registered once globally.
let packagingListenerRefs = 0;
let packagingHandler: (() => void) | null = null;
function usePackagingInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (packagingListenerRefs++ === 0) {
      packagingHandler = () => {
        queryClient.invalidateQueries({ queryKey: ['medicine_packaging'] });
        queryClient.invalidateQueries({ queryKey: ['medicine_packaging_map'] });
      };
      window.addEventListener('app:refresh', packagingHandler);
    }
    return () => {
      if (--packagingListenerRefs === 0 && packagingHandler) {
        window.removeEventListener('app:refresh', packagingHandler);
        packagingHandler = null;
      }
    };
  }, [queryClient]);
}

export function usePackaging(medicineId?: string | null) {
  usePackagingInvalidation();
  const q = useQuery({
    queryKey: ['medicine_packaging', medicineId],
    queryFn: async (): Promise<Packaging | null> => {
      if (!medicineId) return null;
      const { data } = await (supabase as any)
        .from('medicine_packaging')
        .select('*')
        .eq('medicine_id', medicineId)
        .maybeSingle();
      return (data as Packaging) || null;
    },
    enabled: !!medicineId,
    staleTime: 60_000,
  });
  return { packaging: q.data ?? null, loading: q.isLoading, refetch: q.refetch };
}

export function usePackagingMap(medicineIds: string[]) {
  usePackagingInvalidation();
  const ids = [...new Set(medicineIds || [])].filter(Boolean).sort();
  const key = ids.join(',');
  return useQuery({
    queryKey: ['medicine_packaging_map', key],
    queryFn: async (): Promise<Record<string, Packaging>> => {
      if (ids.length === 0) return {};
      const batchSize = 20;
      console.log(`[Supabase batching] medicine_packaging by medicine_id: ${Math.ceil(ids.length / batchSize)} batches for ${ids.length} ids`);
      // Chunk + retry: large id lists used to be sent in a single .in() URL
      // which proxies could truncate, silently dropping packaging data.
      const { chunkedInPartial } = await import('@/lib/supabaseBatch');
      const { data } = await chunkedInPartial<any>(ids, (chunk) =>
        (supabase as any)
          .from('medicine_packaging')
          .select('*')
          .in('medicine_id', chunk)
      , batchSize);
      const map: Record<string, Packaging> = {};
      data.forEach((row: any) => { map[row.medicine_id] = row as Packaging; });
      return map;
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
}

/** Resolve an effective packaging — using a fetched row or defaults. */
export const effectivePackaging = (p?: Packaging | null): Packaging =>
  p ?? defaultPackaging();
