/**
 * useSalesInventory
 * ----------------------------------------------------------------------------
 * TanStack Query–powered cache for the Sales screen's product list and the
 * customer roster used in checkout.
 *
 * Why:
 * - The Sales screen previously refetched both lists on every mount, often
 *   running a 4-step waterfall (branch_items → medicines → branches +
 *   customers + credits + credit_logs). Switching tabs felt sluggish.
 * - Now both queries hydrate instantly from cache on revisit and revalidate
 *   in the background.
 *
 * Cache keys:
 * - ['sales-inventory', { ownerId, selectedBranch, staffBranchId }]
 * - ['sales-customers', { ownerId, selectedBranch }]
 */
import { branchFilter, debounce } from '@/lib/realtimeScope';
import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/db';
import { useAuth } from './useAuth';
import { useBranchContext } from './useBranchContext';
import { useOwnerBranchIds } from './useOwnerBranchIds';
import { getCreditLimit } from './useCreditScore';
import { resolveCreditLimit } from '@/lib/creditLimit';

export interface SalesMedicine {
  id: string; // branch_items.id
  medicine_id: string;
  name: string;
  generic_name?: string;
  selling_price: number;
  purchase_price: number;
  stock_quantity: number;
  category?: string;
  expiry_date?: string;
  units_per_pack?: number;
  open_pack_units?: number;
  unit_label?: string;
  item_type?: string;
  branch_id?: string;
  branch_name?: string;
  medicine_group?: string | null;
  strength?: string | null;
  packaging_mode?: string | null;
  main_unit_name?: string | null;
  unit_price?: number | null;
}

export interface SalesCustomer {
  id: string;
  name: string;
  phone?: string | null;
  computed_debt: number;
  credit_score: number;
  max_credit_limit: number;
}

import { chunkedInPartial } from '@/lib/supabaseBatch';

// Visible string shown when a name lookup genuinely fails after retries.
export const SALES_UNAVAILABLE = 'Unavailable';

