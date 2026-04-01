import { useAuth } from "@/lib/auth";
import { useUpdateUser } from "@workspace/api-client-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, LogOut } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Combobox } from "@/components/ui/combobox";
import { CURRENCY_OPTIONS, TIMEZONE_OPTIONS } from "@/lib/constants";

const profileSchema = z.object({
  name: z.string().min(2, "Name is required"),
  timezone: z.string().min(2, "Timezone is required"),
  dashboardCurrency: z.string().min(2, "Currency is required"),
});

export default function Profile() {
  const { user, logout, refreshUser } = useAuth();
  const { toast } = useToast();
  
  const updateMutation = useUpdateUser({
    mutation: { 
      onSuccess: () => {
        toast({ title: "Profile updated successfully" });
        refreshUser();
      },
      onError: () => toast({ title: "Failed to update profile", variant: "destructive" })
    }
  });

  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user?.name || "",
      timezone: user?.timezone || "UTC",
      dashboardCurrency: user?.dashboardCurrency || "MYR",
    }
  });

  const onSubmit = (data: z.infer<typeof profileSchema>) => {
    updateMutation.mutate({ userId: user!.id, data });
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <h1 className="text-3xl font-display font-bold">Profile</h1>
      
      <Card className="border bg-card premium-shadow">
        <CardHeader className="pb-4 border-b border-border mb-6">
          <CardTitle className="flex items-center gap-2">
            <User className="text-primary w-5 h-5" /> Account Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-2">
              <Label>Telegram ID (Read-only)</Label>
              <Input disabled value={user?.telegramId} className="bg-muted text-muted-foreground" />
            </div>
            
            <div className="space-y-2">
              <Label>Full Name</Label>
              <Input {...form.register("name")} />
            </div>
            
            <div className="space-y-2">
              <Label>Timezone</Label>
              <Combobox
                options={TIMEZONE_OPTIONS}
                value={form.watch("timezone")}
                onValueChange={(v) => form.setValue("timezone", v)}
                placeholder="Select timezone"
                searchPlaceholder="Type to search timezone..."
              />
            </div>

            <div className="space-y-2">
              <Label>Dashboard Currency</Label>
              <p className="text-xs text-muted-foreground">All chart values will be converted to this currency.</p>
              <Combobox
                options={CURRENCY_OPTIONS}
                value={form.watch("dashboardCurrency")}
                onValueChange={(v) => form.setValue("dashboardCurrency", v)}
                placeholder="Select currency"
                searchPlaceholder="Type currency code or name..."
              />
            </div>

            <div className="flex gap-4 pt-4 border-t border-border">
              <Button type="submit" className="flex-1 rounded-xl" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
              <Button type="button" variant="destructive" className="rounded-xl px-6" onClick={logout}>
                <LogOut className="w-4 h-4 mr-2" /> Logout
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
