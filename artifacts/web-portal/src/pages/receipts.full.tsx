import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { getAuthImageUrl } from "@/lib/utils";
import { 
  useListReceipts, 
  useCreateReceipt, 
  useUpdateReceipt,
  useDeleteReceipt,
  useListCompanies,
  useListCategories,
  useListResolvedFlags,
  useResolveFlag,
  useListClaimPeriods,
  getExchangeRate,
  parseReceiptImage,
  createReceipt,
  ReceiptResponse
} from "@workspace/api-client-react";
import { useUpload } from "@/hooks/use-upload";
import { format } from "date-fns";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Camera, Loader2, RefreshCw, Receipt, Pencil, Upload, FileText, ChevronDown, ChevronRight, CheckSquare, Square, ClipboardList, RotateCcw, AlertTriangle, BookmarkPlus, Bookmark, X, Check, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Combobox } from "@/components/ui/combobox";
import { CURRENCY_OPTIONS } from "@/lib/constants";

const EXPENSE_CHECKLIST_ITEMS = [
  { id: "flights", label: "Flights", group: "Travel" },
  { id: "hotels", label: "Hotels / Accommodation", group: "Travel" },
  { id: "international_roaming", label: "International Roaming Bill", group: "Travel" },
  { id: "grab_ride", label: "Grab Ride / Taxi", group: "Transportation" },
  { id: "grab_delivery", label: "Grab Express / Delivery", group: "Transportation" },
  { id: "lalamove", label: "Lalamove", group: "Transportation" },
  { id: "public_transport", label: "Bus / Train / MRT", group: "Transportation" },
  { id: "parking_tolls", label: "Parking & Tolls", group: "Transportation" },
  { id: "fuel", label: "Fuel / Petrol", group: "Transportation" },
  { id: "meals", label: "Meals & Dining", group: "Food & Daily" },
  { id: "groceries", label: "Groceries", group: "Food & Daily" },
  { id: "online_purchases", label: "Online Purchases (Shopee, Lazada, etc.)", group: "Shopping" },
  { id: "household", label: "Household Items", group: "Shopping" },
  { id: "office_supplies", label: "Office Supplies & Stationery", group: "Shopping" },
  { id: "wifi_internet", label: "WiFi / Internet", group: "Utilities & Bills" },
  { id: "water", label: "Water Bill", group: "Utilities & Bills" },
  { id: "electricity", label: "Electricity Bill", group: "Utilities & Bills" },
  { id: "phone_bill", label: "Phone Bill", group: "Utilities & Bills" },
  { id: "socso", label: "Employee SOCSO / EPF", group: "Employment & Insurance" },
  { id: "insurance", label: "Insurance Premiums", group: "Employment & Insurance" },
  { id: "medical", label: "Medical & Healthcare", group: "Employment & Insurance" },
  { id: "water_filter", label: "Water Filter Subscription", group: "Subscriptions" },
  { id: "air_filter", label: "Air Filter / Purifier Subscription", group: "Subscriptions" },
  { id: "ai_tools", label: "AI Tools (ChatGPT, Claude, etc.)", group: "Software & Digital" },
  { id: "software", label: "Software Purchases / Licenses", group: "Software & Digital" },
  { id: "cloud_hosting", label: "Cloud / Hosting Services", group: "Software & Digital" },
  { id: "digital_subscriptions", label: "Other Digital Subscriptions", group: "Software & Digital" },
  { id: "printing", label: "Printing & Photocopying", group: "Miscellaneous" },
  { id: "postage", label: "Postage & Courier", group: "Miscellaneous" },
  { id: "training", label: "Training & Courses", group: "Miscellaneous" },
  { id: "professional_fees", label: "Professional Fees", group: "Miscellaneous" },
  { id: "other", label: "Other Expenses", group: "Miscellaneous" },
];

const CHECKLIST_GROUPS = [...new Set(EXPENSE_CHECKLIST_ITEMS.map(i => i.group))];

function getChecklistStorageKey(userId: number, month: string) {
  return `claimbase_checklist_${userId}_${month}`;
}

function useExpenseChecklist(userId: number | undefined, currentMonth: string) {
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!userId) return;
    const key = getChecklistStorageKey(userId, currentMonth);
    try {
      const stored = localStorage.getItem(key);
      if (stored) setChecked(new Set(JSON.parse(stored)));
      else setChecked(new Set());
    } catch { setChecked(new Set()); }
  }, [userId, currentMonth]);

  const toggle = useCallback((id: string) => {
    if (!userId) return;
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      const key = getChecklistStorageKey(userId, currentMonth);
      localStorage.setItem(key, JSON.stringify([...next]));
      return next;
    });
  }, [userId, currentMonth]);

  const resetAll = useCallback(() => {
    if (!userId) return;
    setChecked(new Set());
    const key = getChecklistStorageKey(userId, currentMonth);
    localStorage.removeItem(key);
  }, [userId, currentMonth]);

  return { checked, toggle, resetAll };
}

const FLAGGED_CATEGORIES = ["Meals & Entertainment", "Transportation"];

const GENERIC_DESCRIPTIONS = [
  "needs description", "receipt", "grab ride", "grabfood", "grab food",
  "food delivery", "taxi", "ride", "meal", "lunch", "dinner", "breakfast",
  "grab ride:", "grabfood delivery", "grab car", "food order", "delivery",
  "transport", "uber", "uber ride", "lyft", "lyft ride"
];

