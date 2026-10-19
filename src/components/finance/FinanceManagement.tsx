import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DollarSign, TrendingUp, TrendingDown, BarChart3, Plus, CalendarIcon, ArrowLeft, ChevronRight, Package, Receipt, Download } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import { format } from 'date-fns';
import { supabase } from '@/lib/db';
import { addisDayString, addisPeriodStartDay } from '@/lib/timezone';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useBranchContext } from '@/hooks/useBranchContext';
import { useAdvancedMode } from '@/hooks/useAdvancedMode';
import { useReadOnly } from '@/hooks/useReadOnly';

import DebtManagement from './DebtManagement';
import SalaryHistory from '@/components/staff/SalaryHistory';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { Packaging } from '@/lib/packaging';

type SaleLevel = 'unit' | 'strip' | 'pack';

const approxEq = (a: number, b: number) => Math.abs(a - b) < 0.01;

function inferSaleLevel(si: any, pkg?: Packaging | null): SaleLevel {
  // 1) Explicit level (forward-compat if DB ever stores it).
  const st = si?.sale_type;
  if (st === 'unit' || st === 'strip' || st === 'pack') return st;
  // 2) Legacy markers encode the level via strip_quantity / pack_quantity.
  const stripQty = Number(si?.strip_quantity || 0);
  const packQty = Number(si?.pack_quantity || 0);
  if (st === 'by_stripe') {
    if (stripQty > 0) return 'strip';
    return 'unit';
  }
  if (st === 'full_pack') {
    if (packQty > 0) return 'pack';
  }
  // 3) Heuristic fallback: match unit_price against per-level prices.
  const price = Number(si?.unit_price || 0);
  if (pkg && price > 0) {
    const ups = Number(pkg.units_per_strip || 0);
    const spp = Number(pkg.strips_per_pack || 0);
    const lpi = Number(pkg.unit_selling_price || 0);
    const unitP = lpi;
    const stripP = Number(pkg.strip_selling_price || 0) || (lpi && ups ? lpi * ups : 0);
    const packP = Number(pkg.pack_selling_price || 0) || (lpi && ups && spp ? lpi * ups * spp : 0);
    const candidates: Array<[SaleLevel, number]> = [];
    if (unitP > 0) candidates.push(['unit', unitP]);
    if (pkg.strip_enabled && stripP > 0) candidates.push(['strip', stripP]);
    if (pkg.pack_enabled && pkg.strip_enabled && packP > 0) candidates.push(['pack', packP]);
    let best: SaleLevel = 'unit';
    let bestDiff = Infinity;
    for (const [lv, p] of candidates) {
      const d = Math.abs(price - p);
      if (d < bestDiff) { bestDiff = d; best = lv; }
    }
    if (bestDiff < 0.01) return best;
  }
  return st === 'full_pack' ? 'pack' : 'unit';
}

interface SaleItemFormatted {
  qty: number;
  level: SaleLevel;
  levelLabel: string;
  baseUnits: number;
  baseLabel: string;
}

function formatSaleItem(si: any, pkg?: Packaging | null): SaleItemFormatted {
  const level = inferSaleLevel(si, pkg);
  let qty: number;
  if (si?.sale_type === 'by_stripe') {
    const raw = Number(si?.stripes_sold || si?.quantity || 0);
    qty = raw >= 100 ? raw / 1000 : raw;
  } else {
    qty = Number(si?.quantity || 0);
  }
  const unitName = pkg?.unit_name || si?.medicines?.unit_label || 'tablet';
  const stripName = pkg?.strip_name || 'strip';
  const packName = pkg?.pack_name || 'pack';
  const ups = Number(pkg?.units_per_strip || 0);
  const spp = Number(pkg?.strips_per_pack || 0);
  const unitsPerPack = (ups && spp) ? ups * spp : Number(si?.medicines?.units_per_pack || 1);
  const baseUnits =
    level === 'unit' ? qty :
    level === 'strip' ? qty * (ups || 1) :
    qty * (unitsPerPack || 1);
  const levelLabel = level === 'unit' ? unitName : level === 'strip' ? stripName : packName;
  return { qty, level, levelLabel, baseUnits, baseLabel: unitName };
}

const pluralLabel = (label: string, n: number) => {
  const safe = (label || 'unit').trim() || 'unit';
  if (Math.abs(n - 1) < 1e-9) return safe;
  if (/(s|x|z|ch|sh)$/i.test(safe)) return `${safe}es`;
  return `${safe}s`;
};

interface FinanceStats {
  totalIncome: number;         // salesRevenue + extraProfit (net-of-discount revenue actually received)
  totalExpenses: number;       // operating expenses ONLY (excludes COGS / inventory purchases)
  netProfit: number;           // totalIncome - totalExpenses (does NOT subtract COGS)
  profitMargin: number;
  salesRevenue: number;        // sum(total_amount) — already net of discount
  extraProfit: number;         // tips / kept-change overpayments
  discounts: number;           // sum(discount_amount) — informational
  cogs: number;                // cost of goods sold
  grossProfit: number;         // totalIncome - cogs
}


interface Expense {
  id: string;
  description: string;
  amount: number;
  category: string;
  created_at: string;
}

interface Sale {
  id: string;
  total_amount: number;
  discount_amount?: number;
  created_at: string;
  sold_by?: string;
  seller?: {
    full_name: string;
    role: string;
  };
  sale_items?: {
    medicine_id?: string;
    medicines: {
      id?: string;
      name: string;
      unit_label?: string;
      units_per_pack?: number;
    };
    quantity: number;
    unit_price?: number;
    total_price?: number;
    sale_type?: string;
    stripes_sold?: number;
  }[];
}

interface BranchData {
  branchId: string;
  branchName: string;
  income: number;
  expenses: number;
}

interface Branch {
  id: string;
  name: string;
}

interface ItemSummary {
  name: string;
  totalIncome: number;
  unitLabel?: string;
  unitsPerPack?: number;
  perLevel: { unit: number; strip: number; pack: number };
  stripName?: string;
  packName?: string;
}

interface InventoryExpense {
  id: string;
  name: string;
  stock_quantity: number;
  purchase_price: number;
  total_cost: number;
  branch_name?: string;
  created_at: string;
}

