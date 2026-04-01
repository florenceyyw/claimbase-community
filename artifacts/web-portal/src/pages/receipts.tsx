import { useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  useListReceipts,
  useCreateReceipt,
  useUpdateReceipt,
  useDeleteReceipt,
  useListCompanies,
  useListCategories,
  ReceiptResponse,
} from "@workspace/api-client-react";
import { useUpload } from "@/hooks/use-upload";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Pencil, Upload, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ReceiptFormState = {
  companyId: string;
  categoryId: string;
  description: string;
  receiptDate: string;
  currency: string;
  amount: string;
  imageUrl: string;
};

const DEFAULT_FORM: ReceiptFormState = {
  companyId: "",
  categoryId: "",
  description: "",
  receiptDate: "",
  currency: "USD",
  amount: "",
  imageUrl: "",
};

export default function Receipts() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { uploadFile, isUploading } = useUpload();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<ReceiptResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [form, setForm] = useState<ReceiptFormState>(DEFAULT_FORM);

  const { data: receipts = [], refetch, isLoading, error } = useListReceipts(user!.id);
  const { data: companies = [] } = useListCompanies(user!.id);
  const { data: categories = [] } = useListCategories({ userId: user!.id });

  const createReceiptMutation = useCreateReceipt({
    mutation: {
      onSuccess: async () => {
        toast({ title: "Receipt created" });
        setDialogOpen(false);
        setEditingReceipt(null);
        setSelectedFile(null);
        setForm(DEFAULT_FORM);
        await refetch();
      },
      onError: () => {
        toast({ title: "Failed to create receipt", variant: "destructive" });
      },
    },
  });

  const updateReceiptMutation = useUpdateReceipt({
    mutation: {
      onSuccess: async () => {
        toast({ title: "Receipt updated" });
        setDialogOpen(false);
        setEditingReceipt(null);
        setSelectedFile(null);
        setForm(DEFAULT_FORM);
        await refetch();
      },
      onError: () => {
        toast({ title: "Failed to update receipt", variant: "destructive" });
      },
    },
  });

  const deleteReceiptMutation = useDeleteReceipt({
    mutation: {
      onSuccess: async () => {
        toast({ title: "Receipt deleted" });
        await refetch();
      },
      onError: () => {
        toast({ title: "Failed to delete receipt", variant: "destructive" });
      },
    },
  });

  const resetForm = () => {
    setEditingReceipt(null);
    setSelectedFile(null);
    setForm(DEFAULT_FORM);
  };

  const openCreateDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (receipt: ReceiptResponse) => {
    setEditingReceipt(receipt);
    setSelectedFile(null);
    setForm({
      companyId: String(receipt.companyId),
      categoryId: receipt.categoryId ? String(receipt.categoryId) : "",
      description: receipt.description || "",
      receiptDate: receipt.receiptDate || "",
      currency: receipt.currency || "USD",
      amount: receipt.amount || "",
      imageUrl: receipt.imageUrl || "",
    });
    setDialogOpen(true);
  };

  const handleFileUpload = async (): Promise<string> => {
    if (!selectedFile) return form.imageUrl;
    const uploadedUrl = await uploadFile(selectedFile, "receipts");
    return uploadedUrl;
  };

  const handleSubmit = async () => {
    if (!user?.id) return;

    if (!form.companyId || !form.description || !form.receiptDate || !form.currency || !form.amount) {
      toast({
        title: "Missing required fields",
        description: "Please fill in company, description, date, currency, and amount.",
        variant: "destructive",
      });
      return;
    }

    try {
      const imageUrl = await handleFileUpload();

      const payload = {
        companyId: Number(form.companyId),
        categoryId: form.categoryId ? Number(form.categoryId) : undefined,
        description: form.description,
        receiptDate: form.receiptDate,
        currency: form.currency,
        amount: form.amount,
        conversionRate: "1",
        imageUrl: imageUrl || undefined,
      };

      if (editingReceipt) {
        updateReceiptMutation.mutate({
          receiptId: editingReceipt.id,
          data: payload,
        });
      } else {
        createReceiptMutation.mutate({
          userId: user.id,
          data: payload,
        });
      }
    } catch {
      toast({
        title: "Upload failed",
        description: "Unable to upload the selected file.",
        variant: "destructive",
      });
    }
  };

  const handleDelete = (receiptId: number) => {
    deleteReceiptMutation.mutate({ receiptId });
  };

  const isSaving =
    createReceiptMutation.isPending ||
    updateReceiptMutation.isPending ||
    isUploading;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-48 bg-muted rounded-lg"></div>
        <div className="h-32 bg-muted rounded-2xl"></div>
        <div className="h-32 bg-muted rounded-2xl"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl text-red-700 dark:text-red-300">
        <h3 className="font-bold text-lg mb-1">Failed to load receipts</h3>
        <p className="text-sm">Please refresh the page and try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Receipts</h1>
          <p className="text-muted-foreground mt-1">
            Community edition uses simple manual receipt entry and a flat receipt list.
          </p>
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreateDialog} className="rounded-xl">
              <Plus className="w-4 h-4 mr-2" />
              Add Receipt
            </Button>
          </DialogTrigger>

          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{editingReceipt ? "Edit Receipt" : "Add Receipt"}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Company</Label>
                <Select
                  value={form.companyId}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, companyId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((company) => (
                      <SelectItem key={company.id} value={String(company.id)}>
                        {company.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={form.categoryId}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, categoryId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Optional category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={String(category.id)}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Enter receipt description"
                />
              </div>

              <div className="space-y-2">
                <Label>Receipt Date</Label>
                <Input
                  type="date"
                  value={form.receiptDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, receiptDate: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Input
                    value={form.currency}
                    onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value.toUpperCase() }))}
                    placeholder="USD"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Amount</Label>
                  <Input
                    value={form.amount}
                    onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Receipt File</Label>
                <Input
                  type="file"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                />
                <p className="text-xs text-muted-foreground">
                  Community edition supports manual upload and entry only.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setDialogOpen(false);
                    resetForm();
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={isSaving}>
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Saving
                    </>
                  ) : editingReceipt ? (
                    "Update Receipt"
                  ) : (
                    <>
                      <Upload className="w-4 h-4 mr-2" />
                      Create Receipt
                    </>
                  )}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {receipts.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-8 text-center text-muted-foreground">
            No receipts yet. Add your first receipt to begin.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {receipts.map((receipt) => (
            <Card key={receipt.id} className="rounded-2xl">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-4">
                  <span>{receipt.description || "Untitled Receipt"}</span>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEditDialog(receipt)}>
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(receipt.id)}
                      disabled={deleteReceiptMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete
                    </Button>
                  </div>
                </CardTitle>
              </CardHeader>

              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Company:</span>{" "}
                  {receipt.companyName || receipt.companyId}
                </div>
                <div>
                  <span className="text-muted-foreground">Category:</span>{" "}
                  {receipt.categoryName || "Uncategorized"}
                </div>
                <div>
                  <span className="text-muted-foreground">Date:</span>{" "}
                  {receipt.receiptDate || "-"}
                </div>
                <div>
                  <span className="text-muted-foreground">Amount:</span>{" "}
                  {receipt.currency} {receipt.amount}
                </div>
                <div className="md:col-span-2">
                  <span className="text-muted-foreground">Image URL:</span>{" "}
                  {receipt.imageUrl || "No file uploaded"}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