function needsPurposeFlag(receipt: { categoryName?: string | null; description: string }): boolean {
  if (!receipt.categoryName) return false;
  if (!FLAGGED_CATEGORIES.some(cat => receipt.categoryName!.toLowerCase().includes(cat.toLowerCase()))) return false;
  const desc = receipt.description.toLowerCase().trim();
  if (GENERIC_DESCRIPTIONS.some(g => desc === g || desc.startsWith(g + " ") || desc.startsWith(g + ":"))) {
    return true;
  }
  if (desc === "needs description" || desc === "receipt") return true;
  return false;
}

function getSavedDescriptionsKey(userId: number) {
  return `claimbase_saved_descriptions_${userId}`;
}

function useSavedDescriptions(userId: number | undefined) {
  const [descriptions, setDescriptions] = useState<string[]>([]);

  useEffect(() => {
    if (!userId) return;
    try {
      const stored = localStorage.getItem(getSavedDescriptionsKey(userId));
      if (stored) setDescriptions(JSON.parse(stored));
    } catch { setDescriptions([]); }
  }, [userId]);

  const save = useCallback((desc: string) => {
    if (!userId || !desc || desc.length < 5) return;
    setDescriptions(prev => {
      const trimmed = desc.trim();
      if (prev.some(d => d.toLowerCase() === trimmed.toLowerCase())) return prev;
      const next = [trimmed, ...prev].slice(0, 50);
      localStorage.setItem(getSavedDescriptionsKey(userId), JSON.stringify(next));
      return next;
    });
  }, [userId]);

  const remove = useCallback((desc: string) => {
    if (!userId) return;
    setDescriptions(prev => {
      const next = prev.filter(d => d !== desc);
      localStorage.setItem(getSavedDescriptionsKey(userId), JSON.stringify(next));
      return next;
    });
  }, [userId]);

  return { descriptions, save, remove };
}

function isPdfUrl(url: string): boolean {
  return url.toLowerCase().endsWith(".pdf") || url.includes(".pdf");
}

const receiptSchema = z.object({
  companyId: z.coerce.number().min(1, "Company is required"),
  categoryId: z.coerce.number().optional(),
  description: z.string().min(2, "Description is required"),
  receiptDate: z.string().min(10, "Date is required"),
  currency: z.string().min(3),
  amount: z.string().min(1),
  conversionRate: z.string(),
  imageUrl: z.string().optional(),
});

