/**
 * useBranchInventory
 * ----------------------------------------------------------------------------
 * TanStack Query–powered fetch + cache for the staff/owner inventory list.
 *
 * Performance:
 * - Primary query loads branch_items + medicines + branch names and renders
 *   the list immediately.
 * - Active ingredients (potentially many rows, only used for search/display
 *   in pharmacy mode) are fetched in a background query and merged in via
 *   useMemo so the list never blocks on them.
 *
 * Cache key: ['branch-inventory', { ownerId, selectedBranch, staffBranchId }]
 * Stale time: 60s.
 */
import { branchFilter, debounce } from '@/lib/realtimeScope';
import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/db';
import { useAuth } from './useAuth';
import { useBranchContext } from './useBranchContext';
import { useOwnerBranchIds } from './useOwnerBranchIds';
import type { BranchItem } from '@/components/inventory/EditBranchItemDialog';
import type { Packaging } from '@/lib/packaging';
import { chunkedIn, chunkedInPartial } from '@/lib/supabaseBatch';

export type EnrichedBranchItem = BranchItem & {
  branch_name?: string;
  medicine_group?: string | null;
  strength?: string | null;
  active_ingredients?: Array<{ ingredient_name: string; strength: string | null }>;
  packaging_mode?: string | null;
  main_unit_name?: string | null;
  unit_price?: number | null;
  packaging?: Packaging | null;
};

// Visible string shown when the medicine name fetch genuinely fails after
// retries — distinguishes a connection issue from valid data.
export const UNAVAILABLE = 'Unavailable';

// Cache of branch-name lookups, shared across page fetches in one session.
async function enrichItems(
  rawItems: any[],
): Promise<EnrichedBranchItem[]> {
  if (rawItems.length === 0) return [];
  const medicineIds = [...new Set(rawItems.map((i) => i.medicine_id))];
  const allBranchIds = [...new Set(rawItems.map((i) => i.branch_id))];

  // Chunked + retried fetches (chunks of 50, 3 attempts w/ exponential backoff)
  // so large id lists don't blow past URL/proxy limits on slow connections.
  const [medRes, branchRes, packRes] = await Promise.all([
    chunkedInPartial<any>(medicineIds, (ids) =>
      supabase
        .from('medicines')
        .select('id, name, generic_name, category, manufacturer, batch_number, item_type, unit_label, units_per_pack, strips_per_pack, units_per_strip, medicine_group, strength, packaging_mode, main_unit_name, unit_price, minimum_stock_level, medicine_code_id')
        .in('id', ids)
    , 20),
    chunkedInPartial<any>(allBranchIds, (ids) =>
      supabase.from('pharmacy_branches').select('id, name').in('id', ids)
    ),
    chunkedInPartial<any>(medicineIds, (ids) =>
      (supabase as any).from('medicine_packaging').select('*').in('medicine_id', ids)
    , 20),
  ]);

  const medMap: Record<string, any> = {};
  medRes.data.forEach((m: any) => { medMap[m.id] = m; });
  const branchMap: Record<string, string> = {};
  branchRes.data.forEach((b: any) => { branchMap[b.id] = b.name; });
  const packMap: Record<string, Packaging> = {};
  packRes.data.forEach((p: any) => { packMap[p.medicine_id] = p as Packaging; });

  return rawItems.map((item) => {
    const med = medMap[item.medicine_id];
    const m = med || {};
    const nameMissing = !med;
    return {
      ...item,
      // If medicines fetch failed OR this specific row didn't come back, mark
      // as UNAVAILABLE so UI distinguishes loading/missing from valid data.
      name: nameMissing ? (medRes.failed ? UNAVAILABLE : UNAVAILABLE) : m.name,
      generic_name: m.generic_name,
      category: nameMissing ? (medRes.failed ? UNAVAILABLE : 'Uncategorized') : (m.category || 'Uncategorized'),
      manufacturer: m.manufacturer,
      batch_number: m.batch_number,
      item_type: m.item_type,
      unit_label: m.unit_label,
      units_per_pack: m.units_per_pack,
      strips_per_pack: m.strips_per_pack,
      units_per_strip: m.units_per_strip,
      medicine_group: m.medicine_group,
      strength: m.strength,
      packaging_mode: m.packaging_mode,
      main_unit_name: m.main_unit_name,
      unit_price: m.unit_price,
      minimum_stock_level: m.minimum_stock_level,
      medicine_code_id: m.medicine_code_id ?? null,
      packaging: packMap[item.medicine_id] ?? null,
      active_ingredients: [],
      branch_name: branchMap[item.branch_id],
    } as EnrichedBranchItem;
  });
}