async function fetchSalesInventory(branchIds: string[]): Promise<SalesMedicine[]> {
  if (branchIds.length === 0) return [];

  const { data: items, error } = await (supabase as any)
    .from('branch_items')
    .select('id, medicine_id, branch_id, selling_price, purchase_price, quantity, expiry_date')
    .in('branch_id', branchIds)
    .gt('quantity', 0)
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!items || items.length === 0) return [];

  const medicineIds = [...new Set(items.map((i: any) => i.medicine_id))] as string[];
  const allBranchIds = [...new Set(items.map((i: any) => i.branch_id).filter(Boolean))] as string[];
  const branchItemIds = items.map((i: any) => i.id) as string[];
  const today = new Date().toISOString().split('T')[0];

  // Chunk to 50 ids + retry. Single-shot .in() with hundreds of UUIDs
  // could be silently dropped by proxies on slow connections, causing
  // names to render as "Unknown".
  const [medsRes, branchesRes, batchesRes] = await Promise.all([
    chunkedInPartial<any>(medicineIds, (ids) =>
      (supabase as any)
        .from('medicines')
        .select('id, name, generic_name, category, item_type, unit_label, units_per_pack, medicine_group, strength, packaging_mode, main_unit_name, unit_price')
        .in('id', ids)
    , 20),
    chunkedInPartial<any>(allBranchIds, (ids) =>
      (supabase as any).from('pharmacy_branches').select('id, name').in('id', ids)
    ),
    chunkedInPartial<any>(branchItemIds, (ids) =>
      (supabase as any)
        .from('inventory_batches')
        .select('branch_item_id, remaining_quantity, expiry_date, selling_price, purchase_price, created_at')
        .in('branch_item_id', ids)
        .gt('remaining_quantity', 0)
    , 20),
  ]);

  const medMap: Record<string, any> = {};
  medsRes.data.forEach((m: any) => { medMap[m.id] = m; });
  const branchMap: Record<string, string> = {};
  branchesRes.data.forEach((b: any) => { branchMap[b.id] = b.name; });

  // Track expired-batch quantity per branch_item so we exclude it from the
  // sellable stock figure, and identify the FIFO-front fresh batch so the
  // sales card surfaces its expiry/price instead of the expired one's.
  const expiredQtyByItem: Record<string, number> = {};
  const hasAnyBatch: Record<string, boolean> = {};
  const frontBatchByItem: Record<string, any> = {};
  batchesRes.data.forEach((b: any) => {
    hasAnyBatch[b.branch_item_id] = true;
    if (b.expiry_date && b.expiry_date < today) {
      expiredQtyByItem[b.branch_item_id] = (expiredQtyByItem[b.branch_item_id] || 0) + Number(b.remaining_quantity || 0);
    } else {
      const current = frontBatchByItem[b.branch_item_id];
      const isEarlier = !current
        || (b.expiry_date && (!current.expiry_date || b.expiry_date < current.expiry_date))
        || (b.expiry_date === current.expiry_date && b.created_at < current.created_at);
      if (isEarlier) frontBatchByItem[b.branch_item_id] = b;
    }
  });

  return items
    .map((item: any) => {
      const med = medMap[item.medicine_id];
      const m = med || {};
      const hasMed = !!med;
      const rawQty = Number(item.quantity) || 0;
      const expiredQty = expiredQtyByItem[item.id] || 0;
      let sellable = Math.max(0, rawQty - expiredQty);

      // Legacy items without batches: fall back to branch_items.expiry_date.
      if (!hasAnyBatch[item.id] && item.expiry_date && item.expiry_date < today) {
        sellable = 0;
      }

      // Surface the FIFO-front fresh batch's expiry & price on the card.
      const front = frontBatchByItem[item.id];
      const displayExpiry = front ? front.expiry_date : item.expiry_date;
      const displaySellingPrice = front && front.selling_price != null ? Number(front.selling_price) : item.selling_price;
      const displayPurchasePrice = front && front.purchase_price != null ? Number(front.purchase_price) : item.purchase_price;

      return {
        id: item.id,
        medicine_id: item.medicine_id,
        name: hasMed ? m.name : SALES_UNAVAILABLE,
        generic_name: m.generic_name,
        selling_price: displaySellingPrice,
        purchase_price: displayPurchasePrice,
        stock_quantity: sellable,
        category: m.category,
        expiry_date: displayExpiry,
        units_per_pack: m.units_per_pack,
        open_pack_units: 0,
        unit_label: m.unit_label,
        item_type: m.item_type,
        branch_id: item.branch_id,
        branch_name: branchMap[item.branch_id],
        medicine_group: m.medicine_group,
        strength: m.strength,
        packaging_mode: m.packaging_mode,
        main_unit_name: m.main_unit_name,
        unit_price: m.unit_price,
      } as SalesMedicine;
    })
    .filter((m: SalesMedicine) => m.stock_quantity > 0);
}

async function fetchSalesCustomers(selectedBranch: string | null, ownerBranchIds: string[], isOwner: boolean): Promise<SalesCustomer[]> {
  if (!selectedBranch && isOwner && ownerBranchIds.length === 0) return [];

  let query = (supabase as any).from('customers').select('id, name, phone, credit_score').order('name');
  if (selectedBranch) query = query.eq('branch_id', selectedBranch);
  else if (ownerBranchIds.length > 0) query = query.in('branch_id', ownerBranchIds);

  const { data, error } = await query;
  if (error || !data || data.length === 0) return [];

  const customerIds = data.map((c: any) => c.id) as string[];
  const [creditsRes, logsRes] = await Promise.all([
    chunkedInPartial<any>(customerIds, (ids) =>
      (supabase as any).from('customer_credits').select('customer_id, total_debt').in('customer_id', ids)
    ),
    chunkedInPartial<any>(customerIds, (ids) =>
      (supabase as any).from('credit_logs').select('customer_id, new_score, created_at').in('customer_id', ids).order('created_at', { ascending: false })
    ),
  ]);

  const debtMap: Record<string, number> = {};
  for (const credit of creditsRes.data) {
    debtMap[credit.customer_id] = Math.max(0, Number(credit.total_debt) || 0);
  }
  const latestScoreMap: Record<string, number> = {};
  for (const log of logsRes.data) {
    if (!latestScoreMap[log.customer_id]) latestScoreMap[log.customer_id] = log.new_score;
  }

  return data.map((c: any) => {
    const score = latestScoreMap[c.id] ?? c.credit_score ?? 50;
    return {
      ...c,
      computed_debt: Math.max(0, debtMap[c.id] || 0),
      credit_score: score,
      max_credit_limit: resolveCreditLimit(c.max_credit_limit ?? null, score),
      max_credit_limit_raw: c.max_credit_limit ?? null,
    };
  });
}