export default function FinanceManagement() {
  const [stats, setStats] = useState<FinanceStats>({
    totalIncome: 0,
    totalExpenses: 0,
    netProfit: 0,
    profitMargin: 0,
    salesRevenue: 0,
    extraProfit: 0,
    discounts: 0,
    cogs: 0,
    grossProfit: 0,
  });
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [paginatedSales, setPaginatedSales] = useState<Sale[]>([]);
  const [paginatedExpenses, setPaginatedExpenses] = useState<Expense[]>([]);
  const [salesPage, setSalesPage] = useState(1);
  const [expensesPage, setExpensesPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [period, setPeriod] = useState('daily');
  const [startDate, setStartDate] = useState<Date>();
  const [endDate, setEndDate] = useState<Date>();
  const [branchData, setBranchData] = useState<BranchData[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [expenseBranchId, setExpenseBranchId] = useState<string>('');
  const [inventoryExpenses, setInventoryExpenses] = useState<InventoryExpense[]>([]);
  const [expenseSubTab, setExpenseSubTab] = useState<'inventory' | 'custom'>('inventory');
  
  // Income drill-down state
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [packagingMap, setPackagingMap] = useState<Record<string, Packaging>>({});
  
  const { profile } = useAuth();
  const { toast } = useToast();
  const { selectedBranch } = useBranchContext();
  const { isAdvancedMode } = useAdvancedMode();
  const readOnly = useReadOnly();
  const [showFinanceDetails, setShowFinanceDetails] = useState(false);
  
  const itemsPerPage = 15;

  useEffect(() => {
    fetchFinanceData();
  }, [period, startDate, endDate, selectedBranch]);

  // Branches list rarely changes — fetch once, not on every filter change.
  // Table-wide `expenses` realtime removed: any owner's expense used to
  // re-download all finance data for everyone. Local writes call
  // fetchFinanceData() directly; pull-to-refresh covers the rest.
  useEffect(() => {
    fetchBranches();
  }, []);
  useEffect(() => {
    const handler = () => fetchFinanceData();
    window.addEventListener('app:refresh', handler);
    return () => window.removeEventListener('app:refresh', handler);
  }, [period, startDate, endDate, selectedBranch]);

  const fetchFinanceData = async () => {
    try {
      // Anchor all period math to Africa/Addis_Ababa (UTC+3, no DST). Without
      // this the "today" filter uses browser/UTC and Ethiopian sales made
      // early in the local morning would show under "yesterday".
      let startDay: string;
      let endDay: string;

      if (startDate || endDate) {
        // Custom range — inclusive on both ends. Missing bound falls back to today.
        startDay = startDate ? addisDayString(new Date(startDate)) : addisDayString();
        endDay = endDate ? addisDayString(new Date(endDate)) : addisDayString();
      } else {
        startDay = addisPeriodStartDay(period as any);
        endDay = addisDayString();
      }

      // Build the actual instants that bracket the Addis day range so custom-
      // expense/inventory `created_at` filters use the same window.
      const queryStartDate = new Date(`${startDay}T00:00:00+03:00`);
      const queryEndDate = new Date(`${endDay}T23:59:59.999+03:00`);

      // Owner isolation: fetch owner's branch IDs when "All Branches"
      let ownerBranchIds: string[] = [];
      if (!selectedBranch && profile?.role === 'owner' && profile?.id) {
        const { data: ownerBranches } = await supabase
          .from('pharmacy_branches')
          .select('id')
          .eq('pharmacy_owner_id', profile.id);
        ownerBranchIds = (ownerBranches || []).map((b: any) => b.id);
      }

      // If owner has no branches yet, show empty data
      if (!selectedBranch && ownerBranchIds.length === 0 && profile?.role === 'owner') {
        setSales([]); setExpenses([]); setInventoryExpenses([]); setBranchData([]);
        setStats({ totalIncome: 0, totalExpenses: 0, netProfit: 0, profitMargin: 0, salesRevenue: 0, extraProfit: 0, discounts: 0, cogs: 0, grossProfit: 0 });
        setLoading(false);
        return;
      }

      // Use sale_date (business/accounting date) for filtering and ordering so
      // reports reflect when the sale actually happened, not when the row was
      // written. created_at remains the system record timestamp.


      // Fetch sales with medicine details
      let salesQuery = supabase
        .from('sales')
        .select(`
          *,
          sale_items (
            medicine_id,
            quantity,
            unit_price,
            total_price,
            sale_type,
            stripes_sold,
            medicines (
              id,
              name,
              unit_label,
              units_per_pack
            )
          )
        `)
        .gte('sale_date', startDay)
        .lte('sale_date', endDay)
        .order('sale_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (selectedBranch) {
        salesQuery = salesQuery.eq('branch_id', selectedBranch);
      } else if (ownerBranchIds.length > 0) {
        salesQuery = salesQuery.in('branch_id', ownerBranchIds);
      }

      const { data: salesData, error: salesError } = await salesQuery;
      if (salesError) throw salesError;
      
      // Batch-fetch seller information
      const sellerIds = Array.from(new Set((salesData || [])
        .map((s: any) => s.sold_by)
        .filter((id: string | null) => !!id)));

      let sellersMap = new Map<string, { full_name: string; email: string; role: string }>();
      if (sellerIds.length === 1) {
        const { data: oneSeller, error: oneSellerError } = await supabase
          .from('profiles')
          .select('id,full_name,role')
          .eq('id', sellerIds[0])
          .maybeSingle();
        if (!oneSellerError && oneSeller) {
          sellersMap.set(oneSeller.id, oneSeller as any);
        }
      } else if (sellerIds.length > 1) {
        const { data: sellersData, error: sellersError } = await supabase
          .from('profiles')
          .select('id,full_name,role')
          .in('id', sellerIds);
        if (!sellersError && sellersData) {
          sellersData.forEach((u: any) => sellersMap.set(u.id, u));
        }
      }

      const salesWithSeller = (salesData || []).map((sale: any) => ({
        ...sale,
        seller: sale.sold_by ? sellersMap.get(sale.sold_by) || null : null,
      }));

      // Fetch custom expenses (exclude Stock Purchase - those are shown in inventory tab)
      let expensesQuery = supabase
        .from('expenses')
        .select('*')
        .neq('category', 'Stock Purchase')
        .gte('created_at', queryStartDate.toISOString())
        .lte('created_at', queryEndDate.toISOString())
        .order('created_at', { ascending: false });

      if (selectedBranch) {
        expensesQuery = expensesQuery.eq('branch_id', selectedBranch);
      } else if (ownerBranchIds.length > 0) {
        expensesQuery = expensesQuery.in('branch_id', ownerBranchIds);
      }

      const { data: expensesData, error: expensesError } = await expensesQuery;
      if (expensesError) throw expensesError;

      // Fetch inventory expenses from inventory_batches (each batch = separate expense entry)
      let inventoryQuery = supabase
        .from('inventory_batches')
        .select('id, quantity, purchase_price, selling_price, branch_id, batch_number, created_at, medicines!inner(name)')
        .gte('created_at', queryStartDate.toISOString())
        .lte('created_at', queryEndDate.toISOString())
        .order('created_at', { ascending: false });

      if (selectedBranch) {
        inventoryQuery = inventoryQuery.eq('branch_id', selectedBranch);
      } else if (ownerBranchIds.length > 0) {
        inventoryQuery = inventoryQuery.in('branch_id', ownerBranchIds);
      }

      const { data: inventoryData } = await inventoryQuery;

      // Fallback: if inventory_batches table doesn't exist or returns null, use branch_items
      let invExpenses: InventoryExpense[] = [];
      
      // Fetch branch names for inventory expenses
      let branchNameQuery = supabase
        .from('pharmacy_branches')
        .select('id, name');
      if (profile?.role === 'owner' && profile?.id) {
        branchNameQuery = branchNameQuery.eq('pharmacy_owner_id', profile.id);
      }
      const { data: branchesForNames } = await branchNameQuery;
      const branchNameMap = new Map((branchesForNames || []).map((b: any) => [b.id, b.name]));

      if (inventoryData && inventoryData.length > 0) {
        invExpenses = inventoryData.map((batch: any) => ({
          id: batch.id,
          name: `${(batch.medicines as any)?.name || 'Unknown'}${batch.batch_number ? ` [${batch.batch_number}]` : ''}`,
          stock_quantity: Number(batch.quantity),
          purchase_price: Number(batch.purchase_price),
          total_cost: Number(batch.purchase_price) * Number(batch.quantity),
          branch_name: batch.branch_id ? branchNameMap.get(batch.branch_id) : undefined,
          created_at: batch.created_at,
        }));
      } else {
        // Fallback to branch_items if no batches found
        let fallbackQuery = supabase
          .from('branch_items')
          .select('id, quantity, purchase_price, branch_id, created_at, medicines!inner(name)')
          .gte('created_at', queryStartDate.toISOString())
          .lte('created_at', queryEndDate.toISOString())
          .order('created_at', { ascending: false });

        if (selectedBranch) {
          fallbackQuery = fallbackQuery.eq('branch_id', selectedBranch);
        } else if (ownerBranchIds.length > 0) {
          fallbackQuery = fallbackQuery.in('branch_id', ownerBranchIds);
        }

        const { data: fallbackData } = await fallbackQuery;
        invExpenses = (fallbackData || []).map((bi: any) => ({
          id: bi.id,
          name: (bi.medicines as any)?.name || 'Unknown',
          stock_quantity: bi.quantity,
          purchase_price: Number(bi.purchase_price),
          total_cost: Number(bi.purchase_price) * Number(bi.quantity),
          branch_name: bi.branch_id ? branchNameMap.get(bi.branch_id) : undefined,
          created_at: bi.created_at,
        }));
      }

      setInventoryExpenses(invExpenses);
      setSales(salesWithSeller || []);
      setExpenses(expensesData || []);

      // Fetch packaging metadata for all medicines referenced in these sales
      const medIds = Array.from(new Set(
        (salesWithSeller || [])
          .flatMap((s: any) => s.sale_items || [])
          .map((si: any) => si.medicine_id || si.medicines?.id)
          .filter(Boolean) as string[]
      ));
      if (medIds.length > 0) {
        const { chunkedInPartial } = await import('@/lib/supabaseBatch');
        console.log(`[Supabase batching] medicine_packaging by medicine_id (FinanceManagement): ${Math.ceil(medIds.length / 20)} batches for ${medIds.length} ids`);
        const { data: pkgRows } = await chunkedInPartial<any>(medIds, (chunk) =>
          (supabase as any)
            .from('medicine_packaging')
            .select('*')
            .in('medicine_id', chunk)
        , 20);
        const map: Record<string, Packaging> = {};
        pkgRows.forEach((p: any) => { map[p.medicine_id] = p as Packaging; });
        setPackagingMap(map);
      } else {
        setPackagingMap({});
      }

      // Revenue calculation:
      //  - total_amount is stored NET of discount at sale time.
      //  - extra_profit is tips / kept-change overpayments (real cash received).
      //  - discounts are tracked separately for reporting only; they do NOT
      //    reduce income again (they were already subtracted before storage).
      const salesRevenue = salesData?.reduce((sum, sale: any) => sum + Number(sale.total_amount), 0) || 0;
      const extraProfit = salesData?.reduce((sum, sale: any) => sum + Number(sale.extra_profit || 0), 0) || 0;
      const discounts = salesData?.reduce((sum, sale: any) => sum + Number(sale.discount_amount || 0), 0) || 0;
      const totalIncome = salesRevenue + extraProfit;

      // Operating expenses = custom expenses only. Inventory batch purchases
      // are Cost of Goods (COGS), not operating expenses (accounting standard).
      const totalExpenses = expensesData?.reduce((sum, expense) => sum + Number(expense.amount), 0) || 0;
      const netProfit = totalIncome - totalExpenses;
      const profitMargin = totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0;

      // COGS: sum(baseUnits sold × avg purchase cost per base unit) using
      // branch_items purchase_price as the cost basis for each medicine.
      let cogs = 0;
      if (medIds.length > 0) {
        let costQuery = supabase
          .from('branch_items')
          .select('medicine_id, purchase_price, quantity, branch_id')
          .in('medicine_id', medIds);
        if (selectedBranch) costQuery = costQuery.eq('branch_id', selectedBranch);
        else if (ownerBranchIds.length > 0) costQuery = costQuery.in('branch_id', ownerBranchIds);
        const { data: costRows } = await costQuery;
        const costAgg = new Map<string, { total: number; qty: number }>();
        (costRows || []).forEach((r: any) => {
          const prev = costAgg.get(r.medicine_id) || { total: 0, qty: 0 };
          const q = Math.max(0, Number(r.quantity) || 0);
          prev.total += Number(r.purchase_price || 0) * q;
          prev.qty += q;
          costAgg.set(r.medicine_id, prev);
        });
        const costPerUnit = (medId: string) => {
          const a = costAgg.get(medId);
          if (!a || a.qty <= 0) {
            const any = (costRows || []).find((r: any) => r.medicine_id === medId);
            return any ? Number(any.purchase_price || 0) : 0;
          }
          return a.total / a.qty;
        };
        (salesWithSeller || []).forEach((sale: any) => {
          (sale.sale_items || []).forEach((si: any) => {
            const medId = si.medicine_id || si.medicines?.id;
            if (!medId) return;
            const pkg = packagingMap[medId] || (undefined as any);
            const f = formatSaleItem(si, pkg);
            cogs += f.baseUnits * costPerUnit(medId);
          });
        });
      }
      const grossProfit = totalIncome - cogs;

      setStats({
        totalIncome,
        totalExpenses,
        netProfit,
        profitMargin,
        salesRevenue,
        extraProfit,
        discounts,
        cogs,
        grossProfit,
      });

      // Branch-wise data for chart
      if (profile?.role === 'owner' && !selectedBranch) {
        const { data: branchesData } = await supabase
          .from('pharmacy_branches')
          .select('id, name')
          .eq('pharmacy_owner_id', profile.id);

        const branchStats: BranchData[] = (branchesData || []).map(branch => {
          const branchSales = salesData?.filter((s: any) => s.branch_id === branch.id) || [];
          const branchCustomExpenses = expensesData?.filter((e: any) => e.branch_id === branch.id) || [];
          // Branch chart shows Income vs Operating Expenses (COGS excluded).
          return {
            branchId: branch.id,
            branchName: branch.name,
            income: branchSales.reduce((sum, sale: any) => sum + Number(sale.total_amount) + Number(sale.extra_profit || 0), 0),
            expenses: branchCustomExpenses.reduce((sum, expense) => sum + Number(expense.amount), 0),
          };
        });

        setBranchData(branchStats);
      } else {
        setBranchData([]);
      }
      
      setSalesPage(1);
      setExpensesPage(1);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to fetch finance data",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const startIndex = (salesPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    setPaginatedSales(sales.slice(startIndex, endIndex));
  }, [sales, salesPage]);

  useEffect(() => {
    const startIndex = (expensesPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    setPaginatedExpenses(expenses.slice(startIndex, endIndex));
  }, [expenses, expensesPage]);

  // Group sales by item name for income drill-down
  const itemSummaries = useMemo<ItemSummary[]>(() => {
    const acc = new Map<string, ItemSummary>();
    for (const sale of sales) {
      if (!sale.sale_items) continue;
      for (const item of sale.sale_items) {
        const name = item.medicines?.name || 'Unknown';
        const medId = (item as any).medicine_id || item.medicines?.id;
        const pkg = medId ? packagingMap[medId] : undefined;
        const existing: ItemSummary = acc.get(name) || {
          name,
          totalIncome: 0,
          perLevel: { unit: 0, strip: 0, pack: 0 },
        };
        if (!existing.unitLabel) {
          existing.unitLabel = pkg?.unit_name || item.medicines?.unit_label;
          existing.unitsPerPack = item.medicines?.units_per_pack;
          existing.stripName = pkg?.strip_name || undefined;
          existing.packName = pkg?.pack_name || undefined;
        }
        const f = formatSaleItem(item, pkg);
        existing.perLevel[f.level] += f.qty;
        existing.totalIncome += Number(item.total_price || 0);
        acc.set(name, existing);
      }
    }
    return Array.from(acc.values()).sort((a, b) => b.totalIncome - a.totalIncome);
  }, [sales, packagingMap]);

  // Get transactions for a specific item
  const selectedItemTransactions = useMemo(() => {
    if (!selectedItem) return [];
    return sales
      .filter(sale => sale.sale_items?.some(si => si.medicines?.name === selectedItem))
      .map(sale => {
        const relevantItems = sale.sale_items?.filter(si => si.medicines?.name === selectedItem) || [];
        const perLevel: Record<SaleLevel, { qty: number; baseUnits: number; levelLabel: string; baseLabel: string }> = {
          unit: { qty: 0, baseUnits: 0, levelLabel: 'unit', baseLabel: 'unit' },
          strip: { qty: 0, baseUnits: 0, levelLabel: 'strip', baseLabel: 'unit' },
          pack: { qty: 0, baseUnits: 0, levelLabel: 'pack', baseLabel: 'unit' },
        };
        let itemTotal = 0;
        for (const si of relevantItems) {
          const medId = (si as any).medicine_id || si.medicines?.id;
          const pkg = medId ? packagingMap[medId] : undefined;
          const f = formatSaleItem(si, pkg);
          perLevel[f.level].qty += f.qty;
          perLevel[f.level].baseUnits += f.baseUnits;
          perLevel[f.level].levelLabel = f.levelLabel;
          perLevel[f.level].baseLabel = f.baseLabel;
          itemTotal += Number(si.total_price || 0);
        }
        return { ...sale, perLevel, itemTotal };
      })
      .sort((a, b) => {
        // Primary: sale_date (business date). Secondary: created_at for ties.
        const aDate = (a as any).sale_date || a.created_at;
        const bDate = (b as any).sale_date || b.created_at;
        const d = new Date(bDate).getTime() - new Date(aDate).getTime();
        return d !== 0 ? d : new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [sales, selectedItem, packagingMap]);

  const fetchBranches = async () => {
    try {
      let query = supabase
        .from('pharmacy_branches')
        .select('id, name');

      if (profile?.role === 'owner') {
        query = query.eq('pharmacy_owner_id', profile.id);
      } else if (profile?.branch_id) {
        query = query.eq('id', profile.branch_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      setBranches(data || []);
      
      if (data && data.length > 0) {
        setExpenseBranchId(selectedBranch || profile?.branch_id || data[0].id);
      }
    } catch (error) {
      console.error('Error fetching branches:', error);
    }
  };

  const handleAddExpense = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    
    if (!expenseBranchId) {
      toast({
        title: "Error",
        description: "Please select a pharmacy branch",
        variant: "destructive"
      });
      return;
    }

    const formData = new FormData(e.currentTarget);
    const expenseData = {
      description: formData.get('description') as string,
      amount: parseFloat(formData.get('amount') as string),
      category: formData.get('category') as string,
      created_by: profile?.id,
      branch_id: expenseBranchId
    };

    try {
      const { error } = await supabase
        .from('expenses')
        .insert([expenseData]);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Expense added successfully"
      });

      setShowAddExpense(false);
      fetchFinanceData();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to add expense",
        variant: "destructive"
      });
    }
  };

  const exportReportExcel = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Financial Report');
    const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E6F3E' } };
    const evenRowFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F9F4' } };
    const border: Partial<ExcelJS.Borders> = {
      top: { style: 'thin', color: { argb: 'FFD0D5DD' } }, bottom: { style: 'thin', color: { argb: 'FFD0D5DD' } },
      left: { style: 'thin', color: { argb: 'FFD0D5DD' } }, right: { style: 'thin', color: { argb: 'FFD0D5DD' } },
    };
    ws.mergeCells('A1:G1');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'Financial Report';
    titleCell.font = { size: 18, bold: true, color: { argb: 'FF1E6F3E' } };
    titleCell.alignment = { horizontal: 'center' };
    ws.mergeCells('A2:G2');
    const subCell = ws.getCell('A2');
    subCell.value = `Period: ${period.charAt(0).toUpperCase() + period.slice(1)} | Generated: ${new Date().toLocaleDateString()}`;
    subCell.font = { size: 10, color: { argb: 'FF666666' } };
    subCell.alignment = { horizontal: 'center' };
    const sRow = 4;
    ws.getRow(sRow).values = ['', 'Total Income', 'Total Expenses', 'Net Profit', 'Profit Margin', 'Transactions', 'Avg. Sale'];
    ws.getRow(sRow).eachCell((cell) => {
      cell.font = { bold: true, size: 9, color: { argb: 'FF555555' } };
      cell.alignment = { horizontal: 'center' };
      cell.border = border;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    });
    ws.getRow(sRow + 1).values = [
      '', `ETB ${stats.totalIncome.toFixed(2)}`, `ETB ${stats.totalExpenses.toFixed(2)}`,
      `ETB ${stats.netProfit.toFixed(2)}`, `${stats.profitMargin.toFixed(1)}%`,
      sales.length.toString(), `ETB ${sales.length > 0 ? (stats.totalIncome / sales.length).toFixed(2) : '0.00'}`,
    ];
    ws.getRow(sRow + 1).eachCell((cell, colNum) => {
      cell.font = { bold: true, size: 11 };
      cell.alignment = { horizontal: 'center' };
      cell.border = border;
      if (colNum === 2) cell.font = { bold: true, size: 11, color: { argb: 'FF16A34A' } };
      if (colNum === 3) cell.font = { bold: true, size: 11, color: { argb: 'FFDC2626' } };
      if (colNum === 4) cell.font = { bold: true, size: 11, color: { argb: stats.netProfit >= 0 ? 'FF16A34A' : 'FFDC2626' } };
    });
    const txH = 8;
    ws.mergeCells('A7:G7');
    ws.getCell('A7').value = 'All Transactions';
    ws.getCell('A7').font = { size: 12, bold: true, color: { argb: 'FF1E6F3E' } };
    ws.getRow(txH).values = ['Date & Time', 'Items', 'Sold By', 'Payment', 'Discount', 'Amount', 'Status'];
    ws.getRow(txH).eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.alignment = { horizontal: 'center' };
      cell.border = border;
    });
    sales.forEach((sale, i) => {
      const row = ws.getRow(txH + 1 + i);
      const itemNames = sale.sale_items?.map(si => {
        const nm = si.medicines?.name || 'Unknown';
        const medId = (si as any).medicine_id || si.medicines?.id;
        const pkg = medId ? packagingMap[medId] : undefined;
        const f = formatSaleItem(si, pkg);
        if (!f.qty) return nm;
        const qtyStr = f.qty % 1 === 0 ? f.qty : f.qty.toFixed(2);
        const detail = f.level !== 'unit' && f.baseUnits > 0
          ? ` (${f.baseUnits} ${pluralLabel(f.baseLabel, f.baseUnits)})`
          : '';
        return `${nm} ×${qtyStr} ${pluralLabel(f.levelLabel, f.qty)}${detail}`;
      }).join(', ') || '—';
      const isPaid = Number(sale.total_amount) <= ((sale as any).amount_paid || 0);
      const isPartial = !isPaid && ((sale as any).amount_paid || 0) > 0;
      row.values = [
        new Date((sale as any).sale_date || sale.created_at).toLocaleString(), itemNames,
        sale.seller ? `${sale.seller.role === 'owner' ? 'Owner' : 'Staff'} (${sale.seller.full_name})` : '—',
        (sale as any).payment_method || '—',
        Number(sale.discount_amount) > 0 ? Number(sale.discount_amount) : '',
        Number(sale.total_amount),
        isPaid ? 'Paid' : isPartial ? 'Partial' : 'Unpaid',
      ];
      row.eachCell((cell, colNum) => {
        cell.border = border;
        if (i % 2 === 0) cell.fill = evenRowFill;
        if (colNum === 5 && Number(sale.discount_amount) > 0) { cell.font = { color: { argb: 'FF16A34A' } }; cell.numFmt = '#,##0.00'; }
        if (colNum === 6) { cell.font = { bold: true }; cell.numFmt = '#,##0.00'; cell.alignment = { horizontal: 'right' }; }
        if (colNum === 7) { cell.font = { bold: true, color: { argb: isPaid ? 'FF16A34A' : isPartial ? 'FFCA8A04' : 'FFDC2626' } }; cell.alignment = { horizontal: 'center' }; }
      });
    });
    ws.columns = [{ width: 20 }, { width: 35 }, { width: 20 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 10 }];
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `Financial_Report_${period}_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
  };

  const exportReportPDF = () => {
    const doc = new jsPDF();
    doc.setFillColor(30, 111, 62); doc.rect(0, 0, 210, 26, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(18); doc.text('Financial Report', 14, 13);
    doc.setFontSize(10); doc.text(`Period: ${period.charAt(0).toUpperCase() + period.slice(1)} | Generated: ${new Date().toLocaleDateString()}`, 14, 21);
    const sy = 34; const bw = 44;
    ([
      { label: 'Total Income', value: `ETB ${stats.totalIncome.toFixed(2)}`, color: [22, 163, 74] },
      { label: 'Total Expenses', value: `ETB ${stats.totalExpenses.toFixed(2)}`, color: [220, 38, 38] },
      { label: 'Net Profit', value: `ETB ${stats.netProfit.toFixed(2)}`, color: stats.netProfit >= 0 ? [22, 163, 74] : [220, 38, 38] },
      { label: 'Profit Margin', value: `${stats.profitMargin.toFixed(1)}%`, color: stats.profitMargin >= 0 ? [22, 163, 74] : [220, 38, 38] },
    ] as { label: string; value: string; color: [number, number, number] }[]).forEach((item, i) => {
      const x = 14 + i * (bw + 3);
      doc.setFillColor(240, 249, 244); doc.roundedRect(x, sy, bw, 16, 2, 2, 'F');
      doc.setTextColor(100, 100, 100); doc.setFontSize(7); doc.text(item.label, x + 3, sy + 6);
      doc.setTextColor(item.color[0], item.color[1], item.color[2]); doc.setFontSize(10); doc.text(item.value, x + 3, sy + 13);
    });
    autoTable(doc, {
      startY: 56,
      head: [['Date', 'Items', 'Sold By', 'Payment', 'Discount', 'Amount', 'Status']],
      body: sales.map(sale => {
        const itemNames = sale.sale_items?.map(si => {
          const nm = si.medicines?.name || 'Unknown';
          const medId = (si as any).medicine_id || si.medicines?.id;
          const pkg = medId ? packagingMap[medId] : undefined;
          const f = formatSaleItem(si, pkg);
          if (!f.qty) return nm;
          const qtyStr = f.qty % 1 === 0 ? f.qty : f.qty.toFixed(2);
          const detail = f.level !== 'unit' && f.baseUnits > 0
            ? ` (${f.baseUnits} ${pluralLabel(f.baseLabel, f.baseUnits)})`
            : '';
          return `${nm} ×${qtyStr} ${pluralLabel(f.levelLabel, f.qty)}${detail}`;
        }).join(', ') || '—';
        const isPaid = Number(sale.total_amount) <= ((sale as any).amount_paid || 0);
        const isPartial = !isPaid && ((sale as any).amount_paid || 0) > 0;
        return [
          new Date((sale as any).sale_date || sale.created_at).toLocaleDateString(), itemNames,
          sale.seller ? `${sale.seller.role === 'owner' ? 'Owner' : 'Staff'} (${sale.seller.full_name})` : '—',
          (sale as any).payment_method || '—',
          Number(sale.discount_amount) > 0 ? `−ETB ${Number(sale.discount_amount).toFixed(2)}` : '',
          `ETB ${Number(sale.total_amount).toFixed(2)}`,
          isPaid ? 'Paid' : isPartial ? 'Partial' : 'Unpaid',
        ];
      }),
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [30, 111, 62], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [240, 249, 244] },
      columnStyles: { 4: { halign: 'right', textColor: [22, 163, 74] }, 5: { halign: 'right', fontStyle: 'bold' }, 6: { halign: 'center' } },
    });
    doc.save(`Financial_Report_${period}_${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  const renderPagination = (currentPage: number, totalItems: number, setPage: (p: number) => void) => {
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if (totalPages <= 1) return null;
    return (
      <div className="flex justify-center pt-4">
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious 
                href="#"
                onClick={(e) => { e.preventDefault(); if (currentPage > 1) setPage(currentPage - 1); }}
                className={currentPage === 1 ? "pointer-events-none opacity-50" : ""}
              />
            </PaginationItem>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
              <PaginationItem key={page}>
                <PaginationLink
                  href="#"
                  onClick={(e) => { e.preventDefault(); setPage(page); }}
                  isActive={currentPage === page}
                >
                  {page}
                </PaginationLink>
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext 
                href="#"
                onClick={(e) => { e.preventDefault(); if (currentPage < totalPages) setPage(currentPage + 1); }}
                className={currentPage === totalPages ? "pointer-events-none opacity-50" : ""}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    );
  };

  if (loading) {
    return <div>Loading finance data...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-xl sm:text-2xl font-bold">Finance Management</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
            
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-auto justify-start text-left font-normal text-xs sm:text-sm">
                  <CalendarIcon className="mr-1 h-3.5 w-3.5" />
                  {startDate ? format(startDate, "PP") : <span>Start</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={startDate}
                  onSelect={setStartDate}
                  initialFocus
                  className="p-3 pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
            
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-auto justify-start text-left font-normal text-xs sm:text-sm">
                  <CalendarIcon className="mr-1 h-3.5 w-3.5" />
                  {endDate ? format(endDate, "PP") : <span>End</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={endDate}
                  onSelect={setEndDate}
                  initialFocus
                  className="p-3 pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
            
            <Dialog open={showAddExpense} onOpenChange={setShowAddExpense}>
              <DialogTrigger asChild>
                <Button size="sm" disabled={readOnly}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Expense
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New Expense</DialogTitle>
                  <DialogDescription>
                    Record a new business expense
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleAddExpense} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="branch">Branch</Label>
                    <Select value={expenseBranchId} onValueChange={setExpenseBranchId} required>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a branch" />
                      </SelectTrigger>
                      <SelectContent>
                        {branches.map((branch) => (
                          <SelectItem key={branch.id} value={branch.id}>
                            {branch.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Input id="description" name="description" required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="amount">Amount</Label>
                    <Input
                      id="amount"
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="category">Category</Label>
                    <Input
                      id="category"
                      name="category"
                      placeholder="e.g., Utilities, Supplies, Rent"
                      required
                    />
                  </div>
                  <div className="flex justify-end space-x-2">
                    <Button type="button" variant="outline" onClick={() => setShowAddExpense(false)}>
                      Cancel
                    </Button>
                    <Button type="submit">Add Expense</Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
        {isAdvancedMode ? (
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Income</CardTitle>
                <DollarSign className="h-4 w-4 text-success" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-success">ETB {stats.totalIncome.toFixed(2)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Expenses</CardTitle>
                <TrendingDown className="h-4 w-4 text-destructive" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-destructive">ETB {stats.totalExpenses.toFixed(2)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
                <TrendingUp className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${stats.netProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
                  ETB {stats.netProfit.toFixed(2)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Profit Margin</CardTitle>
                <BarChart3 className="h-4 w-4 text-info" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${stats.profitMargin >= 0 ? 'text-success' : 'text-destructive'}`}>
                  {stats.profitMargin.toFixed(1)}%
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Period Sales</CardTitle>
                <DollarSign className="h-4 w-4 text-success" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-success">ETB {stats.totalIncome.toFixed(2)}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Sales Revenue{stats.extraProfit > 0 ? ` + Extra ETB ${stats.extraProfit.toFixed(2)}` : ''}
                  {stats.discounts > 0 ? ` − Discounts ETB ${stats.discounts.toFixed(2)}` : ''}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Gross Profit</CardTitle>
                <TrendingUp className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${stats.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
                  ETB {stats.grossProfit.toFixed(2)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Total Income − Cost of Goods (COGS)</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>


      {/* See Details button in Simple Mode */}
      {!isAdvancedMode && !showFinanceDetails && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setShowFinanceDetails(true)} className="gap-2">
            <ChevronRight className="h-4 w-4" />
            See Details
          </Button>
        </div>
      )}

      {(isAdvancedMode || showFinanceDetails) && (
        <>
          {!isAdvancedMode && showFinanceDetails && (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={() => setShowFinanceDetails(false)} className="gap-2 text-muted-foreground">
                <ArrowLeft className="h-4 w-4" />
                Hide Details
              </Button>
            </div>
          )}

          {/* Detailed Views */}
          <Tabs defaultValue="overview" className="space-y-4">
            <TabsList className="flex flex-wrap h-auto gap-1">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="income">Income</TabsTrigger>
              <TabsTrigger value="expenses">Expenses</TabsTrigger>
              <TabsTrigger value="salaries">Salaries</TabsTrigger>
              <TabsTrigger value="debts">Debts</TabsTrigger>
              <TabsTrigger value="reports">Reports</TabsTrigger>
            </TabsList>

        <TabsContent value="overview">
          <div className="space-y-6">
            {branchData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Income vs Expenses by Branch</CardTitle>
                  <CardDescription>Comparison across all branches</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                  <div style={{ minWidth: 300 }}>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={branchData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="branchName" tick={{ fontSize: 11 }} />
                      <YAxis />
                      <Tooltip 
                        formatter={(value: number) => `ETB ${value.toFixed(2)}`}
                      />
                      <Legend />
                      <Bar dataKey="income" fill="hsl(142, 76%, 36%)" name="Income" />
                      <Bar dataKey="expenses" fill="hsl(0, 84%, 60%)" name="Expenses" />
                    </BarChart>
                  </ResponsiveContainer>
                  </div>
                  </div>
                </CardContent>
              </Card>
            )}
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Income vs Expenses Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Sales Revenue</span>
                      <span className="font-medium">ETB {stats.salesRevenue.toFixed(2)}</span>
                    </div>
                    {stats.discounts > 0 && (
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">− Discounts Given</span>
                        <span className="font-medium text-muted-foreground">− ETB {stats.discounts.toFixed(2)}</span>
                      </div>
                    )}
                    {stats.extraProfit > 0 && (
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-success inline-flex items-center gap-1">
                          + Extra Payments (Tips / Keep Change)
                        </span>
                        <span className="font-medium text-success">+ ETB {stats.extraProfit.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span>Total Income</span>
                      <span className="text-success font-medium">ETB {stats.totalIncome.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>Operating Expenses</span>
                      <span className="text-destructive font-medium">− ETB {stats.totalExpenses.toFixed(2)}</span>
                    </div>
                    <div className="border-t pt-2">
                      <div className="flex justify-between items-center font-bold">
                        <span>Net Income</span>
                        <span className={stats.netProfit >= 0 ? 'text-success' : 'text-destructive'}>
                          ETB {stats.netProfit.toFixed(2)}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Net Income = Total Income − Operating Expenses (COGS reported separately)
                      </p>
                    </div>
                    <div className="mt-3 pt-3 border-t space-y-2">
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Cost of Goods (COGS)</span>
                        <span className="font-medium">ETB {stats.cogs.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span>Gross Profit</span>
                        <span className={`font-semibold ${stats.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
                          ETB {stats.grossProfit.toFixed(2)}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Gross Profit = Total Income − Cost of Goods (before operating expenses)
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ===== INCOME TAB - Grouped by Item ===== */}
        <TabsContent value="income">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                {selectedItem && (
                  <Button variant="ghost" size="icon" onClick={() => setSelectedItem(null)}>
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                )}
                <div className="flex-1">
                  <CardTitle>{selectedItem ? `Transactions: ${selectedItem}` : 'Income by Item'}</CardTitle>
                  <CardDescription>
                    {selectedItem 
                      ? 'All transactions for this item, latest first' 
                      : 'Click an item to view individual transactions'}
                  </CardDescription>
                </div>
              </div>
              {/* Income composition: Sales Revenue + Extra Profit = Total Income */}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-md border bg-muted/40 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sales Revenue</div>
                  <div className="text-sm font-semibold">ETB {stats.salesRevenue.toFixed(2)}</div>
                </div>
                <div className="rounded-md border bg-success/10 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-success">Extra Profit (Keep Change)</div>
                  <div className="text-sm font-semibold text-success">+ ETB {stats.extraProfit.toFixed(2)}</div>
                </div>
                <div className="rounded-md border bg-primary/10 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-primary">Total Income</div>
                  <div className="text-sm font-bold text-primary">ETB {stats.totalIncome.toFixed(2)}</div>
                </div>
              </div>
            </CardHeader>

            <CardContent>
              {!selectedItem ? (
                /* === Item Summary List === */
                <div className="space-y-2">
                  {itemSummaries.length === 0 ? (
                    <p className="text-muted-foreground text-center py-4">No sales in selected period</p>
                  ) : (
                    <div className="overflow-x-auto">
                    <Table className="min-w-[500px]">
                      <TableHeader>
                         <TableRow>
                          <TableHead>Item Name</TableHead>
                          <TableHead className="text-right">Quantity Sold</TableHead>
                          <TableHead className="text-right">Total Income</TableHead>
                          <TableHead className="w-10"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {itemSummaries.map((item) => (
                          <TableRow 
                            key={item.name} 
                            className="cursor-pointer hover:bg-muted/80"
                            onClick={() => setSelectedItem(item.name)}
                          >
                            <TableCell className="font-medium">{item.name}</TableCell>
                            <TableCell className="text-right">
                              <div className="space-y-0.5">
                                {(['pack','strip','unit'] as SaleLevel[]).map(lvl => {
                                  const q = item.perLevel[lvl];
                                  if (!q) return null;
                                  const label =
                                    lvl === 'unit' ? (item.unitLabel || 'unit')
                                    : lvl === 'strip' ? (item.stripName || 'strip')
                                    : (item.packName || 'pack');
                                  const ups = item.unitsPerPack || 1;
                                  const baseUnits =
                                    lvl === 'unit' ? q
                                    : lvl === 'pack' ? q * ups
                                    : 0;
                                  return (
                                    <div key={lvl}>
                                      {q % 1 === 0 ? q : q.toFixed(2)} {pluralLabel(label, q)}
                                      {lvl === 'pack' && baseUnits > 0 && item.unitLabel && (
                                        <span className="text-muted-foreground text-xs ml-1">
                                          ({baseUnits} {pluralLabel(item.unitLabel, baseUnits)})
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-success font-medium">
                              ETB {item.totalIncome.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </div>
                  )}
                  <div className="text-center text-sm text-muted-foreground pt-2">
                    {itemSummaries.length} item(s) · Total: ETB {stats.totalIncome.toFixed(2)}
                  </div>
                </div>
              ) : (
                /* === Item Transaction Drill-Down === */
                <div className="space-y-4">
                  {selectedItemTransactions.length === 0 ? (
                    <p className="text-muted-foreground text-center py-4">No transactions found</p>
                  ) : (
                    selectedItemTransactions.map((sale) => {
                      const extraProfit = Number((sale as any).extra_profit || 0);
                      const saleTotal = Number(sale.total_amount || 0);
                      const finalReceived = saleTotal + extraProfit;
                      const hasExtra = extraProfit > 0.001;
                      return (
                        <div key={sale.id} className="flex justify-between items-start p-3 border rounded-lg">
                          <div className="flex-1 space-y-1">
                            <div className="font-medium flex items-center gap-2 flex-wrap">
                              {selectedItem}
                              {hasExtra && (
                                <span className="inline-flex items-center text-[10px] font-semibold rounded-full bg-success/15 text-success px-2 py-0.5">
                                  + ETB {extraProfit.toFixed(2)} Extra Profit (Keep Change)
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground space-x-3">
                              {(['pack','strip','unit'] as SaleLevel[]).map(lvl => {
                                const seg = sale.perLevel[lvl];
                                if (!seg.qty) return null;
                                return (
                                  <span key={lvl}>
                                    {seg.qty % 1 === 0 ? seg.qty : seg.qty.toFixed(2)} {pluralLabel(seg.levelLabel, seg.qty)}
                                    {lvl !== 'unit' && seg.baseUnits > 0 && (
                                      <span className="text-xs ml-1">
                                        ({seg.baseUnits} {pluralLabel(seg.baseLabel, seg.baseUnits)})
                                      </span>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {new Date((sale as any).sale_date || sale.created_at).toLocaleDateString()} · {new Date(sale.created_at).toLocaleTimeString()}
                            </div>
                            {Number(sale.discount_amount || 0) > 0 && (
                              <div className="text-xs text-muted-foreground">
                                Discount: ETB {Number(sale.discount_amount).toFixed(2)}
                              </div>
                            )}
                            <div className="text-xs flex gap-2">
                              <span className="text-muted-foreground">Sold by:</span>
                              {sale.seller ? (
                                <span className="font-medium text-foreground">
                                  {sale.seller.role === 'owner' ? 'Owner' : 'Staff'} ({sale.seller.full_name || 'N/A'})
                                </span>
                              ) : (
                                <span className="font-medium text-foreground">N/A</span>
                              )}
                            </div>
                            {hasExtra && (
                              <div className="mt-2 rounded-md border bg-muted/30 p-2 text-xs space-y-0.5">
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Selling Amount</span>
                                  <span>ETB {saleTotal.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Amount Received</span>
                                  <span>ETB {finalReceived.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between text-success">
                                  <span>Extra Profit (Keep Change)</span>
                                  <span>+ ETB {extraProfit.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                                  <span>Final Total</span>
                                  <span>ETB {finalReceived.toFixed(2)}</span>
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="text-right">
                            <div className="text-success font-medium">ETB {sale.itemTotal.toFixed(2)}</div>
                            {hasExtra && (
                              <div className="text-[10px] text-success/80 mt-0.5">+ ETB {extraProfit.toFixed(2)} tip</div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div className="text-center text-sm text-muted-foreground">
                    {selectedItemTransactions.length} transaction(s)
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===== EXPENSES TAB - Split into Inventory & Custom ===== */}
        <TabsContent value="expenses">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle>Expenses & Cost of Goods</CardTitle>
                  <CardDescription>Cost of Goods (inventory purchases) and operating expenses are tracked separately</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={expenseSubTab === 'inventory' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setExpenseSubTab('inventory')}
                  >
                    <Package className="h-4 w-4 mr-1" />
                    Cost of Goods (COGS) ({inventoryExpenses.length})
                  </Button>
                  <Button
                    variant={expenseSubTab === 'custom' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setExpenseSubTab('custom')}
                  >
                    <Receipt className="h-4 w-4 mr-1" />
                    Operating Expenses ({expenses.length})
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {expenseSubTab === 'inventory' ? (
                /* === Inventory Expenses === */
                <div className="space-y-4">
                  {inventoryExpenses.length === 0 ? (
                    <p className="text-muted-foreground text-center py-4">No inventory purchases (COGS) in selected period</p>
                  ) : (
                    <div className="overflow-x-auto">
                    <Table className="min-w-[600px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item/Medicine</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Unit Cost</TableHead>
                          <TableHead className="text-right">Total Cost</TableHead>
                          <TableHead>Branch</TableHead>
                          <TableHead>Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {inventoryExpenses.map((inv) => (
                          <TableRow key={inv.id}>
                            <TableCell className="font-medium">{inv.name}</TableCell>
                            <TableCell className="text-right">{inv.stock_quantity}</TableCell>
                            <TableCell className="text-right">ETB {inv.purchase_price.toFixed(2)}</TableCell>
                            <TableCell className="text-right text-destructive font-medium">
                              ETB {inv.total_cost.toFixed(2)}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">{inv.branch_name || '—'}</TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {new Date(inv.created_at).toLocaleDateString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </div>
                  )}
                  <div className="text-center text-sm text-muted-foreground">
                    Total Cost of Goods (COGS): ETB {inventoryExpenses.reduce((s, i) => s + i.total_cost, 0).toFixed(2)}
                  </div>
                </div>
              ) : (
                /* === Custom Expenses === */
                <div className="space-y-4">
                  {paginatedExpenses.map((expense) => (
                    <div key={expense.id} className="flex justify-between items-center p-2 border rounded">
                      <div>
                        <div className="font-medium">{expense.description}</div>
                        <div className="text-xs text-muted-foreground">{expense.category}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-destructive font-medium">-ETB {expense.amount}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(expense.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                  {expenses.length === 0 && (
                    <p className="text-muted-foreground text-center py-4">No custom expenses in selected period</p>
                  )}
                  
                  {renderPagination(expensesPage, expenses.length, setExpensesPage)}
                  
                  <div className="text-center text-sm text-muted-foreground">
                    Showing {paginatedExpenses.length} of {expenses.length} custom expense records
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="salaries">
          <SalaryHistory />
        </TabsContent>

        <TabsContent value="debts">
          <DebtManagement />
        </TabsContent>

        <TabsContent value="reports">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle>Financial Report</CardTitle>
                  <CardDescription>Detailed transaction report for the selected period</CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={exportReportExcel} disabled={sales.length === 0}>
                    <Download className="h-3 w-3 mr-1" /> Excel
                  </Button>
                  <Button size="sm" variant="outline" onClick={exportReportPDF} disabled={sales.length === 0}>
                    <Download className="h-3 w-3 mr-1" /> PDF
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* KPI Summary */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Transactions', value: sales.length.toString() },
                    { label: 'Avg. Sale Value', value: `ETB ${sales.length > 0 ? (stats.totalIncome / sales.length).toFixed(2) : '0.00'}` },
                    { label: 'Total Income', value: `ETB ${stats.totalIncome.toFixed(2)}` },
                    { label: 'Net Profit', value: `ETB ${stats.netProfit.toFixed(2)}` },
                  ].map(kpi => (
                    <div key={kpi.label} className="rounded-lg border bg-muted/30 p-3 space-y-1">
                      <p className="text-xs text-muted-foreground">{kpi.label}</p>
                      <p className="text-sm font-semibold">{kpi.value}</p>
                    </div>
                  ))}
                </div>

                {/* Transactions Table */}
                <div>
                  <h4 className="text-sm font-semibold mb-3">All Transactions</h4>
                  {sales.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8 text-sm">No transactions in the selected period</p>
                  ) : (
                    <div className="overflow-x-auto rounded-md border">
                      <Table className="min-w-[700px]">
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead className="font-semibold text-xs">Date & Time</TableHead>
                            <TableHead className="font-semibold text-xs">Items</TableHead>
                            <TableHead className="font-semibold text-xs">Sold By</TableHead>
                            <TableHead className="font-semibold text-xs">Payment</TableHead>
                            <TableHead className="font-semibold text-xs text-right">Discount</TableHead>
                            <TableHead className="font-semibold text-xs text-right">Amount</TableHead>
                            <TableHead className="font-semibold text-xs text-center">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedSales.map((sale, idx) => {
                            const itemNames = sale.sale_items?.map(si => {
                              const name = si.medicines?.name || 'Unknown';
                              const medId = (si as any).medicine_id || si.medicines?.id;
                              const pkg = medId ? packagingMap[medId] : undefined;
                              const f = formatSaleItem(si, pkg);
                              if (!f.qty) return name;
                              const qtyStr = f.qty % 1 === 0 ? f.qty : f.qty.toFixed(2);
                              const detail = f.level !== 'unit' && f.baseUnits > 0
                                ? ` (${f.baseUnits} ${pluralLabel(f.baseLabel, f.baseUnits)})`
                                : '';
                              return `${name} ×${qtyStr} ${pluralLabel(f.levelLabel, f.qty)}${detail}`;
                            }).join(', ') || '—';

                            const isPaid = Number(sale.total_amount) <= ((sale as any).amount_paid || 0);
                            const isPartial = !isPaid && ((sale as any).amount_paid || 0) > 0;

                            return (
                              <TableRow key={sale.id} className={idx % 2 === 0 ? '' : 'bg-muted/20'}>
                                <TableCell className="text-xs whitespace-nowrap">
                                  <div>{new Date((sale as any).sale_date || sale.created_at).toLocaleDateString()}</div>
                                  <div className="text-muted-foreground">{new Date(sale.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                                </TableCell>
                                <TableCell className="text-xs max-w-[200px]">
                                  <div className="truncate" title={itemNames}>{itemNames}</div>
                                </TableCell>
                                <TableCell className="text-xs">
                                  {sale.seller ? (
                                    <span>{sale.seller.role === 'owner' ? 'Owner' : 'Staff'}<br /><span className="text-muted-foreground">{sale.seller.full_name}</span></span>
                                  ) : '—'}
                                </TableCell>
                                <TableCell className="text-xs">{(sale as any).payment_method || '—'}</TableCell>
                                <TableCell className="text-xs text-right">
                                  {Number(sale.discount_amount) > 0 ? (
                                    <span className="text-success">−ETB {Number(sale.discount_amount).toFixed(2)}</span>
                                  ) : '—'}
                                </TableCell>
                                <TableCell className="text-xs text-right font-semibold">
                                  ETB {Number(sale.total_amount).toFixed(2)}
                                </TableCell>
                                <TableCell className="text-xs text-center">
                                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${isPaid ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : isPartial ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                                    {isPaid ? 'Paid' : isPartial ? 'Partial' : 'Unpaid'}
                                  </span>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {renderPagination(salesPage, sales.length, setSalesPage)}
                  <p className="text-xs text-muted-foreground text-center pt-2">
                    {sales.length} transaction(s) · Total: ETB {stats.totalIncome.toFixed(2)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

          </Tabs>
        </>
      )}
    </div>
  );
}
