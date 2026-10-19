import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Package, CalendarDays, Settings2 } from 'lucide-react';
import { supabase } from '@/lib/db';
import { useToast } from '@/hooks/use-toast';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useBranchContext } from '@/hooks/useBranchContext';
import { useAuth } from '@/hooks/useAuth';
import { useExpiryThreshold } from '@/hooks/useExpiryThreshold';
import { useLowStockThreshold } from '@/hooks/useLowStockThreshold';
import { syncBranchItemQuantity } from '@/lib/batchInventory';

interface AlertItem {
  id: string;
  name: string;
  category: string;
  quantity: number;
  minimum_stock_level?: number;
  expiry_date?: string;
}

interface BatchAlertItem {
  batch_id: string;
  branch_item_id: string;
  name: string;
  category: string;
  batch_number: string | null;
  quantity: number;
  expiry_date: string;
  alert_days: number;          // resolved alert window (per-batch or global)
  per_batch_alert: boolean;    // true if alert_days came from the batch
}

interface BatchLowStockItem {
  batch_id: string;
  branch_item_id: string;
  name: string;
  category: string;
  batch_number: string | null;
  quantity: number;
  min_stock_level: number;
}

export default function InventoryDashboard() {
  const [outOfStockItems, setOutOfStockItems] = useState<AlertItem[]>([]);
  const [lowStockItems, setLowStockItems] = useState<AlertItem[]>([]);
  const [batchLowStock, setBatchLowStock] = useState<BatchLowStockItem[]>([]);
  const [expiringBatches, setExpiringBatches] = useState<BatchAlertItem[]>([]);
  const [expiredBatches, setExpiredBatches] = useState<BatchAlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    batchId: string;
    branchItemId: string;
    itemName: string;
    batchNumber: string | null;
  }>({ open: false, batchId: '', branchItemId: '', itemName: '', batchNumber: null });
  const { toast } = useToast();
  const { selectedBranch, branchType } = useBranchContext();
  const { profile } = useAuth();
  const { days: thresholdDays, setDays: setThresholdDays, defaultDays } = useExpiryThreshold();
  const { threshold: lowStockThreshold, setThreshold: setLowStockThreshold, defaultThreshold: defaultLowStock } = useLowStockThreshold();
  const [thresholdInput, setThresholdInput] = useState<string>(String(thresholdDays));
  const [lowStockInput, setLowStockInput] = useState<string>(String(lowStockThreshold));
  const isPharmacy = branchType === 'pharmacy';

  useEffect(() => { setThresholdInput(String(thresholdDays)); }, [thresholdDays]);
  useEffect(() => { setLowStockInput(String(lowStockThreshold)); }, [lowStockThreshold]);

  useEffect(() => {
    fetchInventoryData();
  }, [selectedBranch, thresholdDays, lowStockThreshold]);

  // Removed table-wide realtime: every stock UPDATE anywhere in the system
  // (all owners) re-downloaded this whole alerts dataset. Alerts now refresh
  // on branch/threshold change and on the global pull-to-refresh event.
  useEffect(() => {
    const handler = () => fetchInventoryData();
    window.addEventListener('app:refresh', handler);
    return () => window.removeEventListener('app:refresh', handler);
  }, [selectedBranch, thresholdDays, lowStockThreshold]);

  const fetchInventoryData = async () => {
    try {
      let ownerBranchIds: string[] = [];
      if (!selectedBranch && profile?.role === 'owner' && profile?.id) {
        const { data: ownerBranches } = await supabase
          .from('pharmacy_branches')
          .select('id')
          .eq('pharmacy_owner_id', profile.id);
        ownerBranchIds = (ownerBranches || []).map((b: any) => b.id);
      }

      if (!selectedBranch && ownerBranchIds.length === 0 && profile?.role === 'owner') {
        setOutOfStockItems([]); setLowStockItems([]); setBatchLowStock([]); setExpiringBatches([]); setExpiredBatches([]);
        setLoading(false);
        return;
      }

      // Parent-level stock for out-of-stock/low-stock
      let query = supabase
        .from('branch_items')
        .select('id, quantity, medicines!inner(name, category, minimum_stock_level)');

      if (selectedBranch) query = query.eq('branch_id', selectedBranch);
      else if (ownerBranchIds.length > 0) query = query.in('branch_id', ownerBranchIds);

      const { data, error } = await query;
      if (error) throw error;

      const items = (data || []).map((bi: any) => ({
        id: bi.id,
        name: bi.medicines?.name || 'Unknown',
        category: bi.medicines?.category || 'Uncategorized',
        quantity: Number(bi.quantity) || 0,
        minimum_stock_level: bi.medicines?.minimum_stock_level || 0,
      }));

      setOutOfStockItems(items.filter(i => i.quantity === 0));
      setLowStockItems(items.filter(i => {
        if (i.quantity <= 0) return false;
        const effectiveMin = (i.minimum_stock_level && i.minimum_stock_level > 0) ? i.minimum_stock_level : lowStockThreshold;
        return effectiveMin > 0 && i.quantity <= effectiveMin;
      }));

      // Batch-level expiry + per-batch overrides
      let batchQuery = supabase
        .from('inventory_batches')
        .select('id, branch_item_id, batch_number, remaining_quantity, expiry_date, min_stock_level, expiry_alert_days, medicines!inner(name, category)')
        .gt('remaining_quantity', 0);

      if (selectedBranch) batchQuery = batchQuery.eq('branch_id', selectedBranch);
      else if (ownerBranchIds.length > 0) batchQuery = batchQuery.in('branch_id', ownerBranchIds);

      const { data: batchRows } = await batchQuery;

      const today = new Date().toISOString().split('T')[0];
      const now = Date.now();

      const allBatches = ((batchRows || []) as any[]).filter(b => b.branch_item_id);

      // Per-batch low-stock alerts (only batches with min_stock_level configured)
      const lowStockBatches: BatchLowStockItem[] = allBatches
        .filter(b => b.min_stock_level != null && Number(b.remaining_quantity) <= Number(b.min_stock_level))
        .map(b => ({
          batch_id: b.id,
          branch_item_id: b.branch_item_id,
          name: b.medicines?.name || 'Unknown',
          category: b.medicines?.category || 'Uncategorized',
          batch_number: b.batch_number,
          quantity: Number(b.remaining_quantity) || 0,
          min_stock_level: Number(b.min_stock_level) || 0,
        }))
        .sort((a, b) => a.quantity - b.quantity);
      setBatchLowStock(lowStockBatches);

      // Expiry alerts — per-batch override of alert window when set
      const mappedBatches: BatchAlertItem[] = allBatches
        .filter(b => b.expiry_date)
        .map(b => {
          const perBatch = b.expiry_alert_days != null ? Number(b.expiry_alert_days) : null;
          const alertDays = perBatch != null ? perBatch : thresholdDays;
          return {
            batch_id: b.id,
            branch_item_id: b.branch_item_id,
            name: b.medicines?.name || 'Unknown',
            category: b.medicines?.category || 'Uncategorized',
            batch_number: b.batch_number,
            quantity: Number(b.remaining_quantity) || 0,
            expiry_date: b.expiry_date,
            alert_days: alertDays,
            per_batch_alert: perBatch != null,
          };
        })
        .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));

      const expiring = mappedBatches.filter(b => {
        if (b.expiry_date <= today) return false;
        const days = Math.ceil((new Date(b.expiry_date).getTime() - now) / 86_400_000);
        return days <= b.alert_days;
      });
      setExpiringBatches(expiring);
      setExpiredBatches(mappedBatches.filter(b => b.expiry_date <= today));
    } catch (error) {
      console.error('Error fetching inventory data:', error);
      toast({ title: "Error", description: "Failed to fetch inventory data", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveExpiredBatch = (batch: BatchAlertItem) => {
    setDeleteConfirm({
      open: true,
      batchId: batch.batch_id,
      branchItemId: batch.branch_item_id,
      itemName: batch.name,
      batchNumber: batch.batch_number,
    });
  };

  const confirmRemoveExpiredItem = async () => {
    try {
      // Try to delete the expired batch entirely so it disappears from
      // inventory and stops triggering expiry alerts. If a sale_item_batches
      // FK blocks deletion (historical sale linkage), fall back to setting
      // remaining_quantity to 0 so audit data is preserved.
      const { error: delError } = await supabase
        .from('inventory_batches')
        .delete()
        .eq('id', deleteConfirm.batchId);

      if (delError) {
        const { error: updError } = await supabase
          .from('inventory_batches')
          .update({ remaining_quantity: 0 })
          .eq('id', deleteConfirm.batchId);
        if (updError) throw updError;
      }

      if (deleteConfirm.branchItemId) {
        await syncBranchItemQuantity(deleteConfirm.branchItemId);
      }

      setExpiredBatches(expiredBatches.filter(b => b.batch_id !== deleteConfirm.batchId));
      toast({ title: "Success", description: "Expired batch removed from inventory" });
      setDeleteConfirm({ open: false, batchId: '', branchItemId: '', itemName: '', batchNumber: null });
    } catch (error) {
      console.error('Error removing expired batch:', error);
      toast({ title: "Error", description: "Failed to remove expired batch", variant: "destructive" });
    }
  };

  if (loading) {
    return <div>Loading inventory data...</div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="expiry-threshold" className="flex items-center gap-2 mb-1">
                <Settings2 className="h-4 w-4" />
                Expiry alert threshold
              </Label>
              <p className="text-xs text-muted-foreground">
                Items expiring within this many days will appear in alerts. Default: {defaultDays} days (≈ 2 months).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id="expiry-threshold"
                type="number"
                min={1}
                max={365}
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">days</span>
              <Button
                size="sm"
                onClick={() => {
                  const n = parseInt(thresholdInput, 10);
                  if (Number.isFinite(n) && n > 0) setThresholdDays(n);
                  else setThresholdInput(String(thresholdDays));
                }}
              >
                Save
              </Button>
              {thresholdDays !== defaultDays && (
                <Button size="sm" variant="ghost" onClick={() => setThresholdDays(defaultDays)}>
                  Reset
                </Button>
              )}
            </div>
          </div>

          <div className="mt-4 pt-4 border-t flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="low-stock-threshold" className="flex items-center gap-2 mb-1">
                <Settings2 className="h-4 w-4" />
                Default low-stock threshold
              </Label>
              <p className="text-xs text-muted-foreground">
                Applied to items that do not have their own minimum stock level configured. Default: {defaultLowStock} units.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id="low-stock-threshold"
                type="number"
                min={0}
                max={100000}
                step="0.01"
                value={lowStockInput}
                onChange={(e) => setLowStockInput(e.target.value)}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">units</span>
              <Button
                size="sm"
                onClick={() => {
                  const n = parseFloat(lowStockInput);
                  if (Number.isFinite(n) && n >= 0) setLowStockThreshold(n);
                  else setLowStockInput(String(lowStockThreshold));
                }}
              >
                Save
              </Button>
              {lowStockThreshold !== defaultLowStock && (
                <Button size="sm" variant="ghost" onClick={() => setLowStockThreshold(defaultLowStock)}>
                  Reset
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {outOfStockItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Package className="h-5 w-5 text-destructive" />
              <span>Out of Stock Products</span>
            </CardTitle>
            <CardDescription>{outOfStockItems.length} products are currently out of stock</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {outOfStockItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between p-2 border rounded-lg">
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="text-sm text-muted-foreground">{item.category}</p>
                  </div>
                  <Badge variant="destructive">Out of Stock</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {lowStockItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              <span>Low Stock Items</span>
            </CardTitle>
            <CardDescription>{lowStockItems.length} items are running low on stock</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {lowStockItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between p-2 border rounded-lg">
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="text-sm text-muted-foreground">{item.category}</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">{item.quantity} left</Badge>
                    <p className="text-xs text-muted-foreground">Min: {item.minimum_stock_level}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {batchLowStock.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              <span>Low Stock Batches</span>
            </CardTitle>
            <CardDescription>{batchLowStock.length} batch{batchLowStock.length !== 1 ? 'es' : ''} reached the per-batch low-stock threshold set in Edit Item → Batches</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {batchLowStock.map((b) => (
                <div key={b.batch_id} className="flex items-center justify-between p-2 border rounded-lg">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{b.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {b.category} · Batch: <span className="font-mono">{b.batch_number || '—'}</span>
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge variant="secondary">{b.quantity} left</Badge>
                    <p className="text-xs text-muted-foreground">Batch min: {b.min_stock_level}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {expiringBatches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <CalendarDays className="h-5 w-5 text-warning" />
              <span>Items Expiring Soon</span>
            </CardTitle>
            <CardDescription>
              {expiringBatches.length} batch{expiringBatches.length !== 1 ? 'es' : ''} within their alert window
              {' '}(global default: {thresholdDays} days; some batches use a custom window).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {expiringBatches.map((b) => {
                const daysLeft = Math.ceil((new Date(b.expiry_date).getTime() - Date.now()) / 86_400_000);
                return (
                  <div key={b.batch_id} className="flex items-center justify-between p-2 border rounded-lg">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{b.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {b.category} · Batch: <span className="font-mono">{b.batch_number || '—'}</span>
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <Badge variant="secondary">{b.quantity} in stock</Badge>
                      <p className="text-xs text-warning">
                        Expires: {new Date(b.expiry_date).toLocaleDateString()} ({daysLeft}d left)
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Alert: {b.alert_days}d {b.per_batch_alert ? '(batch override)' : '(global)'}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {expiredBatches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <span>Expired Items</span>
            </CardTitle>
            <CardDescription>{expiredBatches.length} batch{expiredBatches.length !== 1 ? 'es' : ''} have expired and should be removed</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {expiredBatches.map((b) => (
                <div key={b.batch_id} className="flex items-center justify-between p-2 border rounded-lg bg-destructive/5">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{b.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {b.category} · Batch: <span className="font-mono">{b.batch_number || '—'}</span>
                    </p>
                    <p className="text-xs text-destructive">
                      Expired: {new Date(b.expiry_date).toLocaleDateString()} · Stock: {b.quantity}
                    </p>
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    <Badge variant="destructive">Expired</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRemoveExpiredBatch(b)}
                      className="text-destructive hover:text-destructive"
                    >
                      Remove Batch
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {outOfStockItems.length === 0 && lowStockItems.length === 0 && batchLowStock.length === 0 &&
       expiringBatches.length === 0 && expiredBatches.length === 0 && (
        <Card>
          <CardContent className="text-center py-8">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">All Good!</h3>
            <p className="text-muted-foreground">
              No inventory issues detected. All products are well-stocked and within expiry dates.
            </p>
          </CardContent>
        </Card>
      )}

      <ConfirmationDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}
        title="Remove Expired Batch"
        description={`Remove batch "${deleteConfirm.batchNumber || '—'}" of "${deleteConfirm.itemName}" from inventory? This will stop expiry alerts for this batch. Sale history is preserved.`}
        onConfirm={confirmRemoveExpiredItem}
        confirmText="Remove"
        cancelText="Cancel"
      />
    </div>
  );
}
