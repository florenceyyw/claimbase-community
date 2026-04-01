import { useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useListClaimPeriods, useListReceipts, useListCompanies } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Building2, Receipt } from "lucide-react";

export default function Claims() {
  const { user } = useAuth();

  const { data: claims = [], isLoading: loadingClaims, error: claimsError } = useListClaimPeriods(user!.id);
  const { data: receipts = [], isLoading: loadingReceipts } = useListReceipts(user!.id);
  const { data: companies = [], isLoading: loadingCompanies } = useListCompanies(user!.id);

  const isLoading = loadingClaims || loadingReceipts || loadingCompanies;
  const error = claimsError;

  const companyNameMap = useMemo(() => {
    const map = new Map<number, string>();
    companies.forEach((company) => {
      map.set(company.id, company.name);
    });
    return map;
  }, [companies]);

  const unclaimedReceipts = useMemo(() => {
    return receipts.filter((receipt) => !receipt.claimPeriodId);
  }, [receipts]);

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
        <h3 className="font-bold text-lg mb-1">Failed to load claims</h3>
        <p className="text-sm">Please refresh the page and try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-display font-bold">Claims</h1>
        <p className="text-muted-foreground mt-1">
          Community edition provides a simple claim overview. Advanced generation workflows are part of Claimbase Pro.
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
            <CardTitle className="text-sm text-muted-foreground">Claims</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-3xl font-bold">{claims.length}</div>
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <FileText size={24} />
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Unclaimed Receipts</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-3xl font-bold">{unclaimedReceipts.length}</div>
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <Receipt size={24} />
            </div>
          </CardContent>
        </Card>
      </div>

      {claims.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-8 text-center text-muted-foreground">
            No claim records yet. Community edition focuses on simple tracking and basic exports.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {claims.map((claim) => (
            <Card key={claim.id} className="rounded-2xl">
              <CardHeader>
                <CardTitle>{claim.periodLabel}</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Company:</span>{" "}
                  {companyNameMap.get(claim.companyId) || claim.companyId}
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  {claim.status}
                </div>
                <div>
                  <span className="text-muted-foreground">Period Start:</span>{" "}
                  {claim.periodStart}
                </div>
                <div>
                  <span className="text-muted-foreground">Period End:</span>{" "}
                  {claim.periodEnd}
                </div>
                <div>
                  <span className="text-muted-foreground">Base Currency:</span>{" "}
                  {claim.baseCurrency}
                </div>
                <div>
                  <span className="text-muted-foreground">Total Amount:</span>{" "}
                  {claim.totalAmount}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Community Edition Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>- Basic claim records remain visible in the portal.</p>
          <p>- Advanced claim-generation workflows are not included in this edition.</p>
          <p>- PDF, Excel, multi-step review, and richer automation are part of Claimbase Pro.</p>
        </CardContent>
      </Card>
    </div>
  );
}