export default function Receipts() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<ReceiptResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const { uploadFile, isUploading } = useUpload();
  const [isParsing, setIsParsing] = useState(false);

  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const [bulkCompanyId, setBulkCompanyId] = useState<string>("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [checklistOpen, setChecklistOpen] = useState(false);

  const currentMonth = format(new Date(), "yyyy-MM");
  const { checked: checklistChecked, toggle: toggleChecklistItem, resetAll: resetChecklist } = useExpenseChecklist(user?.id, currentMonth);
  const { descriptions: savedDescriptions, save: saveDescription, remove: removeDescription } = useSavedDescriptions(user?.id);
  const [savedDescsOpen, setSavedDescsOpen] = useState(false);
  const [showDescSuggestions, setShowDescSuggestions] = useState(false);
  const [addingDescription, setAddingDescription] = useState(false);
  const [newDescriptionText, setNewDescriptionText] = useState("");
  const [editClaimMonth, setEditClaimMonth] = useState<string | null>(null);

  const { data: receipts = [], refetch, error: receiptsError } = useListReceipts(user!.id, undefined, {
    query: { refetchInterval: 10_000 }
  });
  const { data: companies = [] } = useListCompanies(user!.id);
  const { data: categories = [] } = useListCategories({ userId: user!.id });

  const { data: claimPeriods = [] } = useListClaimPeriods(user!.id);

  const { data: resolvedFlagsData = [], refetch: refetchFlags } = useListResolvedFlags(user!.id, {
    query: { refetchInterval: 10_000 }
  });
  const resolveFlagMutation = useResolveFlag({
    mutation: { onSuccess: () => { refetchFlags(); } }
  });
  const resolvedFlags = useMemo(() => {
    const set = new Set<string>();
    for (const f of resolvedFlagsData) {
      set.add(`${f.flagType}_${f.receiptId}`);
    }
    return set;
  }, [resolvedFlagsData]);
  const resolveFlag = useCallback((receiptId: number, type: "dupe" | "purpose") => {
    resolveFlagMutation.mutate({ userId: user!.id, data: { receiptId, flagType: type } });
  }, [user, resolveFlagMutation]);

  const claimedMonthsByCompany = useMemo(() => {
    const map = new Map<number, Set<string>>();
    for (const cp of claimPeriods) {
      if (cp.status !== "completed") continue;
      if (!map.has(cp.companyId)) map.set(cp.companyId, new Set());
      map.get(cp.companyId)!.add(cp.periodLabel);
    }
    return map;
  }, [claimPeriods]);

  const isLateReceipt = useCallback((receipt: ReceiptResponse) => {
    if (receipt.claimPeriodId || receipt.claimMonth) return false;
    if (!receipt.receiptDate) return false;
    const receiptMonth = receipt.receiptDate.slice(0, 7);
    const claimed = claimedMonthsByCompany.get(receipt.companyId);
    return claimed?.has(receiptMonth) ?? false;
  }, [claimedMonthsByCompany]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const groupedReceipts = useMemo(() => {
    type MonthGroup = { monthKey: string; monthLabel: string; receipts: ReceiptResponse[]; total: number };
    type CompanyGroup = { companyId: number; companyName: string; baseCurrency: string; months: MonthGroup[]; totalReceipts: number; totalAmount: number };

    const companyMap = new Map<number, { receipts: ReceiptResponse[]; companyName: string; baseCurrency: string }>();

    for (const r of receipts) {
      if (!companyMap.has(r.companyId)) {
        const company = companies.find(c => c.id === r.companyId);
        companyMap.set(r.companyId, {
          receipts: [],
          companyName: company?.name || "Unknown Company",
          baseCurrency: company?.baseCurrency || r.currency,
        });
      }
      companyMap.get(r.companyId)!.receipts.push(r);
    }

    const groups: CompanyGroup[] = [];
    for (const [companyId, data] of companyMap) {
      const monthMap = new Map<string, ReceiptResponse[]>();
      for (const r of data.receipts) {
        const monthKey = r.receiptDate ? r.receiptDate.slice(0, 7) : "unknown";
        if (!monthMap.has(monthKey)) monthMap.set(monthKey, []);
        monthMap.get(monthKey)!.push(r);
      }

      const months: MonthGroup[] = [];
      for (const [monthKey, monthReceipts] of monthMap) {
        let monthLabel = monthKey;
        try { monthLabel = format(new Date(monthKey + "-01"), "MMMM yyyy"); } catch {}
        const total = monthReceipts.reduce((sum, r) => sum + (parseFloat(r.convertedAmount) || parseFloat(r.amount) || 0), 0);
        months.push({ monthKey, monthLabel, receipts: monthReceipts, total });
      }
      months.sort((a, b) => b.monthKey.localeCompare(a.monthKey));

      const totalReceipts = data.receipts.length;
      const totalAmount = months.reduce((sum, m) => sum + m.total, 0);
      groups.push({ companyId, companyName: data.companyName, baseCurrency: data.baseCurrency, months, totalReceipts, totalAmount });
    }

    groups.sort((a, b) => b.totalReceipts - a.totalReceipts);
    return groups;
  }, [receipts, companies]);
  
  const createMutation = useCreateReceipt({
    mutation: { 
      onSuccess: () => { refetch(); closeDialog(); toast({ title: "Receipt added" }); },
      onError: () => { toast({ title: "Failed to save receipt", variant: "destructive" }); }
    }
  });

  const updateMutation = useUpdateReceipt({
    mutation: { 
      onSuccess: () => { refetch(); closeDialog(); toast({ title: "Receipt updated" }); },
      onError: () => { toast({ title: "Failed to update receipt", variant: "destructive" }); }
    }
  });
  
  const deleteMutation = useDeleteReceipt({
    mutation: { 
      onSuccess: () => { refetch(); toast({ title: "Receipt deleted" }); },
      onError: () => { toast({ title: "Failed to delete receipt", variant: "destructive" }); }
    }
  });

  const uncategorizedCount = receipts.filter(r => !r.categoryName).length;
  const needsDescriptionCount = receipts.filter(r => r.description === "Needs description" || r.description === "Receipt").length;
  const needsPurposeCount = receipts.filter(r => needsPurposeFlag(r) && !resolvedFlags.has(`purpose_${r.id}`)).length;

  const duplicateIds = useMemo(() => {
    const dupeSet = new Set<number>();
    const seen = new Map<string, number[]>();
    for (const r of receipts) {
      const key = `${r.companyId}_${r.receiptDate}_${r.amount}_${r.currency}_${r.imageUrl || "no-img"}_${r.description}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(r.id);
    }
    for (const ids of seen.values()) {
      if (ids.length > 1) ids.forEach(id => dupeSet.add(id));
    }
    return dupeSet;
  }, [receipts]);
  const activeDuplicateIds = useMemo(() => {
    const active = new Set<number>();
    for (const id of duplicateIds) {
      if (!resolvedFlags.has(`dupe_${id}`)) active.add(id);
    }
    return active;
  }, [duplicateIds, resolvedFlags]);
  const duplicateCount = activeDuplicateIds.size;

  const form = useForm<z.infer<typeof receiptSchema>>({
    resolver: zodResolver(receiptSchema),
    defaultValues: {
      currency: "USD",
      conversionRate: "1.0",
      receiptDate: format(new Date(), 'yyyy-MM-dd')
    }
  });

  const watchCompanyId = form.watch("companyId");
  const watchCurrency = form.watch("currency");
  const watchAmount = form.watch("amount");
  const watchRate = form.watch("conversionRate");

  const selectedCompany = companies.find(c => c.id === watchCompanyId);

  const openCreateDialog = () => {
    setEditingReceipt(null);
    form.reset({
      currency: "USD",
      conversionRate: "1.0",
      receiptDate: format(new Date(), 'yyyy-MM-dd'),
      description: "",
      companyId: undefined,
      categoryId: undefined,
      amount: "",
      imageUrl: "",
    });
    setDialogOpen(true);
  };

  const openEditDialog = (receipt: ReceiptResponse) => {
    setEditingReceipt(receipt);
    form.reset({
      companyId: receipt.companyId,
      categoryId: receipt.categoryId ?? undefined,
      description: receipt.description,
      receiptDate: receipt.receiptDate,
      currency: receipt.currency,
      amount: receipt.amount,
      conversionRate: receipt.conversionRate,
      imageUrl: receipt.imageUrl ?? "",
    });
    setEditClaimMonth(receipt.claimMonth ?? null);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingReceipt(null);
    setSelectedFile(null);
    setEditClaimMonth(null);
  };

  const handleRefreshRate = async () => {
    if (!selectedCompany || watchCurrency === selectedCompany.baseCurrency) {
      form.setValue("conversionRate", "1.0");
      return;
    }
    try {
      const rateData = await getExchangeRate({ from: watchCurrency, to: selectedCompany.baseCurrency });
      form.setValue("conversionRate", rateData.rate.toString());
      toast({ title: "Exchange rate updated", description: `1 ${watchCurrency} = ${rateData.rate} ${selectedCompany.baseCurrency}` });
    } catch {
      toast({ title: "Failed to fetch rate", variant: "destructive" });
    }
  };

  const handleImageProcess = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;
    const file = e.target.files[0];
    setSelectedFile(file);
    
    setIsParsing(true);
    try {
      const objectPath = await uploadFile(file);
      if (!objectPath) throw new Error("Upload failed");
      
      form.setValue("imageUrl", objectPath);
      
      const parsed = await parseReceiptImage({ imageUrl: objectPath });
      
      if (parsed.amount) form.setValue("amount", parsed.amount);
      if (parsed.currency) form.setValue("currency", parsed.currency);
      if (parsed.date) {
        try {
          const d = new Date(parsed.date);
          if (!isNaN(d.getTime())) form.setValue("receiptDate", format(d, 'yyyy-MM-dd'));
        } catch {}
      }
      toast({ title: "Receipt parsed successfully!" });
    } catch (err) {
      toast({ title: "Failed to parse receipt", variant: "destructive" });
    } finally {
      setIsParsing(false);
    }
  };

  const onSubmit = (data: z.infer<typeof receiptSchema>) => {
    const convertedAmount = (parseFloat(data.amount) * parseFloat(data.conversionRate)).toFixed(2);
    if (data.description && data.description.length >= 10) {
      saveDescription(data.description);
    }
    const payload = { ...data, convertedAmount, claimMonth: editClaimMonth || null };
    if (editingReceipt) {
      updateMutation.mutate({
        receiptId: editingReceipt.id,
        data: payload
      });
    } else {
      createMutation.mutate({
        userId: user!.id,
        data: payload
      });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !bulkCompanyId) return;

    const company = companies.find(c => c.id === parseInt(bulkCompanyId));
    if (!company) return;

    setBulkProcessing(true);
    setBulkProgress({ current: 0, total: files.length });

    let successCount = 0;
    const failedFiles: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setBulkProgress({ current: i + 1, total: files.length });
      try {
        const file = files[i]!;
        const objectPath = await uploadFile(file);
        if (!objectPath) throw new Error("Upload failed");

        const parsed = await parseReceiptImage({ imageUrl: objectPath });
        const rawAmount = parsed.amount ? parseFloat(parsed.amount) : 0;
        const amount = isNaN(rawAmount) ? 0 : rawAmount;
        const receiptCurrency = parsed.currency || company.baseCurrency;
        let conversionRate = 1;
        if (receiptCurrency.toUpperCase() !== company.baseCurrency.toUpperCase()) {
          try {
            const rateData = await getExchangeRate({ from: receiptCurrency, to: company.baseCurrency });
            conversionRate = isNaN(rateData.rate) ? 1 : rateData.rate;
          } catch {}
        }
        const convertedAmount = (amount * conversionRate).toFixed(2);

        let receiptDate = format(new Date(), 'yyyy-MM-dd');
        if (parsed.date) {
          try {
            const d = new Date(parsed.date);
            if (!isNaN(d.getTime())) receiptDate = format(d, 'yyyy-MM-dd');
          } catch {}
        }

        await createReceipt(user!.id, {
          companyId: parseInt(bulkCompanyId),
          description: parsed.description || file.name.replace(/\.[^.]+$/, ""),
          receiptDate,
          currency: receiptCurrency,
          amount: amount.toFixed(2),
          conversionRate: conversionRate.toFixed(6),
          convertedAmount,
          imageUrl: objectPath,
        });
        successCount++;
      } catch (err) {
        console.error("Bulk upload item failed:", err);
        failedFiles.push(files[i]!.name);
      }
    }

    setBulkProcessing(false);
    setBulkDialogOpen(false);
    setBulkCompanyId("");
    refetch();
    if (failedFiles.length > 0) {
      toast({
        title: `${successCount} of ${files.length} receipts uploaded`,
        description: `Failed: ${failedFiles.join(", ")}`,
        variant: successCount === 0 ? "destructive" : "default"
      });
    } else {
      toast({ title: `All ${successCount} receipts uploaded successfully` });
    }
    e.target.value = "";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-display font-bold">Receipts</h1>
        <div className="flex gap-2">
          <Button variant="outline" className="rounded-xl h-10 sm:h-11 text-sm" onClick={() => setBulkDialogOpen(true)} disabled={companies.length === 0}>
            <Upload className="mr-1.5 w-4 h-4" /> Bulk Upload
          </Button>
          <Button className="rounded-xl px-4 sm:px-6 h-10 sm:h-11 text-sm" onClick={openCreateDialog}>
            <Plus className="mr-1.5 w-4 h-4" /> Add Receipt
          </Button>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              {editingReceipt ? "Edit Receipt" : "New Receipt"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-center w-full">
              {selectedFile ? (
                <div className="w-full space-y-2">
                  <div className="relative w-full h-40 rounded-xl overflow-hidden border border-border bg-muted">
                    {selectedFile.type === "application/pdf" ? (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                        <FileText className="w-12 h-12 text-red-500" />
                        <span className="text-xs text-muted-foreground">{selectedFile.name}</span>
                      </div>
                    ) : (
                      <img
                        src={URL.createObjectURL(selectedFile)}
                        alt="Receipt preview"
                        className="w-full h-full object-contain"
                      />
                    )}
                    {(isUploading || isParsing) && (
                      <div className="absolute inset-0 bg-background/70 flex items-center justify-center">
                        <Loader2 className="w-8 h-8 text-primary animate-spin" />
                        <span className="ml-2 text-sm font-medium text-muted-foreground">Analyzing...</span>
                      </div>
                    )}
                  </div>
                  <Label htmlFor="dropzone-file" className="block text-center text-xs text-primary cursor-pointer hover:underline">
                    Change file
                    <input id="dropzone-file" type="file" accept="image/*,application/pdf" className="hidden" onChange={handleImageProcess} />
                  </Label>
                </div>
              ) : editingReceipt?.imageUrl ? (
                <div className="w-full space-y-2">
                  <a
                    href={getAuthImageUrl(editingReceipt.imageUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block relative w-full h-40 rounded-xl overflow-hidden border border-border bg-muted group cursor-pointer"
                  >
                    {isPdfUrl(editingReceipt.imageUrl) ? (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                        <FileText className="w-12 h-12 text-red-500" />
                        <span className="text-xs text-muted-foreground">PDF Receipt</span>
                        <span className="text-xs text-primary font-medium group-hover:underline">Tap to view</span>
                      </div>
                    ) : (
                      <>
                        <img
                          src={getAuthImageUrl(editingReceipt.imageUrl)}
                          alt="Receipt"
                          className="w-full h-full object-contain"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                          <span className="text-white text-sm font-medium opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-3 py-1 rounded-full">View full size</span>
                        </div>
                      </>
                    )}
                  </a>
                  <Label htmlFor="dropzone-file" className="block text-center text-xs text-primary cursor-pointer hover:underline">
                    Replace file
                    <input id="dropzone-file" type="file" accept="image/*,application/pdf" className="hidden" onChange={handleImageProcess} />
                  </Label>
                </div>
              ) : (
                <Label htmlFor="dropzone-file" className="flex flex-col items-center justify-center w-full h-32 border-2 border-border border-dashed rounded-xl cursor-pointer bg-muted hover:bg-muted/70 transition-colors">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    {(isUploading || isParsing) ? (
                      <Loader2 className="w-8 h-8 text-primary animate-spin mb-2" />
                    ) : (
                      <Camera className="w-8 h-8 text-muted-foreground mb-2" />
                    )}
                    <p className="text-sm text-muted-foreground font-medium">
                      {(isUploading || isParsing) ? "Analyzing file..." : "Upload receipt for AI scan"}
                    </p>
                    {!(isUploading || isParsing) && (
                      <p className="text-xs text-muted-foreground/70 mt-1">JPG, JPEG, PNG, HEIC, PDF</p>
                    )}
                  </div>
                  <input id="dropzone-file" type="file" accept="image/*,application/pdf" className="hidden" onChange={handleImageProcess} />
                </Label>
              )}
            </div>

            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Company</Label>
                  <Select value={form.watch("companyId")?.toString() || ""} onValueChange={(v) => form.setValue("companyId", parseInt(v))}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {companies.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={form.watch("categoryId")?.toString() || ""} onValueChange={(v) => form.setValue("categoryId", parseInt(v))}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {categories.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2 relative">
                <Label className="flex items-center gap-1">
                  Description <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Input
                    {...form.register("description")}
                    placeholder="e.g. Client lunch meeting with ABC Corp"
                    onFocus={() => setShowDescSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowDescSuggestions(false), 200)}
                    autoComplete="off"
                  />
                  {savedDescriptions.length > 0 && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary"
                      onClick={() => setShowDescSuggestions(!showDescSuggestions)}
                      tabIndex={-1}
                    >
                      <Bookmark className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {showDescSuggestions && savedDescriptions.length > 0 && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    {savedDescriptions
                      .filter(d => {
                        const query = form.watch("description")?.toLowerCase() || "";
                        return !query || d.toLowerCase().includes(query);
                      })
                      .slice(0, 8)
                      .map((desc, i) => (
                        <button
                          key={i}
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors text-foreground truncate"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            form.setValue("description", desc);
                            setShowDescSuggestions(false);
                          }}
                        >
                          {desc}
                        </button>
                      ))}
                  </div>
                )}
                {form.formState.errors.description && (
                  <p className="text-xs text-red-500">{form.formState.errors.description.message}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Input type="date" {...form.register("receiptDate")} />
                </div>
                <div className="space-y-2">
                  <Label>Amount</Label>
                  <Input type="number" step="0.01" {...form.register("amount")} placeholder="0.00" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Combobox
                    options={CURRENCY_OPTIONS}
                    value={form.watch("currency")}
                    onValueChange={(v) => form.setValue("currency", v)}
                    placeholder="Select currency"
                    searchPlaceholder="Type currency..."
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex justify-between">
                    Exchange Rate
                    {selectedCompany && watchCurrency !== selectedCompany.baseCurrency && (
                      <button type="button" onClick={handleRefreshRate} className="text-xs text-primary flex items-center hover:underline">
                        <RefreshCw className="w-3 h-3 mr-1" /> Get Rate
                      </button>
                    )}
                  </Label>
                  <Input type="number" step="0.0001" {...form.register("conversionRate")} />
                </div>
              </div>

              {editingReceipt && isLateReceipt(editingReceipt) && !editClaimMonth && (
                <div className="p-3 bg-amber-100/50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 rounded-lg text-sm flex items-center gap-2">
                  <Clock className="w-4 h-4 flex-shrink-0" />
                  <span>This receipt's month already has a submitted claim. Assign it to a different claim period below.</span>
                </div>
              )}

              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  Claim in Period
                  <span className="text-xs text-muted-foreground ml-1">(optional override)</span>
                </Label>
                <Select
                  value={editClaimMonth || "__auto__"}
                  onValueChange={(v) => setEditClaimMonth(v === "__auto__" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Auto (use receipt date)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">Auto (use receipt date month)</SelectItem>
                    {(() => {
                      const months: string[] = [];
                      for (let i = -1; i < 6; i++) {
                        const d = new Date();
                        d.setMonth(d.getMonth() - i);
                        months.push(format(d, "yyyy-MM"));
                      }
                      if (editClaimMonth && !months.includes(editClaimMonth)) {
                        months.push(editClaimMonth);
                        months.sort().reverse();
                      }
                      return months.map(m => (
                        <SelectItem key={m} value={m}>
                          {format(new Date(m + "-01"), "MMMM yyyy")}
                        </SelectItem>
                      ));
                    })()}
                  </SelectContent>
                </Select>
              </div>

              {watchAmount && watchRate && selectedCompany && (
                <div className="p-3 bg-blue-100/50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 rounded-lg text-sm flex justify-between font-medium">
                  <span>Converted Total:</span>
                  <span>{(parseFloat(watchAmount) * parseFloat(watchRate)).toFixed(2)} {selectedCompany.baseCurrency}</span>
                </div>
              )}

              <Button type="submit" className="w-full h-11" disabled={isSaving}>
                {isSaving ? "Saving..." : editingReceipt ? "Update Receipt" : "Save Receipt"}
              </Button>
            </form>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDialogOpen} onOpenChange={(open) => { if (!bulkProcessing) setBulkDialogOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Bulk Upload Receipts</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Select multiple receipt images or PDFs at once. Each will be analyzed by AI, uploaded, and saved automatically.
            </p>
            <div className="space-y-2">
              <Label>Company (all receipts will be assigned to)</Label>
              <Select value={bulkCompanyId} onValueChange={setBulkCompanyId}>
                <SelectTrigger><SelectValue placeholder="Select company..." /></SelectTrigger>
                <SelectContent>
                  {companies.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {bulkProcessing ? (
              <div className="space-y-3 py-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-5 h-5 text-primary animate-spin" />
                  <span className="text-sm font-medium text-foreground">
                    Processing {bulkProgress.current} of {bulkProgress.total}...
                  </span>
                </div>
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${bulkProgress.total ? (bulkProgress.current / bulkProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ) : (
              <Label
                htmlFor="bulk-upload-input"
                className={`flex flex-col items-center justify-center w-full h-32 border-2 border-border border-dashed rounded-xl cursor-pointer transition-colors ${
                  bulkCompanyId ? "bg-muted hover:bg-muted/70" : "bg-muted/30 opacity-50 cursor-not-allowed"
                }`}
              >
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <Upload className="w-8 h-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground font-medium">
                    {bulkCompanyId ? "Click to select multiple receipts" : "Select a company first"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">JPG, JPEG, PNG, HEIC, PDF supported</p>
                </div>
                <input
                  id="bulk-upload-input"
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  disabled={!bulkCompanyId}
                  onChange={handleBulkUpload}
                />
              </Label>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {receiptsError && (
        <div className="p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl text-red-700 dark:text-red-300">
          <p className="text-sm font-medium">Failed to load receipts. Please try refreshing.</p>
        </div>
      )}

      {(needsDescriptionCount > 0 || duplicateCount > 0 || needsPurposeCount > 0 || uncategorizedCount > 0) && (
        <div className="flex flex-wrap gap-2">
          {needsDescriptionCount > 0 && (
            <div className="px-3 py-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg flex items-center gap-2">
              <span className="text-sm">📝</span>
              <p className="text-xs text-red-700 dark:text-red-300 font-medium">
                {needsDescriptionCount} need{needsDescriptionCount === 1 ? "s" : ""} description
              </p>
            </div>
          )}
          {uncategorizedCount > 0 && (
            <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg flex items-center gap-2">
              <span className="text-sm">⚠️</span>
              <p className="text-xs text-amber-700 dark:text-amber-300 font-medium">
                {uncategorizedCount} need{uncategorizedCount === 1 ? "s" : ""} category
              </p>
            </div>
          )}
          {duplicateCount > 0 && (
            <div className="px-3 py-2 bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 rounded-lg flex items-center gap-2">
              <span className="text-sm">🔁</span>
              <p className="text-xs text-purple-700 dark:text-purple-300 font-medium">
                {duplicateCount} possible duplicate{duplicateCount > 1 ? "s" : ""}
              </p>
            </div>
          )}
          {needsPurposeCount > 0 && (
            <div className="px-3 py-2 bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 rounded-lg flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400 flex-shrink-0" />
              <p className="text-xs text-orange-700 dark:text-orange-300 font-medium">
                {needsPurposeCount} need{needsPurposeCount === 1 ? "s" : ""} purpose
              </p>
            </div>
          )}
        </div>
      )}

      <div className="space-y-4">
        {groupedReceipts.map((companyGroup) => {
          const companyKey = `company-${companyGroup.companyId}`;
          const isCompanyCollapsed = collapsedGroups.has(companyKey);
          return (
            <Card key={companyKey} className="border bg-card overflow-hidden">
              <button
                type="button"
                className="w-full p-4 flex items-center justify-between hover:bg-muted/50 transition-colors text-left"
                onClick={() => toggleGroup(companyKey)}
              >
                <div className="flex items-center gap-3">
                  {isCompanyCollapsed ? <ChevronRight className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  <div>
                    <h3 className="font-bold text-foreground">{companyGroup.companyName}</h3>
                    <p className="text-sm text-muted-foreground">
                      {companyGroup.months.length === 1 ? companyGroup.months[0]!.monthLabel : `${companyGroup.months.length} months`}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-foreground">{companyGroup.totalReceipts} receipt{companyGroup.totalReceipts !== 1 ? "s" : ""}</div>
                  <div className="text-sm text-muted-foreground">{companyGroup.baseCurrency} {companyGroup.totalAmount.toFixed(2)}</div>
                </div>
              </button>
              {!isCompanyCollapsed && (
                <div className="border-t border-border">
                  {companyGroup.months.map((month) => {
                    const monthSectionKey = `${companyGroup.companyId}-${month.monthKey}`;
                    const isMonthCollapsed = companyGroup.months.length > 1 && collapsedGroups.has(monthSectionKey);
                    return (
                      <div key={monthSectionKey}>
                        {companyGroup.months.length > 1 && (
                          <button
                            type="button"
                            className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-muted/30 transition-colors text-left bg-muted/20 border-b border-border"
                            onClick={() => toggleGroup(monthSectionKey)}
                          >
                            <div className="flex items-center gap-2">
                              {isMonthCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                              <span className="text-sm font-semibold text-foreground">{month.monthLabel}</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span>{month.receipts.length} receipt{month.receipts.length !== 1 ? "s" : ""}</span>
                              <span className="font-medium">{companyGroup.baseCurrency} {month.total.toFixed(2)}</span>
                            </div>
                          </button>
                        )}
                        {!isMonthCollapsed && (
                  <div className="divide-y divide-border">
                  {month.receipts.map((receipt) => {
                    const flagged = needsPurposeFlag(receipt) && !resolvedFlags.has(`purpose_${receipt.id}`);
                    const isDupe = activeDuplicateIds.has(receipt.id);
                    return (
                    <div key={receipt.id} className={`p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 ${(receipt.description === "Needs description" || receipt.description === "Receipt") ? "bg-red-50/50 dark:bg-red-950/10" : isDupe ? "bg-purple-50/50 dark:bg-purple-950/10" : flagged ? "bg-orange-50/50 dark:bg-orange-950/10" : !receipt.categoryName ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}`}>
                      <div className="flex items-center gap-4 w-full sm:flex-1 sm:min-w-0">
                        {receipt.imageUrl ? (
                          isPdfUrl(receipt.imageUrl) ? (
                            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 border border-border">
                              <FileText className="w-5 h-5 text-red-500" />
                            </div>
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-muted flex-shrink-0 overflow-hidden border border-border">
                              <img src={getAuthImageUrl(receipt.imageUrl)} alt="Receipt" className="w-full h-full object-cover" />
                            </div>
                          )
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 border border-border">
                            <Receipt className="w-5 h-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-bold text-foreground truncate">{receipt.description}</h4>
                            {isDupe && (
                              <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                                🔁 Duplicate?
                                <button
                                  onClick={(e) => { e.stopPropagation(); resolveFlag(receipt.id, "dupe"); }}
                                  className="ml-0.5 p-0.5 rounded hover:bg-purple-200 dark:hover:bg-purple-800 transition-colors"
                                  title="Not a duplicate — dismiss"
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                              </span>
                            )}
                            {flagged && !isDupe && (
                              <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-800">
                                <AlertTriangle className="w-3 h-3" />
                                Add purpose
                                <button
                                  onClick={(e) => { e.stopPropagation(); resolveFlag(receipt.id, "purpose"); }}
                                  className="ml-0.5 p-0.5 rounded hover:bg-orange-200 dark:hover:bg-orange-800 transition-colors"
                                  title="Purpose is fine — dismiss"
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                              </span>
                            )}
                            {isLateReceipt(receipt) && (
                              <button
                                onClick={(e) => { e.stopPropagation(); openEditDialog(receipt); }}
                                className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 hover:bg-amber-200 dark:hover:bg-amber-800 transition-colors cursor-pointer"
                                title="Click to assign to a different claim period"
                              >
                                <Clock className="w-3 h-3" />
                                Late — reassign
                              </button>
                            )}
                            {receipt.claimMonth && (
                              <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                                → {format(new Date(receipt.claimMonth + "-01"), "MMM yyyy")}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 mt-1 text-xs font-medium text-muted-foreground">
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
                      
                      <div className="flex items-center justify-between w-full sm:w-auto gap-4 pl-14 sm:pl-0 flex-shrink-0">
                        <div className="text-right whitespace-nowrap">
                          <div className="font-bold text-lg text-foreground">{receipt.currency} {receipt.amount}</div>
                          {receipt.conversionRate !== "1" && receipt.conversionRate !== "1.00" && receipt.conversionRate !== "1.000000" && (
                            <div className="text-xs text-muted-foreground">
                              → {companies.find(c=>c.id === receipt.companyId)?.baseCurrency || receipt.currency} {receipt.convertedAmount} (×{parseFloat(receipt.conversionRate).toFixed(4)})
                            </div>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-full"
                            onClick={() => openEditDialog(receipt)}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full"
                            onClick={() => {
                              if(confirm('Delete this receipt?')) deleteMutation.mutate({ receiptId: receipt.id })
                            }}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                    );
                  })}
                  </div>
                        )}
                      </div>
                    );
                  })}
                  </div>
              )}
            </Card>
          );
        })}
        
        {receipts.length === 0 && (
          <div className="text-center py-16 px-4 border-2 border-dashed border-border rounded-2xl bg-muted/50">
            <Receipt className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-foreground">No receipts yet</h3>
            <p className="text-muted-foreground mt-1 max-w-sm mx-auto">Upload your first receipt to start tracking expenses.</p>
          </div>
        )}

        <Card className="rounded-2xl border border-border overflow-hidden">
          <div className="flex items-center justify-between p-4 sm:p-5">
            <button
              className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity flex-1"
              onClick={() => setSavedDescsOpen(!savedDescsOpen)}
            >
              <Bookmark className="w-5 h-5 text-primary" />
              <div>
                <h3 className="font-bold text-foreground">Saved Descriptions</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {savedDescriptions.length > 0
                    ? `${savedDescriptions.length} saved — click to reuse when editing receipts`
                    : "Add common descriptions for quick reuse"}
                </p>
              </div>
            </button>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-full h-8 w-8"
                onClick={(e) => { e.stopPropagation(); setAddingDescription(true); setSavedDescsOpen(true); }}
              >
                <Plus className="w-4 h-4" />
              </Button>
              {savedDescsOpen ? (
                <ChevronDown className="w-5 h-5 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
          </div>
          {savedDescsOpen && (
            <div className="border-t border-border divide-y divide-border">
              {addingDescription && (
                <div className="flex items-center gap-2 px-4 sm:px-5 py-2.5">
                  <Input
                    value={newDescriptionText}
                    onChange={(e) => setNewDescriptionText(e.target.value)}
                    placeholder="e.g. Client lunch meeting"
                    className="h-8 text-sm flex-1"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newDescriptionText.trim().length >= 5) {
                        saveDescription(newDescriptionText.trim());
                        setNewDescriptionText("");
                        setAddingDescription(false);
                      } else if (e.key === "Escape") {
                        setNewDescriptionText("");
                        setAddingDescription(false);
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-primary hover:bg-primary/10 rounded-full"
                    disabled={newDescriptionText.trim().length < 5}
                    onClick={() => {
                      if (newDescriptionText.trim().length >= 5) {
                        saveDescription(newDescriptionText.trim());
                        setNewDescriptionText("");
                        setAddingDescription(false);
                      }
                    }}
                  >
                    <Check className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:bg-muted rounded-full"
                    onClick={() => { setNewDescriptionText(""); setAddingDescription(false); }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              )}
              {savedDescriptions.map((desc, i) => (
                <div key={i} className="flex items-center justify-between px-4 sm:px-5 py-2.5 group hover:bg-muted/30 transition-colors">
                  <span className="text-sm text-foreground truncate flex-1 mr-3">{desc}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full h-7 w-7"
                    onClick={() => removeDescription(desc)}
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              {savedDescriptions.length === 0 && !addingDescription && (
                <div className="px-4 sm:px-5 py-4 text-center text-sm text-muted-foreground">
                  No saved descriptions yet. Click + to add one.
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="rounded-2xl border border-border overflow-hidden">
          <button
            className="w-full flex items-center justify-between p-4 sm:p-5 text-left hover:bg-muted/50 transition-colors"
            onClick={() => setChecklistOpen(!checklistOpen)}
          >
            <div className="flex items-center gap-3">
              <ClipboardList className="w-5 h-5 text-primary" />
              <div>
                <h3 className="font-bold text-foreground">Expense Checklist</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {format(new Date(), "MMMM yyyy")} — {checklistChecked.size} of {EXPENSE_CHECKLIST_ITEMS.length} reviewed
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {checklistChecked.size > 0 && (
                <div className="hidden sm:flex items-center gap-2">
                  <div className="w-24 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${(checklistChecked.size / EXPENSE_CHECKLIST_ITEMS.length) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">
                    {Math.round((checklistChecked.size / EXPENSE_CHECKLIST_ITEMS.length) * 100)}%
                  </span>
                </div>
              )}
              {checklistOpen ? (
                <ChevronDown className="w-5 h-5 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
          </button>
          {checklistOpen && (
            <div className="border-t border-border">
              <div className="flex items-center justify-between px-4 sm:px-5 py-3 bg-muted/30">
                <p className="text-xs text-muted-foreground">
                  Tick off each category as you upload receipts. Check "N/A" for items that don't apply.
                </p>
                {checklistChecked.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground hover:text-foreground h-7 px-2 flex-shrink-0"
                    onClick={resetChecklist}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" /> Reset
                  </Button>
                )}
              </div>
              <div className="divide-y divide-border">
                {CHECKLIST_GROUPS.map(group => {
                  const items = EXPENSE_CHECKLIST_ITEMS.filter(i => i.group === group);
                  const groupCheckedCount = items.filter(i => checklistChecked.has(i.id)).length;
                  return (
                    <div key={group} className="px-4 sm:px-5 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{group}</h4>
                        {groupCheckedCount > 0 && (
                          <span className="text-xs text-primary font-medium">{groupCheckedCount}/{items.length}</span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {items.map(item => (
                          <button
                            key={item.id}
                            className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg text-left hover:bg-muted/50 transition-colors group/item"
                            onClick={() => toggleChecklistItem(item.id)}
                          >
                            {checklistChecked.has(item.id) ? (
                              <CheckSquare className="w-4 h-4 text-primary flex-shrink-0" />
                            ) : (
                              <Square className="w-4 h-4 text-muted-foreground/50 group-hover/item:text-muted-foreground flex-shrink-0" />
                            )}
                            <span className={`text-sm ${checklistChecked.has(item.id) ? "text-muted-foreground line-through" : "text-foreground"}`}>
                              {item.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