export const SALES_INVENTORY_KEY = (scope: { ownerId?: string; selectedBranch: string | null; staffBranchId?: string | null }) =>
  ['sales-inventory', scope] as const;
export const SALES_CUSTOMERS_KEY = (scope: { ownerId?: string; selectedBranch: string | null }) =>
  ['sales-customers', scope] as const;

export function useSalesInventory() {
  const { profile } = useAuth();
  const { selectedBranch } = useBranchContext();
  const { branchIds: cachedOwnerBranchIds, isLoading: ownerBranchesLoading } = useOwnerBranchIds();
  const queryClient = useQueryClient();

  const isOwner = profile?.role === 'owner';

  // Resolve branch scope
  const branchIds = useMemo(() => {
    if (selectedBranch) return [selectedBranch];
    if (isOwner) return cachedOwnerBranchIds;
    if (profile?.branch_id) return [profile.branch_id];
    return [];
  }, [selectedBranch, isOwner, cachedOwnerBranchIds, profile?.branch_id]);

  const enabled = !!profile && (!isOwner || !ownerBranchesLoading);

  const inventoryKey = useMemo(
    () => SALES_INVENTORY_KEY({
      ownerId: isOwner ? profile?.id : undefined,
      selectedBranch,
      staffBranchId: !isOwner ? profile?.branch_id : undefined,
    }),
    [isOwner, profile?.id, profile?.branch_id, selectedBranch]
  );

  const customersKey = useMemo(
    () => SALES_CUSTOMERS_KEY({
      ownerId: isOwner ? profile?.id : undefined,
      selectedBranch,
    }),
    [isOwner, profile?.id, selectedBranch]
  );

  const inventoryQuery = useQuery({
    queryKey: inventoryKey,
    queryFn: () => fetchSalesInventory(branchIds),
    enabled,
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  const customersQuery = useQuery({
    queryKey: customersKey,
    queryFn: () => fetchSalesCustomers(selectedBranch, cachedOwnerBranchIds, isOwner),
    enabled,
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  // Pull-to-refresh + post-sale broadcast. Use refetchQueries so the active
  // list updates immediately rather than waiting for the next focus event.
  useEffect(() => {
    const handler = () => {
      queryClient.refetchQueries({ queryKey: ['sales-inventory'] });
      queryClient.refetchQueries({ queryKey: ['sales-customers'] });
      queryClient.refetchQueries({ queryKey: ['branch-inventory'] });
    };
    window.addEventListener('app:refresh', handler);
    return () => window.removeEventListener('app:refresh', handler);
  }, [queryClient]);

  // Realtime: branch-scoped (server-side filter) + debounced. Stock changes
  // (sales, batch edits, transfers) all update branch_items.quantity, so a
  // single branch_items subscription covers them without table-wide events.
  useEffect(() => {
    if (!enabled || branchIds.length === 0) return;
    const invalidate = debounce(() => {
      queryClient.refetchQueries({ queryKey: ['sales-inventory'], type: 'active' });
    }, 1500);
    const channel = (supabase as any)
      .channel(`sales-inv-${branchIds.join('-')}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'branch_items', filter: branchFilter(branchIds) }, invalidate)
      .subscribe();
    return () => { invalidate.cancel(); (supabase as any).removeChannel(channel); };
  }, [enabled, branchIds.join(','), queryClient]);

  return {
    medicines: inventoryQuery.data ?? [],
    customers: customersQuery.data ?? [],
    loading: inventoryQuery.isLoading || customersQuery.isLoading,
    isFetching: inventoryQuery.isFetching || customersQuery.isFetching,
    refetchMedicines: inventoryQuery.refetch,
    refetchCustomers: customersQuery.refetch,
    invalidate: () => {
      queryClient.refetchQueries({ queryKey: ['sales-inventory'] });
      queryClient.refetchQueries({ queryKey: ['sales-customers'] });
    },
  };
}
