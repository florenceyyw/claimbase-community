import { useAuth } from "@/lib/auth";
import { useListReceipts, useListCompanies } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Receipt, Building2, FileText, Settings } from "lucide-react";
import { Link } from "wouter";

export default function Dashboard() {
  const { user } = useAuth();

  const { data: companies = [], isLoading: loadingCompanies, error: companiesError } = useListCompanies(user!.id);
  const { data: receipts = [], isLoading: loadingReceipts, error: receiptsError } = useListReceipts(user!.id);

  const isLoading = loadingCompanies || loadingReceipts;
  const error = companiesError || receiptsError;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-48 bg-muted rounded-lg"></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="h-32 bg-muted rounded-2xl"></div>
          <div className="h-32 bg-muted rounded-2xl"></div>
          <div className="h-32 bg-muted rounded-2xl"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl text-red-700 dark:text-red-300">
        <h3 className="font-bold text-lg mb-1">Failed to load dashboard</h3>
        <p className="text-sm">Please refresh the page and try again.</p>
      </div>
    );
  }

  if (companies.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-display font-bold">Welcome to Claimbase Community Edition</h1>
          <p className="text-muted-foreground mt-1">
            Set up a company, add receipts, and manage simple CSV-based claim workflows.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Link href="/companies">
            <Card className="border-2 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors cursor-pointer h-full">
              <CardContent className="p-6 flex flex-col items-center text-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                  <Building2 size={28} />
                </div>
                <div>
                  <h3 className="font-bold text-foreground">1. Add a Company</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Create the company you want to manage receipts for.
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/receipts">
            <Card className="border bg-card hover:bg-muted/30 transition-colors cursor-pointer h-full">
              <CardContent className="p-6 flex flex-col items-center text-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-muted text-muted-foreground flex items-center justify-center">
                  <Receipt size={28} />
                </div>
                <div>
                  <h3 className="font-bold text-foreground">2. Add Receipts</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Upload receipts and enter details manually.
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/claims">
            <Card className="border bg-card hover:bg-muted/30 transition-colors cursor-pointer h-full">
              <CardContent className="p-6 flex flex-col items-center text-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-muted text-muted-foreground flex items-center justify-center">
                  <FileText size={28} />
                </div>
                <div>
                  <h3 className="font-bold text-foreground">3. Export Claims</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Use simple community claim workflows and CSV exports.
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Welcome back, {user?.name}</p>
        <h1 className="text-3xl font-display font-bold mt-1">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Community edition overview with simple counts and quick links.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Companies</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-3xl font-bold">{companies.length}</div>
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <Building2 size={24} />
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Receipts</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-3xl font-bold">{receipts.length}</div>
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <Receipt size={24} />
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Status</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-lg font-semibold">Community Edition</div>
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <Settings size={24} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link href="/companies">
            <div className="rounded-xl border p-4 hover:bg-muted/30 transition-colors cursor-pointer">
              <div className="font-semibold">Manage Companies</div>
              <div className="text-sm text-muted-foreground mt-1">
                Add or update company settings.
              </div>
            </div>
          </Link>

          <Link href="/receipts">
            <div className="rounded-xl border p-4 hover:bg-muted/30 transition-colors cursor-pointer">
              <div className="font-semibold">Manage Receipts</div>
              <div className="text-sm text-muted-foreground mt-1">
                Upload receipts and edit details manually.
              </div>
            </div>
          </Link>

          <Link href="/claims">
            <div className="rounded-xl border p-4 hover:bg-muted/30 transition-colors cursor-pointer">
              <div className="font-semibold">View Claims</div>
              <div className="text-sm text-muted-foreground mt-1">
                Review simple claim records and exports.
              </div>
            </div>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