const FIRST_PAGE_SIZE = 24;
const NEXT_PAGE_SIZE = 200;

/**
 * Progressive fetch: returns the first page quickly, then keeps loading
 * subsequent pages in the background and appending them to the cache via
 * the supplied `appendToCache` callback. Resolves once all pages are loaded.
 */
async function fetchBranchInventoryProgressive(
  branchIds: string[],
  appendToCache: (rows: EnrichedBranchItem[]) => void,
): Promise<EnrichedBranchItem[]> {
  if (branchIds.length === 0) return [];

  // Page 1 — render-critical.
  const { data: firstRaw, error: firstErr } = await supabase
    .from('branch_items')
    .select('id, medicine_id, branch_id, owner_id, selling_price, purchase_price, quantity, expiry_date')
    .in('branch_id', branchIds)
    .order('created_at', { ascending: false })
    .range(0, FIRST_PAGE_SIZE - 1);
  if (firstErr) throw firstErr;
  if (!firstRaw || firstRaw.length === 0) return [];

  const firstEnriched = await enrichItems(firstRaw);
  appendToCache(firstEnriched);

  // If first page wasn't full, we're done.
  if (firstRaw.length < FIRST_PAGE_SIZE) return firstEnriched;

  // Background pages — sequential to keep request load reasonable.
  const all: EnrichedBranchItem[] = [...firstEnriched];
  let offset = FIRST_PAGE_SIZE;
  while (true) {
    const { data: pageRaw, error } = await supabase
      .from('branch_items')
      .select('id, medicine_id, branch_id, owner_id, selling_price, purchase_price, quantity, expiry_date')
      .in('branch_id', branchIds)
      .order('created_at', { ascending: false })
      .range(offset, offset + NEXT_PAGE_SIZE - 1);
    if (error) throw error;
    if (!pageRaw || pageRaw.length === 0) break;
    const enriched = await enrichItems(pageRaw);
    all.push(...enriched);
    appendToCache(enriched);
    if (pageRaw.length < NEXT_PAGE_SIZE) break;
    offset += NEXT_PAGE_SIZE;
  }
  return all;
}


async function fetchActiveIngredients(medicineIds: string[]) {
  if (medicineIds.length === 0) return {} as Record<string, Array<{ ingredient_name: string; strength: string | null }>>;
  const { data } = await chunkedInPartial<any>(medicineIds, (ids) =>
    (supabase as any)
      .from('medicine_active_ingredients')
      .select('medicine_id, ingredient_name, strength, sort_order')
      .in('medicine_id', ids)
      .order('sort_order')
  );
  const ingMap: Record<string, Array<{ ingredient_name: string; strength: string | null }>> = {};
  data.forEach((i: any) => {
    if (!ingMap[i.medicine_id]) ingMap[i.medicine_id] = [];
    ingMap[i.medicine_id].push({ ingredient_name: i.ingredient_name, strength: i.strength });
  });
  return ingMap;
}

export const BRANCH_INVENTORY_KEY = (scope: { ownerId?: string; selectedBranch?: string | null; staffBranchId?: string | null }) =>
  ['branch-inventory', scope] as const;

