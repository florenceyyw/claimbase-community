import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useListCategories, useCreateCategory, useUpdateCategory, useDeleteCategory, CategoryResponse } from "@workspace/api-client-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Trash2, Tag, Lock, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const categorySchema = z.object({
  name: z.string().min(2, "Name is required"),
  description: z.string().optional()
});

export default function Categories() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<CategoryResponse | null>(null);
  
  const { data: categories = [], refetch } = useListCategories({ userId: user!.id });
  
  const createMutation = useCreateCategory({
    mutation: { 
      onSuccess: () => { refetch(); closeDialog(); toast({ title: "Category added" }); },
      onError: () => { toast({ title: "Failed to add category", variant: "destructive" }); }
    }
  });

  const updateMutation = useUpdateCategory({
    mutation: { 
      onSuccess: () => { refetch(); closeDialog(); toast({ title: "Category updated" }); },
      onError: () => { toast({ title: "Failed to update category", variant: "destructive" }); }
    }
  });

  const deleteMutation = useDeleteCategory({
    mutation: { 
      onSuccess: () => { refetch(); toast({ title: "Category deleted" }); },
      onError: () => { toast({ title: "Failed to delete category", variant: "destructive" }); }
    }
  });

  const form = useForm<z.infer<typeof categorySchema>>({
    resolver: zodResolver(categorySchema),
    defaultValues: { name: "", description: "" }
  });

  const openCreateDialog = () => {
    setEditingCategory(null);
    form.reset({ name: "", description: "" });
    setDialogOpen(true);
  };

  const openEditDialog = (category: CategoryResponse) => {
    setEditingCategory(category);
    form.reset({ name: category.name, description: category.description || "" });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingCategory(null);
  };

  const onSubmit = (data: z.infer<typeof categorySchema>) => {
    if (editingCategory) {
      updateMutation.mutate({ categoryId: editingCategory.id, data });
    } else {
      createMutation.mutate({ data: { ...data, userId: user!.id } });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const systemCats = categories.filter(c => c.isSystem);
  const customCats = categories.filter(c => !c.isSystem);

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-display font-bold">Categories</h1>
        <Button className="rounded-xl text-sm" onClick={openCreateDialog}>
          <Plus className="mr-1.5 w-4 h-4" /> Add Custom
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCategory ? "Edit Category" : "Add Custom Category"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input {...form.register("name")} placeholder="e.g. Subscriptions" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input {...form.register("description")} placeholder="Optional description" />
            </div>
            <Button type="submit" className="w-full" disabled={isSaving}>
              {isSaving ? "Saving..." : editingCategory ? "Update Category" : "Save Category"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {systemCats.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold font-display px-1">System Defaults</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {systemCats.map(cat => (
              <Card key={cat.id} className="bg-muted/50 border-border shadow-sm">
                <CardContent className="p-4 flex items-start gap-3">
                  <Lock className="w-4 h-4 text-muted-foreground mt-1 flex-shrink-0" />
                  <div>
                    <h4 className="font-bold text-foreground">{cat.name}</h4>
                    {cat.description && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{cat.description}</p>}
                    {cat.examples && <p className="text-xs text-muted-foreground/70 mt-1 italic">Ex: {cat.examples}</p>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-xl font-bold font-display px-1">Your Custom Categories</h2>
        {customCats.length === 0 ? (
          <div className="text-center py-8 px-4 border-2 border-dashed border-border rounded-2xl bg-muted/50">
            <Tag className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground text-sm max-w-sm mx-auto">No custom categories yet. Add your own to organize expenses beyond the system defaults.</p>
            <Button className="rounded-xl mt-4" size="sm" onClick={openCreateDialog}>
              <Plus className="mr-2 w-4 h-4" /> Add Custom Category
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {customCats.map(cat => (
              <Card key={cat.id} className="border bg-card">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Tag className="w-5 h-5 text-primary" />
                    <div>
                      <h4 className="font-bold text-foreground">{cat.name}</h4>
                      {cat.description && <p className="text-xs text-muted-foreground">{cat.description}</p>}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEditDialog(cat)}>
                      <Pencil className="w-4 h-4 text-muted-foreground hover:text-primary" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => {
                      if(confirm('Delete category?')) deleteMutation.mutate({ categoryId: cat.id })
                    }}>
                      <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
