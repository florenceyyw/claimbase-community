import { useState, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { 
  useListClaimPeriods, useListReceipts, useListCompanies, useListCategories,
  useCreateClaimPeriod, useGenerateClaimForm, useUpdateReceipt, useDeleteReceipt,
  ClaimPeriodResponse, getExchangeRate, ReceiptResponse
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { FileText, Download, CheckCircle2, Clock, ArrowLeft, Receipt, Plus, AlertCircle, RefreshCw, Loader2, ArrowRightLeft, Pencil, Trash2, Save, X, ChevronRight, Eye, Image, Send, CheckCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format, subMonths } from "date-fns";

interface RateOverride {
  receiptId: number;
  rate: string;
}

export default function Claims() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [selectedClaimId, setSelectedClaimId] = useState<number | null>(null);
  const [pendingDetail, setPendingDetail] = useState<{ companyId: number; monthKey: string } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  
  const [currencyDialogOpen, setCurrencyDialogOpen] = useState(false);
  const [rateOverrides, setRateOverrides] = useState<RateOverride[]>([]);
  const [isRefreshingRates, setIsRefreshingRates] = useState(false);
  const [regeneratingPeriodId, setRegeneratingPeriodId] = useState<number | null>(null);
  const [pendingClaimData, setPendingClaimData] = useState<{
    companyId: number;
    periodLabel: string;
    periodStart: string;
    periodEnd: string;
  } | null>(null);

  const [editingReceiptId, setEditingReceiptId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<{
    description: string;
    amount: string;
    currency: string;
    receiptDate: string;
    categoryId: string;
    conversionRate: string;
  }>({ description: "", amount: "", currency: "", receiptDate: "", categoryId: "", conversionRate: "1" });
  
  const { data: claims = [], isLoading, refetch } = useListClaimPeriods(user!.id);
  const selectedClaim = useMemo(() => selectedClaimId ? claims.find(c => c.id === selectedClaimId) || null : null, [selectedClaimId, claims]);
  const { data: allReceipts = [], refetch: refetchReceipts } = useListReceipts(user!.id, undefined, {
    query: { refetchInterval: 10_000 }
  });
  const { data: companies = [] } = useListCompanies(user!.id);
  const { data: categories = [] } = useListCategories({ userId: user!.id });

  const createMutation = useCreateClaimPeriod({
    mutation: {
      onSuccess: () => {
        refetch();
        refetchReceipts();
        setCreateDialogOpen(false);
        setCurrencyDialogOpen(false);
        setSelectedCompanyId("");
        setSelectedMonth("");
        setPendingClaimData(null);
        setRateOverrides([]);
        toast({ title: "Claim form generated successfully" });
      },
      onError: (err: any) => {
        const msg = err?.data?.error || err?.message || "Failed to create claim";
        toast({ title: msg, variant: "destructive" });
      }
    }
  });

  const regenerateMutation = useGenerateClaimForm({
    mutation: {
      onSuccess: () => {
        refetch();
        refetchReceipts();
        setCurrencyDialogOpen(false);
        setRegeneratingPeriodId(null);
        setPendingClaimData(null);
        setRateOverrides([]);
        toast({ title: "Claim form regenerated" });
      },
      onError: () => {
        toast({ title: "Failed to regenerate", variant: "destructive" });
      }
    }
  });

  const updateReceiptMutation = useUpdateReceipt({
    mutation: {
      onSuccess: () => {
        refetchReceipts();
        refetch();
        setEditingReceiptId(null);
        toast({ title: "Receipt updated" });
      },
      onError: () => {
        toast({ title: "Failed to update receipt", variant: "destructive" });
      }
    }
  });

  const deleteReceiptMutation = useDeleteReceipt({
    mutation: {
      onSuccess: () => {
        refetchReceipts();
        refetch();
        toast({ title: "Receipt deleted" });
      },
      onError: () => {
        toast({ title: "Failed to delete receipt", variant: "destructive" });
      }
    }
  });

  const [selectedReceiptIds, setSelectedReceiptIds] = useState<Set<number>>(new Set());

  const getUnclaimedReceiptsForMonth = (companyId: number, periodLabel: string) => {
    return allReceipts.filter(r =>
      r.companyId === companyId &&
      r.receiptDate &&
      (r.claimMonth ? r.claimMonth === periodLabel : r.receiptDate.slice(0, 7) === periodLabel) &&
      !r.claimPeriodId
    );
  };

  const getClaimedReceiptsForPeriod = (claimPeriodId: number) => {
    return allReceipts.filter(r => r.claimPeriodId === claimPeriodId);
  };

  const toggleReceiptSelection = (id: number) => {
    setSelectedReceiptIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllReceipts = (receiptIds: number[]) => {
    setSelectedReceiptIds(prev => {
      const allSelected = receiptIds.every(id => prev.has(id));
      if (allSelected) return new Set();
      return new Set(receiptIds);
    });
  };

  const handleSubmitClaim = async (periodId: number) => {
    try {
      const res = await fetch(`/api/claim-periods/${periodId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const errData = await res.json();
        toast({ title: errData?.error || "Failed to update status", variant: "destructive" });
        return;
      }
      const data = await res.json();
      toast({ title: data.message });
      refetch();
    } catch {
      toast({ title: "Failed to update submission status", variant: "destructive" });
    }
  };

  const handleDeleteClaim = async (periodId: number) => {
    if (!confirm("Delete this claim? Receipts will be released back as unclaimed.")) return;
    try {
      const res = await fetch(`/api/claim-periods/${periodId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const errData = await res.json();
        toast({ title: errData?.error || "Failed to delete claim", variant: "destructive" });
        return;
      }
      toast({ title: "Claim deleted" });
      setSelectedClaimId(null);
      refetch();
    } catch {
      toast({ title: "Failed to delete claim", variant: "destructive" });
    }
  };

  const getCalendarMonthBounds = (periodLabel: string) => {
    const [year, month] = periodLabel.split("-").map(Number) as [number, number];
    const lastDay = new Date(year, month, 0).getDate();
    return {
      periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
      periodEnd: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    };
  };

  const handleCreateClaim = () => {
    if (!selectedCompanyId || !selectedMonth) return;

    const company = companies.find(c => c.id === parseInt(selectedCompanyId));
    if (!company) return;

    const { periodStart, periodEnd } = getCalendarMonthBounds(selectedMonth);
    const periodReceipts = allReceipts.filter(r => {
      if (r.companyId !== parseInt(selectedCompanyId) || r.claimPeriodId || !r.receiptDate) return false;
      if (r.claimMonth) return r.claimMonth === selectedMonth;
      return r.receiptDate >= periodStart && r.receiptDate <= periodEnd;
    });

    const selectedReceipts = selectedReceiptIds.size > 0
      ? allReceipts.filter(r => r.companyId === parseInt(selectedCompanyId) && !r.claimPeriodId && selectedReceiptIds.has(r.id))
      : periodReceipts;

    if (selectedReceipts.length === 0) {
      toast({
        title: "No receipts selected",
        description: "Please select at least one receipt to include in the claim.",
        variant: "destructive"
      });
      return;
    }

    const claimData = {
      companyId: parseInt(selectedCompanyId),
      periodLabel: selectedMonth,
      periodStart,
      periodEnd,
    };

    setPendingClaimData(claimData);
    setRateOverrides(selectedReceipts.map(r => ({
      receiptId: r.id,
      rate: r.conversionRate,
    })));
    setCreateDialogOpen(false);
    setCurrencyDialogOpen(true);
  };

  const handleConfirmCurrency = () => {
    if (!pendingClaimData) return;
    const overridesPayload = rateOverrides.map(o => ({
      receiptId: o.receiptId,
      rate: o.rate,
    }));
    if (regeneratingPeriodId) {
      regenerateMutation.mutate({
        periodId: regeneratingPeriodId,
        data: {
          format: 'both',
          rateOverrides: overridesPayload,
        }
      });
    } else {
      createMutation.mutate({
        userId: user!.id,
        data: {
          ...pendingClaimData,
          receiptIds: rateOverrides.map(o => o.receiptId),
          rateOverrides: overridesPayload,
        }
      });
    }
  };

  const handleRegenerate = (claim: ClaimPeriodResponse) => {
    const claimReceipts = getClaimedReceiptsForPeriod(claim.id);
    if (claimReceipts.length === 0) {
      regenerateMutation.mutate({ periodId: claim.id, data: { format: 'both' } });
      return;
    }
    const { periodStart, periodEnd } = getCalendarMonthBounds(claim.periodLabel);
    setPendingClaimData({
      companyId: claim.companyId,
      periodLabel: claim.periodLabel,
      periodStart,
      periodEnd,
    });
    setRateOverrides(claimReceipts.map(r => ({
      receiptId: r.id,
      rate: r.conversionRate,
    })));
    setRegeneratingPeriodId(claim.id);
    setCurrencyDialogOpen(true);
  };

  const periodReceipts = useMemo(() => {
    if (!pendingClaimData) return [];
    if (regeneratingPeriodId) {
      return allReceipts.filter(r => r.claimPeriodId === regeneratingPeriodId);
    }
    const unclaimed = allReceipts.filter(r => r.companyId === pendingClaimData.companyId && !r.claimPeriodId);
    if (selectedReceiptIds.size > 0) {
      return unclaimed.filter(r => selectedReceiptIds.has(r.id));
    }
    return unclaimed;
  }, [pendingClaimData, allReceipts, selectedReceiptIds, regeneratingPeriodId]);

  const currencyTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    let grandTotal = 0;

    for (const r of periodReceipts) {
      const override = rateOverrides.find(o => o.receiptId === r.id);
      const rate = override ? parseFloat(override.rate) : parseFloat(r.conversionRate);
      const amount = parseFloat(r.amount);
      const converted = amount * (isNaN(rate) ? 1 : rate);
      
      const curr = r.currency;
      totals[curr] = (totals[curr] || 0) + amount;
      grandTotal += isNaN(converted) ? amount : converted;
    }

    return { byCurrency: totals, grandTotal };
  }, [periodReceipts, rateOverrides]);

  const handleRefreshAllRates = async () => {
    if (!pendingClaimData) return;
    const company = companies.find(c => c.id === pendingClaimData.companyId);
    if (!company) return;

    setIsRefreshingRates(true);
    try {
      const uniqueCurrencies = [...new Set(periodReceipts.map(r => r.currency))].filter(c => c !== company.baseCurrency);
      const rateMap: Record<string, number> = {};

      for (const curr of uniqueCurrencies) {
        try {
          const rateData = await getExchangeRate({ from: curr, to: company.baseCurrency });
          rateMap[curr] = rateData.rate;
        } catch {
          rateMap[curr] = 1;
        }
      }

      setRateOverrides(prev => prev.map(o => {
        const receipt = periodReceipts.find(r => r.id === o.receiptId);
        if (!receipt) return o;
        if (receipt.currency === company.baseCurrency) return { ...o, rate: "1" };
        const newRate = rateMap[receipt.currency];
        return newRate !== undefined ? { ...o, rate: newRate.toString() } : o;
      }));

      toast({ title: "Exchange rates refreshed" });
    } catch {
      toast({ title: "Failed to refresh rates", variant: "destructive" });
    } finally {
      setIsRefreshingRates(false);
    }
  };

  const updateRateOverride = (receiptId: number, newRate: string) => {
    setRateOverrides(prev => prev.map(o =>
      o.receiptId === receiptId ? { ...o, rate: newRate } : o
    ));
  };

  const handleDownload = async (periodId: number, fmt: 'pdf' | 'excel' | 'receipt-proofs') => {
    try {
      const label = fmt === 'receipt-proofs' ? 'Receipt Proofs' : fmt.toUpperCase();
      toast({ title: `Preparing ${label}...` });
      const url = `/api/claim-periods/${periodId}/download/${fmt}`;
      const res = await fetch(url);
      if (!res.ok) {
        let errorMsg = "Download failed";
        try {
          const errData = await res.json();
          if (errData?.error) errorMsg = errData.error;
        } catch {}
        toast({ title: errorMsg, variant: "destructive" });
        return;
      }
      
      const blob = await res.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      const ext = fmt === 'excel' ? 'xlsx' : 'pdf';
      a.download = fmt === 'receipt-proofs' ? `Receipt_Proofs_${periodId}.pdf` : `Claim_${periodId}.${ext}`;
      a.click();
      window.URL.revokeObjectURL(objectUrl);
      refetch();
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    }
  };

  const getClaimReceipts = (claim: ClaimPeriodResponse) => {
    return getClaimedReceiptsForPeriod(claim.id);
  };

  const monthOptions = useMemo(() => {
    const currentMonth = format(new Date(), 'yyyy-MM');
    const monthSet = new Set<string>([currentMonth]);

    for (let i = 1; i < 12; i++) {
      monthSet.add(format(subMonths(new Date(), i), 'yyyy-MM'));
    }

    if (selectedCompanyId) {
      const companyId = parseInt(selectedCompanyId);
      allReceipts.forEach(r => {
        if (r.companyId === companyId && !r.claimPeriodId && r.receiptDate) {
          const effectiveMonth = r.claimMonth || r.receiptDate.slice(0, 7);
          monthSet.add(effectiveMonth);
        }
      });
    }

    const months = Array.from(monthSet).sort().reverse();

    if (!selectedCompanyId) return months.map(m => ({ value: m, receiptCount: 0 }));

    const companyId = parseInt(selectedCompanyId);
    return months.map(m => {
      const count = getUnclaimedReceiptsForMonth(companyId, m).length;
      return { value: m, receiptCount: count };
    });
  }, [selectedCompanyId, allReceipts]);

  const claimsByCompany = useMemo(() => {
    const grouped: Record<string, { company: typeof companies[0]; claims: ClaimPeriodResponse[]; pendingReceipts: ReceiptResponse[] }> = {};

    for (const claim of claims) {
      const key = String(claim.companyId);
      if (!grouped[key]) {
        const company = companies.find(c => c.id === claim.companyId);
        if (company) grouped[key] = { company, claims: [], pendingReceipts: [] };
      }
      if (grouped[key]) grouped[key].claims.push(claim);
    }

    for (const company of companies) {
      const key = String(company.id);
      const unclaimedReceipts = allReceipts.filter(r =>
        r.companyId === company.id && !r.claimPeriodId
      );
      if (!grouped[key]) {
        if (unclaimedReceipts.length > 0) {
          grouped[key] = { company, claims: [], pendingReceipts: unclaimedReceipts };
        }
      } else {
        grouped[key].pendingReceipts = unclaimedReceipts;
      }
    }

    return Object.values(grouped);
  }, [claims, companies, allReceipts]);

  const previewReceiptCount = useMemo(() => {
    if (!selectedCompanyId || !selectedMonth) return 0;
    if (selectedReceiptIds.size > 0) return selectedReceiptIds.size;
    const { periodStart, periodEnd } = getCalendarMonthBounds(selectedMonth);
    return allReceipts.filter(r => {
      if (r.companyId !== parseInt(selectedCompanyId) || r.claimPeriodId || !r.receiptDate) return false;
      if (r.claimMonth) return r.claimMonth === selectedMonth;
      return r.receiptDate >= periodStart && r.receiptDate <= periodEnd;
    }).length;
  }, [selectedCompanyId, selectedMonth, allReceipts, selectedReceiptIds]);

  const startEditReceipt = (receipt: ReceiptResponse) => {
    setEditingReceiptId(receipt.id);
    setEditForm({
      description: receipt.description,
      amount: receipt.amount,
      currency: receipt.currency,
      receiptDate: receipt.receiptDate,
      categoryId: receipt.categoryId ? String(receipt.categoryId) : "",
      conversionRate: receipt.conversionRate,
    });
  };

  const saveEditReceipt = (receipt: ReceiptResponse) => {
    const rate = parseFloat(editForm.conversionRate) || 1;
    const amount = parseFloat(editForm.amount) || 0;
    const convertedAmount = (amount * rate).toFixed(2);
    updateReceiptMutation.mutate({
      receiptId: receipt.id,
      data: {
        description: editForm.description,
        amount: editForm.amount,
        currency: editForm.currency,
        receiptDate: editForm.receiptDate,
        categoryId: editForm.categoryId ? parseInt(editForm.categoryId) : undefined,
        conversionRate: rate.toFixed(6),
        convertedAmount,
      }
    });
  };

  if (isLoading) return <div className="animate-pulse space-y-4"><div className="h-20 bg-muted rounded-xl" /></div>;

  if (selectedClaim) {
    const claimReceipts = getClaimReceipts(selectedClaim);
    const company = companies.find(c => c.id === selectedClaim.companyId);
    const totalConverted = claimReceipts.reduce((sum, r) => sum + parseFloat(r.convertedAmount || r.amount), 0);
    
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => { setSelectedClaimId(null); setEditingReceiptId(null); }}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-display font-bold">{selectedClaim.companyName}</h1>
            <p className="text-muted-foreground font-medium">
              {format(new Date(selectedClaim.periodLabel + '-01'), 'MMMM yyyy')} Claim
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border bg-card">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground font-medium">Total Amount</p>
              <p className="text-2xl font-bold mt-1 text-foreground">{totalConverted.toFixed(2)} {selectedClaim.baseCurrency}</p>
            </CardContent>
          </Card>
          <Card className="border bg-card">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground font-medium">Receipts</p>
              <p className="text-2xl font-bold mt-1 text-foreground">{claimReceipts.length}</p>
            </CardContent>
          </Card>
          <Card className="border bg-card">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground font-medium">Status</p>
              <p className="text-2xl font-bold mt-1 flex items-center gap-2 text-foreground">
                {selectedClaim.submittedAt ? (
                  <><CheckCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" /> Submitted</>
                ) : selectedClaim.downloadedAt ? (
                  <><Download className="w-5 h-5 text-blue-600 dark:text-blue-400" /> Downloaded</>
                ) : selectedClaim.status === 'completed' ? (
                  <><CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" /> Ready</>
                ) : selectedClaim.status === 'error' ? (
                  <><AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" /> Error</>
                ) : (
                  <><Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" /> {selectedClaim.status}</>
                )}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="flex gap-3 flex-wrap">
          <Button 
            variant="outline" 
            className="border-primary/20 hover:bg-primary/5 text-primary"
            disabled={selectedClaim.status !== 'completed'}
            onClick={() => handleDownload(selectedClaim.id, 'pdf')}
          >
            <Download className="w-4 h-4 mr-2" /> Download PDF
          </Button>
          <Button 
            variant="outline" 
            className="border-emerald-500/20 hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            disabled={selectedClaim.status !== 'completed'}
            onClick={() => handleDownload(selectedClaim.id, 'excel')}
          >
            <Download className="w-4 h-4 mr-2" /> Download Excel
          </Button>
          <Button
            variant="outline"
            className="border-violet-500/20 hover:bg-violet-500/10 text-violet-600 dark:text-violet-400"
            onClick={() => handleDownload(selectedClaim.id, 'receipt-proofs')}
          >
            <Image className="w-4 h-4 mr-2" /> Receipt Proofs
          </Button>
          <Button
            variant="outline"
            className="border-amber-500/20 hover:bg-amber-500/10 text-amber-600 dark:text-amber-400"
            disabled={regenerateMutation.isPending}
            onClick={() => handleRegenerate(selectedClaim)}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${regenerateMutation.isPending ? 'animate-spin' : ''}`} /> Regenerate
          </Button>
          {selectedClaim.status === 'completed' && (
            <Button
              variant={selectedClaim.submittedAt ? "default" : "outline"}
              className={selectedClaim.submittedAt 
                ? "bg-emerald-600 hover:bg-emerald-700 text-white" 
                : "border-emerald-500/20 hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              }
              onClick={() => handleSubmitClaim(selectedClaim.id)}
            >
              {selectedClaim.submittedAt ? (
                <><CheckCheck className="w-4 h-4 mr-2" /> Submitted</>
              ) : (
                <><Send className="w-4 h-4 mr-2" /> Mark as Submitted</>
              )}
            </Button>
          )}
        </div>

        <Card className="premium-shadow border border-border/60 rounded-2xl overflow-hidden">
          <CardHeader className="px-6 pt-5 pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-semibold">
              <Receipt className="w-4 h-4 text-primary" /> Receipts in this period
              <span className="text-sm font-normal text-muted-foreground ml-auto">Tap a receipt to edit</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {claimReceipts.length > 0 ? (
              <div className="divide-y divide-border">
                {claimReceipts.map((receipt, idx) => (
                  <div key={receipt.id} className="hover:bg-muted/30">
                    {editingReceiptId === receipt.id ? (
                      <div className="p-4 space-y-3 bg-primary/5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-primary">Editing Receipt #{idx + 1}</span>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingReceiptId(null)}>
                              <X className="w-3 h-3 mr-1" /> Cancel
                            </Button>
                            <Button size="sm" className="h-7 text-xs" onClick={() => saveEditReceipt(receipt)} disabled={updateReceiptMutation.isPending}>
                              <Save className="w-3 h-3 mr-1" /> {updateReceiptMutation.isPending ? "Saving..." : "Save"}
                            </Button>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Description</Label>
                            <Input
                              value={editForm.description}
                              onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Date</Label>
                            <Input
                              type="date"
                              value={editForm.receiptDate}
                              onChange={e => setEditForm(f => ({ ...f, receiptDate: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Amount</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={editForm.amount}
                              onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Currency</Label>
                            <Input
                              value={editForm.currency}
                              onChange={e => setEditForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))}
                              maxLength={3}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Category</Label>
                            <Select value={editForm.categoryId} onValueChange={v => setEditForm(f => ({ ...f, categoryId: v }))}>
                              <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                              <SelectContent>
                                {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Exchange Rate</Label>
                            <Input
                              type="number"
                              step="0.0001"
                              value={editForm.conversionRate}
                              onChange={e => setEditForm(f => ({ ...f, conversionRate: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                        </div>
                        {editForm.amount && editForm.conversionRate && (
                          <div className="text-xs text-muted-foreground">
                            Converted: {(parseFloat(editForm.amount) * parseFloat(editForm.conversionRate)).toFixed(2)} {company?.baseCurrency}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="p-4 flex items-center justify-between cursor-pointer" onClick={() => startEditReceipt(receipt)}>
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <span className="text-xs text-muted-foreground font-mono w-5 text-center flex-shrink-0">{idx + 1}</span>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold text-foreground truncate">{receipt.description}</h4>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                              <span>{receipt.receiptDate}</span>
                              {receipt.categoryName ? (
                                <>
                                  <span>·</span>
                                  <span className="text-primary">{receipt.categoryName}</span>
                                </>
                              ) : (
                                <>
                                  <span>·</span>
                                  <span className="text-amber-600 dark:text-amber-400 font-semibold">No category</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 ml-3">
                          <div className="text-right">
                            <div className="font-bold text-foreground">{receipt.currency} {receipt.amount}</div>
                            {receipt.conversionRate !== "1" && receipt.conversionRate !== "1.00" && receipt.conversionRate !== "1.000000" && (
                              <div className="text-xs text-muted-foreground">
                                → {company?.baseCurrency} {receipt.convertedAmount} (×{parseFloat(receipt.conversionRate).toFixed(4)})
                              </div>
                            )}
                          </div>
                          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" onClick={() => startEditReceipt(receipt)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => {
                              if (confirm("Delete this receipt?")) deleteReceiptMutation.mutate({ receiptId: receipt.id });
                            }}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <div className="p-4 bg-muted/50 flex justify-between items-center font-semibold">
                  <span className="text-foreground">Total ({claimReceipts.length} receipts)</span>
                  <span className="text-foreground text-lg">{totalConverted.toFixed(2)} {company?.baseCurrency}</span>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground">
                <Receipt className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No receipts found for this period.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (pendingDetail) {
    const pdCompany = companies.find(c => c.id === pendingDetail.companyId);
    const pdReceipts = allReceipts.filter(r =>
      r.companyId === pendingDetail.companyId &&
      r.receiptDate &&
      r.receiptDate.slice(0, 7) === pendingDetail.monthKey &&
      !r.claimPeriodId
    );
    const pdTotal = pdReceipts.reduce((sum, r) => sum + parseFloat(r.convertedAmount || r.amount), 0);

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => { setPendingDetail(null); setEditingReceiptId(null); }}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-display font-bold">{pdCompany?.name}</h1>
            <p className="text-muted-foreground font-medium">
              {format(new Date(pendingDetail.monthKey + '-01'), 'MMMM yyyy')} — Draft
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border bg-card">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground font-medium">Total Amount</p>
              <p className="text-2xl font-bold mt-1 text-foreground">{pdTotal.toFixed(2)} {pdCompany?.baseCurrency}</p>
            </CardContent>
          </Card>
          <Card className="border bg-card">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground font-medium">Receipts</p>
              <p className="text-2xl font-bold mt-1 text-foreground">{pdReceipts.length}</p>
            </CardContent>
          </Card>
          <Card className="border bg-card">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground font-medium">Status</p>
              <p className="text-2xl font-bold mt-1 flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <Clock className="w-5 h-5" /> Pending
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="flex gap-3 flex-wrap">
          <Button
            className="rounded-xl"
            onClick={() => {
              setPendingDetail(null);
              setSelectedCompanyId(String(pendingDetail.companyId));
              setSelectedMonth(pendingDetail.monthKey);
              setCreateDialogOpen(true);
            }}
          >
            <Plus className="w-4 h-4 mr-2" /> Generate Claim
          </Button>
        </div>

        <Card className="premium-shadow border border-border/60 rounded-2xl overflow-hidden">
          <CardHeader className="px-6 pt-5 pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-semibold">
              <Receipt className="w-4 h-4 text-primary" /> Receipts in this period
              <span className="text-sm font-normal text-muted-foreground ml-auto">Tap a receipt to edit</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {pdReceipts.length > 0 ? (
              <div className="divide-y divide-border">
                {pdReceipts.map((receipt, idx) => (
                  <div key={receipt.id} className="hover:bg-muted/30">
                    {editingReceiptId === receipt.id ? (
                      <div className="p-4 space-y-3 bg-primary/5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-primary">Editing Receipt #{idx + 1}</span>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingReceiptId(null)}>
                              <X className="w-3 h-3 mr-1" /> Cancel
                            </Button>
                            <Button size="sm" className="h-7 text-xs" onClick={() => saveEditReceipt(receipt)} disabled={updateReceiptMutation.isPending}>
                              <Save className="w-3 h-3 mr-1" /> {updateReceiptMutation.isPending ? "Saving..." : "Save"}
                            </Button>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Description</Label>
                            <Input
                              value={editForm.description}
                              onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Date</Label>
                            <Input
                              type="date"
                              value={editForm.receiptDate}
                              onChange={e => setEditForm(f => ({ ...f, receiptDate: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Amount</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={editForm.amount}
                              onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Currency</Label>
                            <Input
                              value={editForm.currency}
                              onChange={e => setEditForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))}
                              maxLength={3}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Category</Label>
                            <Select value={editForm.categoryId} onValueChange={v => setEditForm(f => ({ ...f, categoryId: v }))}>
                              <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                              <SelectContent>
                                {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Exchange Rate</Label>
                            <Input
                              type="number"
                              step="0.0001"
                              value={editForm.conversionRate}
                              onChange={e => setEditForm(f => ({ ...f, conversionRate: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                        </div>
                        {editForm.amount && editForm.conversionRate && (
                          <div className="text-xs text-muted-foreground">
                            Converted: {(parseFloat(editForm.amount) * parseFloat(editForm.conversionRate)).toFixed(2)} {pdCompany?.baseCurrency}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="p-4 flex items-center justify-between cursor-pointer" onClick={() => startEditReceipt(receipt)}>
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <span className="text-xs text-muted-foreground font-mono w-5 text-center flex-shrink-0">{idx + 1}</span>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold text-foreground truncate">{receipt.description}</h4>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                              <span>{receipt.receiptDate}</span>
                              {receipt.categoryName ? (
                                <>
                                  <span>·</span>
                                  <span className="text-primary">{receipt.categoryName}</span>
                                </>
                              ) : (
                                <>
                                  <span>·</span>
                                  <span className="text-amber-600 dark:text-amber-400 font-semibold">No category</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 ml-3">
                          <div className="text-right">
                            <div className="font-bold text-foreground">{receipt.currency} {receipt.amount}</div>
                            {receipt.conversionRate !== "1" && receipt.conversionRate !== "1.00" && receipt.conversionRate !== "1.000000" && (
                              <div className="text-xs text-muted-foreground">
                                → {pdCompany?.baseCurrency} {receipt.convertedAmount} (×{parseFloat(receipt.conversionRate).toFixed(4)})
                              </div>
                            )}
                          </div>
                          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" onClick={() => startEditReceipt(receipt)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-red-500"
                              onClick={() => {
                                if (confirm("Delete this receipt?")) deleteReceiptMutation.mutate({ receiptId: receipt.id });
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <div className="p-4 bg-muted/50 flex justify-between items-center font-semibold">
                  <span className="text-foreground">Total ({pdReceipts.length} receipts)</span>
                  <span className="text-foreground text-lg">{pdTotal.toFixed(2)} {pdCompany?.baseCurrency}</span>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground">
                <Receipt className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No receipts found for this period.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const pendingCompany = pendingClaimData ? companies.find(c => c.id === pendingClaimData.companyId) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-display font-bold">Claim Forms</h1>
        <Button className="rounded-xl text-sm" onClick={() => setCreateDialogOpen(true)} disabled={companies.length === 0}>
          <Plus className="mr-1.5 w-4 h-4" /> Generate Claim
        </Button>
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto w-[95vw] max-w-lg overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>Generate Claim Form</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={selectedCompanyId} onValueChange={v => { setSelectedCompanyId(v); setSelectedMonth(""); setSelectedReceiptIds(new Set()); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name} ({c.baseCurrency})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Claim Period</Label>
              <Select value={selectedMonth} onValueChange={v => { setSelectedMonth(v); setSelectedReceiptIds(new Set()); }} disabled={!selectedCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder={selectedCompanyId ? "Select claim period" : "Select a company first"} />
                </SelectTrigger>
                <SelectContent>
                  {monthOptions.map(({ value: m, receiptCount }) => (
                    <SelectItem key={m} value={m}>
                      <span className="flex items-center justify-between w-full gap-3">
                        <span>{format(new Date(m + '-01'), 'MMMM yyyy')}</span>
                        {receiptCount > 0 && (
                          <span className="text-xs text-green-600 dark:text-green-400">
                            {receiptCount} receipt{receiptCount > 1 ? 's' : ''}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedCompanyId && selectedMonth && (() => {
              const { periodStart: monthStart, periodEnd: monthEnd } = getCalendarMonthBounds(selectedMonth);
              const receiptsForPeriod = allReceipts.filter(r => {
                if (r.companyId !== parseInt(selectedCompanyId) || r.claimPeriodId || !r.receiptDate) return false;
                if (r.claimMonth) return r.claimMonth === selectedMonth;
                return r.receiptDate >= monthStart && r.receiptDate <= monthEnd;
              });
              const otherUnclaimed = allReceipts.filter(r => {
                if (r.companyId !== parseInt(selectedCompanyId) || r.claimPeriodId) return false;
                if (r.claimMonth) return r.claimMonth !== selectedMonth;
                return !r.receiptDate || r.receiptDate < monthStart || r.receiptDate > monthEnd;
              });
              const selectedCount = selectedReceiptIds.size > 0
                ? [...receiptsForPeriod, ...otherUnclaimed].filter(r => selectedReceiptIds.has(r.id)).length
                : receiptsForPeriod.length;
              const allPeriodSelected = receiptsForPeriod.length > 0 && receiptsForPeriod.every(r => selectedReceiptIds.has(r.id) || selectedReceiptIds.size === 0);
              return (
                <div className="space-y-2">
                  {receiptsForPeriod.length > 0 ? (
                    <>
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">
                          Receipts in {format(new Date(selectedMonth + '-01'), 'MMM yyyy')} ({selectedCount} selected)
                        </Label>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => toggleAllReceipts(receiptsForPeriod.map(r => r.id))}
                        >
                          {allPeriodSelected ? "Deselect All" : "Select All"}
                        </Button>
                      </div>
                      <div className="max-h-40 overflow-y-auto space-y-1 border rounded-lg p-2">
                        {receiptsForPeriod.map(r => (
                          <label key={r.id} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/50 cursor-pointer">
                            <Checkbox
                              className="mt-0.5 shrink-0"
                              checked={selectedReceiptIds.size === 0 || selectedReceiptIds.has(r.id)}
                              onCheckedChange={() => {
                                if (selectedReceiptIds.size === 0) {
                                  const allIds = new Set(receiptsForPeriod.map(rx => rx.id));
                                  allIds.delete(r.id);
                                  setSelectedReceiptIds(allIds);
                                } else {
                                  toggleReceiptSelection(r.id);
                                }
                              }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium break-words">{r.description || 'No description'}</p>
                              <p className="text-xs text-muted-foreground">
                                {r.receiptDate} · {r.currency} {parseFloat(r.amount).toFixed(2)}
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="p-3 rounded-lg text-sm bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300">
                      No unclaimed receipts in {format(new Date(selectedMonth + '-01'), 'MMMM yyyy')}.
                    </div>
                  )}
                  {otherUnclaimed.length > 0 && (
                    <details className="group">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground py-1">
                        + {otherUnclaimed.length} unclaimed receipt{otherUnclaimed.length !== 1 ? 's' : ''} from other months
                      </summary>
                      <div className="max-h-32 overflow-y-auto space-y-1 border rounded-lg p-2 mt-1">
                        {otherUnclaimed.map(r => (
                          <label key={r.id} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/50 cursor-pointer">
                            <Checkbox
                              className="mt-0.5 shrink-0"
                              checked={selectedReceiptIds.has(r.id)}
                              onCheckedChange={() => toggleReceiptSelection(r.id)}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium break-words">{r.description || 'No description'}</p>
                              <p className="text-xs text-muted-foreground">
                                {r.receiptDate || 'No date'} · {r.currency} {parseFloat(r.amount).toFixed(2)}
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })()}

            <Button
              className="w-full"
              onClick={handleCreateClaim}
              disabled={!selectedCompanyId || !selectedMonth || createMutation.isPending || previewReceiptCount === 0}
            >
              {createMutation.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Generating...</>
              ) : previewReceiptCount === 0 ? (
                "No receipts to claim"
              ) : (
                <>Review {selectedReceiptIds.size > 0 ? selectedReceiptIds.size : previewReceiptCount} receipt{(selectedReceiptIds.size > 0 ? selectedReceiptIds.size : previewReceiptCount) > 1 ? "s" : ""} &amp; Confirm</>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={currencyDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setCurrencyDialogOpen(false);
          setPendingClaimData(null);
          setRateOverrides([]);
          setRegeneratingPeriodId(null);
        }
      }}>
        <DialogContent className="max-w-2xl w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5 text-primary" />
              {regeneratingPeriodId ? "Review Currencies & Regenerate" : "Confirm Currencies & Rates"}
            </DialogTitle>
          </DialogHeader>

          {pendingCompany && (
            <div className="flex flex-col min-h-0 flex-1 gap-4">
              <div className="p-3 bg-muted rounded-xl shrink-0">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground font-medium">Company</span>
                  <span className="font-semibold text-foreground">{pendingCompany.name}</span>
                </div>
                <div className="flex justify-between items-center text-sm mt-1">
                  <span className="text-muted-foreground font-medium">Base Currency</span>
                  <span className="font-semibold text-foreground">{pendingCompany.baseCurrency}</span>
                </div>
                <div className="flex justify-between items-center text-sm mt-1">
                  <span className="text-muted-foreground font-medium">Period</span>
                  <span className="font-semibold text-foreground">
                    {pendingClaimData && format(new Date(pendingClaimData.periodLabel + '-01'), 'MMMM yyyy')}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm mt-1">
                  <span className="text-muted-foreground font-medium">Receipts</span>
                  <span className="font-semibold text-foreground">{periodReceipts.length}</span>
                </div>
              </div>

              {periodReceipts.some(r => r.currency !== pendingCompany.baseCurrency) && (
                <div className="flex items-center justify-between shrink-0">
                  <p className="text-sm text-muted-foreground">Foreign currency receipts detected</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    disabled={isRefreshingRates}
                    onClick={handleRefreshAllRates}
                  >
                    <RefreshCw className={`w-3 h-3 mr-1 ${isRefreshingRates ? 'animate-spin' : ''}`} />
                    {isRefreshingRates ? "Refreshing..." : "Refresh All Rates"}
                  </Button>
                </div>
              )}

              <div className="space-y-2 overflow-y-auto min-h-0 flex-1">
                {periodReceipts.map(receipt => {
                  const override = rateOverrides.find(o => o.receiptId === receipt.id);
                  const rate = override ? parseFloat(override.rate) : parseFloat(receipt.conversionRate);
                  const converted = (parseFloat(receipt.amount) * (isNaN(rate) ? 1 : rate)).toFixed(2);
                  const isForeign = receipt.currency !== pendingCompany.baseCurrency;

                  return (
                    <div key={receipt.id} className={`p-3 rounded-lg border ${isForeign ? "border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20" : "border-border bg-card"}`}>
                      <div className="mb-1">
                        <p className="text-sm font-semibold text-foreground break-words">{receipt.description}</p>
                        <div className="flex justify-between items-center mt-0.5">
                          <p className="text-xs text-muted-foreground">{receipt.receiptDate}{receipt.categoryName ? ` · ${receipt.categoryName}` : ""}</p>
                          <p className="text-sm font-bold text-foreground shrink-0 ml-3">{receipt.currency} {receipt.amount}</p>
                        </div>
                      </div>
                      {isForeign && (
                        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border/50">
                          <Label className="text-xs text-muted-foreground whitespace-nowrap">Rate:</Label>
                          <Input
                            type="number"
                            step="0.0001"
                            value={override?.rate ?? receipt.conversionRate}
                            onChange={(e) => updateRateOverride(receipt.id, e.target.value)}
                            className="h-7 text-xs w-24"
                          />
                          <span className="text-xs text-muted-foreground">=</span>
                          <span className="text-xs font-semibold text-foreground">{converted} {pendingCompany.baseCurrency}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="shrink-0 space-y-4">
                <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-foreground">Grand Total</span>
                    <span className="text-xl font-bold text-primary">{currencyTotals.grandTotal.toFixed(2)} {pendingCompany.baseCurrency}</span>
                  </div>
                  {Object.keys(currencyTotals.byCurrency).length > 1 && (
                    <div className="mt-2 pt-2 border-t border-primary/10 space-y-1">
                      {Object.entries(currencyTotals.byCurrency).map(([curr, amount]) => (
                        <div key={curr} className="flex justify-between text-xs text-muted-foreground">
                          <span>{curr}</span>
                          <span>{amount.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Button
                  className="w-full h-11"
                  onClick={handleConfirmCurrency}
                  disabled={regeneratingPeriodId ? regenerateMutation.isPending : createMutation.isPending}
                >
                  {(regeneratingPeriodId ? regenerateMutation.isPending : createMutation.isPending) ? (
                    <><Loader2 className="w-4 h-4 animate-spin mr-2" /> {regeneratingPeriodId ? "Regenerating..." : "Generating Claim..."}</>
                  ) : (
                    regeneratingPeriodId ? "Confirm & Regenerate" : "Confirm & Generate Claim"
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      
      {claimsByCompany.length > 0 ? (
        <div className="space-y-6">
          {claimsByCompany.map(({ company, claims: companyClaims, pendingReceipts }) => {
            const pendingMonths = new Map<string, ReceiptResponse[]>();
            for (const r of pendingReceipts) {
              if (!r.receiptDate) continue;
              const monthKey = r.receiptDate.slice(0, 7);
              if (!pendingMonths.has(monthKey)) pendingMonths.set(monthKey, []);
              pendingMonths.get(monthKey)!.push(r);
            }

            const periodLabelCounts = new Map<string, number>();
            for (const c of companyClaims) {
              periodLabelCounts.set(c.periodLabel, (periodLabelCounts.get(c.periodLabel) || 0) + 1);
            }
            const periodLabelIndex = new Map<string, number>();

            return (
              <div key={company.id} className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-foreground">{company.name}</h2>
                  <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-full">{company.baseCurrency}</span>
                </div>
                <div className="grid gap-3">
                  {companyClaims.map((claim) => {
                    const claimReceipts = getClaimReceipts(claim);
                    const hasPendingOverlap = pendingMonths.has(claim.periodLabel);
                    const claimCount = periodLabelCounts.get(claim.periodLabel) || 1;
                    const needsNumber = claimCount > 1 || hasPendingOverlap;
                    const idx = (periodLabelIndex.get(claim.periodLabel) || 0) + 1;
                    periodLabelIndex.set(claim.periodLabel, idx);
                    const claimTitle = needsNumber
                      ? `${format(new Date(claim.periodLabel + '-01'), 'MMMM yyyy')} (#${idx})`
                      : format(new Date(claim.periodLabel + '-01'), 'MMMM yyyy');
                    const isSubmitted = !!claim.submittedAt;
                    return (
                      <Card 
                        key={claim.id} 
                        className={`border premium-shadow transition-all cursor-pointer group ${isSubmitted ? 'bg-muted/50 opacity-60 hover:opacity-80' : 'bg-card hover:border-primary/30 hover:shadow-lg'}`}
                        onClick={() => setSelectedClaimId(claim.id)}
                      >
                        <CardContent className="p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
                          <div className="flex items-center gap-3 w-full sm:w-auto">
                            <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${isSubmitted ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-blue-100 dark:bg-blue-900/40'}`}>
                              {isSubmitted ? <CheckCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" /> : <FileText className="w-5 h-5 text-primary" />}
                            </div>
                            <div>
                              <h3 className="font-bold text-foreground">
                                {claimTitle}
                              </h3>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                                <span>{claimReceipts.length} receipt{claimReceipts.length !== 1 ? "s" : ""}</span>
                                <span>·</span>
                                {isSubmitted ? (
                                  <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCheck className="w-3 h-3"/> Submitted</span>
                                ) : claim.status === 'completed' ? (
                                  <span className="text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3"/> Ready</span>
                                ) : claim.status === 'error' ? (
                                  <span className="text-red-600 dark:text-red-400 flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Error</span>
                                ) : (
                                  <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1"><Clock className="w-3 h-3"/> {claim.status}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          
                          <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
                            <div className="text-right sm:mr-2">
                              <div className="font-bold text-lg text-foreground">
                                {claimReceipts.reduce((sum, r) => sum + parseFloat(r.convertedAmount || r.amount), 0).toFixed(2)}
                              </div>
                              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{claim.baseCurrency}</div>
                            </div>
                            
                            <div className="flex gap-2 w-full sm:w-auto items-center" onClick={(e) => e.stopPropagation()}>
                              {claim.status === 'completed' && (
                                <>
                                  <Button 
                                    variant="outline" 
                                    size="sm"
                                    className="flex-1 sm:flex-none border-primary/20 hover:bg-primary/5 text-primary text-xs"
                                    onClick={() => handleDownload(claim.id, 'pdf')}
                                  >
                                    <Download className="w-3.5 h-3.5 mr-1" /> PDF
                                  </Button>
                                  <Button 
                                    variant="outline" 
                                    size="sm"
                                    className="flex-1 sm:flex-none border-emerald-500/20 hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs"
                                    onClick={() => handleDownload(claim.id, 'excel')}
                                  >
                                    <Download className="w-3.5 h-3.5 mr-1" /> Excel
                                  </Button>
                                </>
                              )}
                              {claim.status === 'completed' && (
                                <label className="flex items-center gap-1.5 cursor-pointer px-1" title={isSubmitted ? "Unmark as submitted" : "Mark as submitted"}>
                                  <Checkbox checked={isSubmitted} onCheckedChange={() => handleSubmitClaim(claim.id)} />
                                  <span className="text-xs text-muted-foreground hidden sm:inline">Submitted</span>
                                </label>
                              )}
                              {(claimReceipts.length === 0 || claim.status === 'error') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  onClick={() => handleDeleteClaim(claim.id)}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                            
                            <div className="hidden sm:flex items-center text-muted-foreground group-hover:text-primary transition-colors">
                              <ChevronRight className="w-5 h-5" />
                            </div>
                          </div>
                        </CardContent>
                        <div className="sm:hidden px-4 pb-3">
                          <button className="w-full flex items-center justify-center gap-1.5 text-xs text-primary font-medium py-1.5 rounded-lg bg-primary/5 hover:bg-primary/10 transition-colors">
                            <Eye className="w-3.5 h-3.5" /> View claim details
                          </button>
                        </div>
                      </Card>
                    );
                  })}

                  {Array.from(pendingMonths.entries()).map(([monthKey, receipts]) => {
                    const total = receipts.reduce((sum, r) => sum + parseFloat(r.convertedAmount || r.amount), 0);
                    return (
                      <Card 
                        key={`pending-${company.id}-${monthKey}`}
                        className="border border-dashed border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-950/10 hover:border-amber-400 dark:hover:border-amber-600 hover:shadow-lg transition-all cursor-pointer group"
                        onClick={() => setPendingDetail({ companyId: company.id, monthKey })}
                      >
                        <CardContent className="p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
                          <div className="flex items-center gap-3 w-full sm:w-auto">
                            <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0">
                              <Receipt className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                            </div>
                            <div>
                              <h3 className="font-bold text-foreground">
                                {format(new Date(monthKey + '-01'), 'MMMM yyyy')}
                              </h3>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                                <span>{receipts.length} receipt{receipts.length !== 1 ? "s" : ""}</span>
                                <span>·</span>
                                <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                  <Clock className="w-3 h-3" /> Pending claim
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
                            <div className="text-right sm:mr-2">
                              <div className="font-bold text-lg text-foreground">{total.toFixed(2)}</div>
                              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{company.baseCurrency}</div>
                            </div>
                            <div onClick={(e) => e.stopPropagation()}>
                              <Button
                                size="sm"
                                className="text-xs"
                                onClick={() => {
                                  setSelectedCompanyId(String(company.id));
                                  setSelectedMonth(monthKey);
                                  setCreateDialogOpen(true);
                                }}
                              >
                                <Plus className="w-3.5 h-3.5 mr-1" /> Generate Claim
                              </Button>
                            </div>
                            <div className="hidden sm:flex items-center text-muted-foreground group-hover:text-amber-500 transition-colors">
                              <ChevronRight className="w-5 h-5" />
                            </div>
                          </div>
                        </CardContent>
                        <div className="sm:hidden px-4 pb-3">
                          <button className="w-full flex items-center justify-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 font-medium py-1.5 rounded-lg bg-amber-500/5 hover:bg-amber-500/10 transition-colors">
                            <Eye className="w-3.5 h-3.5" /> View receipts & edit
                          </button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16">
          <FileText className="w-16 h-16 mx-auto mb-4 text-muted-foreground/30" />
          <h3 className="text-lg font-semibold text-foreground mb-2">No claim forms yet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            Claim forms are generated automatically at each company's cut-off date, or you can generate one manually.
          </p>
          {companies.length > 0 && (
            <Button onClick={() => setCreateDialogOpen(true)} className="rounded-xl">
              <Plus className="mr-2 w-4 h-4" /> Generate Your First Claim
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