export function useBranchInventory() {
  const { profile } = useAuth();
  const { selectedBranch } = useBranchContext();
  const { branchIds: cachedOwnerBranchIds, isLoading: ownerBranchesLoading } = useOwnerBranchIds();
  const queryClient = useQueryClient();

  let branchIds: string[] = [];
  if (selectedBranch) {
    branchIds = [selectedBranch];
  } else if (profile?.role === 'owner') {
    branchIds = cachedOwnerBranchIds;
  } else if (profile?.branch_id) {
    branchIds = [profile.branch_id];
  }

  const enabled = !!profile && (profile.role !== 'owner' || !ownerBranchesLoading);

  const queryKey = BRANCH_INVENTORY_KEY({
    ownerId: profile?.role === 'owner' ? profile.id : undefined,
    selectedBranch,
    staffBranchId: profile?.role !== 'owner' ? profile?.branch_id : undefined,
  });

  const query = useQuery({
    queryKey,
    queryFn: () => fetchBranchInventoryProgressive(branchIds, (rows) => {
      // Append each page to the cache so the UI re-renders progressively.
      queryClient.setQueryData<EnrichedBranchItem[]>(queryKey, (prev) => {
        if (!prev || prev.length === 0) return rows;
        const seen = new Set(prev.map((p) => p.id));
        const fresh = rows.filter((r) => !seen.has(r.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
    }),
    enabled,
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  // Background ingredients fetch — does not block list rendering.
  const medicineIds = useMemo(
    () => [...new Set((query.data ?? []).map((i) => (i as any).medicine_id))] as string[],
    [query.data]
  );

  const ingredientsQuery = useQuery({
    queryKey: ['branch-inventory-ingredients', medicineIds.length, medicineIds.slice(0, 5).join(',')],
    queryFn: () => fetchActiveIngredients(medicineIds),
    enabled: enabled && medicineIds.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  const items = useMemo(() => {
    const base = query.data ?? [];
    const ingMap = ingredientsQuery.data;
    if (!ingMap) return base;
    return base.map((it) => ({
      ...it,
      active_ingredients: ingMap[(it as any).medicine_id] || [],
    }));
  }, [query.data, ingredientsQuery.data]);

  useEffect(() => {
    const handler = () => queryClient.refetchQueries({ queryKey: ['branch-inventory'] });
    window.addEventListener('app:refresh', handler);
    return () => window.removeEventListener('app:refresh', handler);
  }, [queryClient]);

  // Realtime: patch changed rows in place instead of re-downloading the
  // whole inventory. Only INSERT/DELETE (rare) trigger a debounced refetch.
  useEffect(() => {
    if (!enabled || branchIds.length === 0) return;
    const refetchAll = debounce(() => {
      queryClient.refetchQueries({ queryKey: ['branch-inventory'], type: 'active' });
    }, 2000);
    const onChange = (payload: any) => {
      if (payload.eventType === 'UPDATE' && payload.new?.id) {
        const n = payload.new;
        queryClient.setQueriesData<EnrichedBranchItem[]>({ queryKey: ['branch-inventory'] }, (prev) =>
          prev?.map((it) => it.id === n.id
            ? { ...it, quantity: n.quantity, selling_price: n.selling_price, purchase_price: n.purchase_price, expiry_date: n.expiry_date }
            : it)
        );
        return;
      }
      refetchAll();
    };
    const channel = (supabase as any)
      .channel(`branch-inv-${branchIds.join('-')}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'branch_items', filter: branchFilter(branchIds) }, onChange)
      .subscribe();
    return () => { refetchAll.cancel(); (supabase as any).removeChannel(channel); };
  }, [enabled, branchIds.join(','), queryClient]);

  return {
    items,
    loading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
    removeItemFromCache: (id: string) => {
      queryClient.setQueryData<EnrichedBranchItem[]>(queryKey, (prev) =>
        (prev ?? []).filter((i) => i.id !== id)
      );
    },
    invalidate: () => queryClient.invalidateQueries({ queryKey: ['branch-inventory'] }),
  };
}
