import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useListCompanies, useCreateCompany, useUpdateCompany, useDeleteCompany, CompanyResponse } from "@workspace/api-client-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Trash2, Building2, CalendarClock, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Combobox } from "@/components/ui/combobox";
import { CURRENCY_OPTIONS } from "@/lib/constants";

const companySchema = z.object({
  name: z.string().min(2, "Name is required"),
  baseCurrency: z.string().min(3).max(3),
  cutoffDay: z.coerce.number().min(1).max(31),
  cutoffTime: z.string(),
  cutoffMonthOffset: z.coerce.number().min(0).max(1),
});

export default function Companies() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<CompanyResponse | null>(null);
  
  const { data: companies = [], refetch } = useListCompanies(user!.id);
  
  const createMutation = useCreateCompany({
    mutation: { 
      onSuccess: () => { 
        refetch(); 
        closeDialog(); 
        toast({ title: "Company added" }); 
      },
      onError: () => { toast({ title: "Failed to add company", variant: "destructive" }); }
    }
  });

  const updateMutation = useUpdateCompany({
    mutation: { 
      onSuccess: () => { 
        refetch(); 
        closeDialog(); 
        toast({ title: "Company updated" }); 
      },
      onError: () => { toast({ title: "Failed to update company", variant: "destructive" }); }
    }
  });

  const deleteMutation = useDeleteCompany({
    mutation: { 
      onSuccess: () => { refetch(); toast({ title: "Company deleted" }); },
      onError: () => { toast({ title: "Failed to delete company", variant: "destructive" }); }
    }
  });

  const form = useForm<z.infer<typeof companySchema>>({
    resolver: zodResolver(companySchema),
    defaultValues: { baseCurrency: "USD", cutoffDay: 25, cutoffTime: "23:59", cutoffMonthOffset: 1 }
  });

  const openCreateDialog = () => {
    setEditingCompany(null);
    form.reset({ name: "", baseCurrency: "USD", cutoffDay: 25, cutoffTime: "23:59", cutoffMonthOffset: 1 });
    setDialogOpen(true);
  };

  const openEditDialog = (company: CompanyResponse) => {
    setEditingCompany(company);
    form.reset({
      name: company.name,
      baseCurrency: company.baseCurrency,
      cutoffDay: company.cutoffDay,
      cutoffTime: company.cutoffTime,
      cutoffMonthOffset: company.cutoffMonthOffset ?? 1,
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingCompany(null);
  };

  const onSubmit = (data: z.infer<typeof companySchema>) => {
    if (editingCompany) {
      updateMutation.mutate({ companyId: editingCompany.id, data });
    } else {
      createMutation.mutate({ userId: user!.id, data });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-display font-bold">Companies</h1>
        <Button className="rounded-xl text-sm" onClick={openCreateDialog}>
          <Plus className="mr-1.5 w-4 h-4" /> Add Company
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCompany ? "Edit Company" : "Add New Company"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label>Company Name</Label>
              <Input {...form.register("name")} placeholder="Acme Corp" />
            </div>
            <div className="space-y-2">
              <Label>Base Currency</Label>
              <Combobox
                options={CURRENCY_OPTIONS}
                value={form.watch("baseCurrency")}
                onValueChange={(v) => form.setValue("baseCurrency", v)}
                placeholder="Select currency"
                searchPlaceholder="Type currency code or name..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Cut-off Day (1-31)</Label>
                <Input type="number" {...form.register("cutoffDay")} />
              </div>
              <div className="space-y-2">
                <Label>Cut-off Time</Label>
                <Input type="time" {...form.register("cutoffTime")} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Cut-off Month</Label>
              <div className="flex gap-2">
                <Button type="button" variant={form.watch("cutoffMonthOffset") === 0 ? "default" : "outline"} size="sm" className="flex-1" onClick={() => form.setValue("cutoffMonthOffset", 0)}>
                  Same month
                </Button>
                <Button type="button" variant={form.watch("cutoffMonthOffset") === 1 ? "default" : "outline"} size="sm" className="flex-1" onClick={() => form.setValue("cutoffMonthOffset", 1)}>
                  Following month
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {form.watch("cutoffMonthOffset") === 0
                ? <>Claims for each month must be submitted by day {form.watch("cutoffDay")} of the <span className="font-semibold">same month</span>. e.g. March claims are due by March {form.watch("cutoffDay")}th.</>
                : <>Claims for each month must be submitted by day {form.watch("cutoffDay")} of the <span className="font-semibold">following month</span>. e.g. March claims are due by April {form.watch("cutoffDay")}th.</>
              }
            </p>
            <Button type="submit" className="w-full" disabled={isSaving}>
              {isSaving ? "Saving..." : editingCompany ? "Update Company" : "Save Company"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {companies.length === 0 && (
          <div className="col-span-full text-center py-16 px-4 border-2 border-dashed border-border rounded-2xl bg-muted/50">
            <Building2 className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-foreground">No companies yet</h3>
            <p className="text-muted-foreground mt-1 max-w-sm mx-auto">Add a company to start tracking expenses and generating claim forms.</p>
            <Button className="rounded-xl mt-4" onClick={openCreateDialog}>
              <Plus className="mr-2 w-4 h-4" /> Add Your First Company
            </Button>
          </div>
        )}
        {companies.map(company => (
          <Card key={company.id} className="border border-border/60 bg-card premium-shadow rounded-2xl">
            <CardContent className="p-5">
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 flex items-center justify-center flex-shrink-0">
                    <Building2 size={20} />
                  </div>
                  <div>
                    <h3 className="font-bold text-foreground">{company.name}</h3>
                    <p className="text-sm text-muted-foreground">Base Currency: {company.baseCurrency}</p>
                  </div>
                </div>
                <div className="flex gap-0.5">
                  <Button variant="ghost" size="icon" className="w-8 h-8 text-muted-foreground hover:text-primary" onClick={() => openEditDialog(company)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="w-8 h-8 text-muted-foreground hover:text-destructive" onClick={() => {
                    if(confirm('Delete company?')) deleteMutation.mutate({ companyId: company.id })
                  }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-3.5 pt-3.5 border-t border-border/60 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CalendarClock className="w-3.5 h-3.5 text-primary" />
                Claim cut-off: {company.cutoffDay === 31 ? "Last day" : `Day ${company.cutoffDay}`} of the {company.cutoffMonthOffset === 0 ? "same" : "following"} month at {company.cutoffTime}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
