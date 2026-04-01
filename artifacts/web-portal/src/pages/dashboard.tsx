import { useAuth } from "@/lib/auth";
import { useListReceipts, useListCompanies, useListCategories } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format, differenceInCalendarDays, addMonths, subMonths } from "date-fns";
import { Receipt, Building2, TrendingUp, Clock, Tag, ChevronLeft, ChevronRight, DollarSign } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from "recharts";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useMemo } from "react";

const CHART_COLORS = ['#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#0ea5e9'];

interface RateCache {
  [key: string]: number;
}

function useExchangeRates(currencies: string[], targetCurrency: string) {
  const [rates, setRates] = useState<RateCache>({});
  const [loading, setLoading] = useState(false);

  const uniquePairs = useMemo(() => {
    const pairs = new Set<string>();
    currencies.forEach(c => {
      if (c && c !== targetCurrency) pairs.add(c);
    });
    return Array.from(pairs);
  }, [currencies.join(","), targetCurrency]);

  useEffect(() => {
    if (uniquePairs.length === 0) {
      setRates({});
      return;
    }
    let cancelled = false;
    setLoading(true);

    Promise.all(
      uniquePairs.map(async (from) => {
        try {
          const res = await fetch(`/api/currency/rate?from=${from}&to=${targetCurrency}`);
          if (!res.ok) return { from, rate: 1 };
          const data = await res.json();
          return { from, rate: data.rate as number };
        } catch {
          return { from, rate: 1 };
        }
      })
    ).then((results) => {
      if (cancelled) return;
      const newRates: RateCache = {};
      results.forEach(r => { newRates[r.from] = r.rate; });
      setRates(newRates);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [uniquePairs.join(","), targetCurrency]);

  const convert = (amount: number, fromCurrency: string): number => {
    if (fromCurrency === targetCurrency) return amount;
    const rate = rates[fromCurrency];
    if (!rate) return amount;
    return amount * rate;
  };

  return { convert, loading, rates };
}

export default function Dashboard() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const selectedMonth = format(selectedDate, 'yyyy-MM');
  const isCurrentMonth = selectedMonth === format(new Date(), 'yyyy-MM');
  const dashCurrency = user?.dashboardCurrency || "MYR";

  const goToPrevMonth = () => setSelectedDate(d => subMonths(d, 1));
  const goToNextMonth = () => setSelectedDate(d => addMonths(d, 1));
  const goToCurrentMonth = () => setSelectedDate(new Date());
  
  const { data: companies = [], isLoading: loadingCompanies, error: companiesError } = useListCompanies(user!.id);
  const { data: receipts = [], isLoading: loadingReceipts, error: receiptsError } = useListReceipts(user!.id, { month: selectedMonth }, {
    query: { refetchInterval: 10_000 }
  });
  const { data: categories = [], isLoading: loadingCategories } = useListCategories();

  const receiptCurrencies = useMemo(() => receipts.map(r => r.currency), [receipts]);
  const { convert, loading: loadingRates } = useExchangeRates(receiptCurrencies, dashCurrency);

  const isLoading = loadingCompanies || loadingReceipts || loadingCategories;
  const error = companiesError || receiptsError;

  const companyTotals = useMemo(() => {
    return companies.map(company => {
      const compReceipts = receipts.filter(r => r.companyId === company.id);
      const total = compReceipts.reduce((sum, r) => {
        const amt = parseFloat(r.amount || '0') || 0;
        return sum + convert(amt, r.currency);
      }, 0);
      return {
        name: company.name,
        total: Math.round(total * 100) / 100,
        receiptCount: compReceipts.length
      };
    }).filter(c => c.total > 0);
  }, [companies, receipts, convert]);

  const grandTotal = useMemo(() => {
    return receipts.reduce((sum, r) => {
      const amt = parseFloat(r.amount || '0') || 0;
      return sum + convert(amt, r.currency);
    }, 0);
  }, [receipts, convert]);

  const categoryTotals = useMemo(() => {
    const catMap = new Map<string, number>();
    receipts.forEach(r => {
      const catName = r.categoryName || "Uncategorized";
      const amt = parseFloat(r.amount || '0') || 0;
      const converted = convert(amt, r.currency);
      catMap.set(catName, (catMap.get(catName) || 0) + converted);
    });
    return Array.from(catMap.entries())
      .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);
  }, [receipts, convert]);

  const upcomingCutoffs = companies.map(c => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let cutoffDate = new Date(today.getFullYear(), today.getMonth(), c.cutoffDay);
    if (cutoffDate <= today) {
      cutoffDate = new Date(today.getFullYear(), today.getMonth() + 1, c.cutoffDay);
    }
    const daysLeft = differenceInCalendarDays(cutoffDate, today);
    return { ...c, daysLeft, cutoffDate };
  }).sort((a, b) => a.daysLeft - b.daysLeft);

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
        <p className="text-sm">Please check your connection and try refreshing the page.</p>
      </div>
    );
  }

  if (companies.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-display font-bold">Welcome to Claimbase</h1>
          <p className="text-muted-foreground mt-1">Let's get you set up in a few steps.</p>
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
                  <p className="text-sm text-muted-foreground mt-1">Set up the companies you claim expenses for.</p>
                </div>
              </CardContent>
            </Card>
          </Link>
          <Card className="border bg-card opacity-60">
            <CardContent className="p-6 flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-muted text-muted-foreground flex items-center justify-center">
                <Receipt size={28} />
              </div>
              <div>
                <h3 className="font-bold text-foreground">2. Upload Receipts</h3>
                <p className="text-sm text-muted-foreground mt-1">Snap photos and let AI parse the details.</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border bg-card opacity-60">
            <CardContent className="p-6 flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-muted text-muted-foreground flex items-center justify-center">
                <TrendingUp size={28} />
              </div>
              <div>
                <h3 className="font-bold text-foreground">3. Generate Claims</h3>
                <p className="text-sm text-muted-foreground mt-1">Download PDF/Excel claim forms at cut-off.</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const formatCurrency = (value: number) => {
    return `${dashCurrency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Welcome back, {user?.name}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={goToPrevMonth}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <h1 
              className="text-2xl sm:text-3xl font-display font-bold cursor-pointer hover:text-primary transition-colors" 
              onClick={goToCurrentMonth}
              title={isCurrentMonth ? "Current month" : "Click to go to current month"}
            >
              {format(selectedDate, 'MMMM yyyy')}
            </h1>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={goToNextMonth}>
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!isCurrentMonth && (
              <Button variant="outline" size="sm" className="text-xs h-7 ml-1" onClick={goToCurrentMonth}>
                Today
              </Button>
            )}
          </div>
        </div>
        <Link href="/receipts">
          <Button className="rounded-xl shadow-md shadow-primary/20 hover:shadow-lg hover:-translate-y-0.5 transition-all w-full sm:w-auto h-11 px-5 text-sm font-semibold">
            <Receipt className="mr-2 w-4 h-4" /> Add Receipt
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border border-border/60 bg-card premium-shadow rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0">
              <DollarSign size={22} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total</p>
              <h3 className="text-xl font-bold text-foreground mt-0.5 truncate">{formatCurrency(Math.round(grandTotal * 100) / 100)}</h3>
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/60 bg-card premium-shadow rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
              <Receipt size={22} />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Receipts</p>
              <h3 className="text-2xl font-bold text-foreground mt-0.5">{receipts.length}</h3>
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/60 bg-card premium-shadow rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 flex items-center justify-center flex-shrink-0">
              <Building2 size={22} />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Companies</p>
              <h3 className="text-2xl font-bold text-foreground mt-0.5">{companies.length}</h3>
            </div>
          </CardContent>
        </Card>

        {upcomingCutoffs[0] && (
          <Card className="bg-gradient-to-br from-primary to-indigo-600 text-white border-none rounded-2xl" style={{ boxShadow: '0 4px 24px hsl(224 76% 48% / 0.25)' }}>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
                <Clock size={22} className="text-blue-100" />
              </div>
              <div>
                <p className="text-xs font-medium text-blue-200 uppercase tracking-wide">Next Cut-off</p>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <h3 className="text-2xl font-bold text-white">{upcomingCutoffs[0].daysLeft}</h3>
                  <span className="text-sm text-blue-200">days</span>
                </div>
                <p className="text-[11px] text-blue-200/80 mt-0.5">{upcomingCutoffs[0].name}</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card className="premium-shadow border border-border/60 rounded-2xl overflow-hidden">
          <CardHeader className="px-6 pt-5 pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-semibold">
              <TrendingUp className="w-4 h-4 text-primary" /> Expenses by Company
            </CardTitle>
            {loadingRates && <p className="text-xs text-muted-foreground">Converting currencies...</p>}
          </CardHeader>
          <CardContent className="p-6">
            {companyTotals.length > 0 ? (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={companyTotals} margin={{ top: 20, right: 10, left: 10, bottom: 0 }}>
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'currentColor', className: 'fill-muted-foreground' }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'currentColor', className: 'fill-muted-foreground' }} label={{ value: dashCurrency, position: 'top', offset: 10, style: { fontSize: 11, fill: 'hsl(var(--muted-foreground))', textAnchor: 'start' } }} />
                    <Tooltip
                      cursor={{ fill: 'hsl(var(--muted))' }}
                      contentStyle={{ borderRadius: '12px', border: '1px solid hsl(var(--border))', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', backgroundColor: 'hsl(var(--card))' }}
                      labelStyle={{ color: 'hsl(var(--foreground))' }}
                      formatter={(value: number) => [formatCurrency(value), 'Total']}
                    />
                    <Bar dataKey="total" radius={[6, 6, 6, 6]}>
                      {companyTotals.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-muted-foreground">
                <Receipt className="w-12 h-12 mb-3 opacity-20" />
                <p>No expenses logged this month yet.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="premium-shadow border border-border/60 rounded-2xl overflow-hidden">
          <CardHeader className="px-6 pt-5 pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-semibold">
              <Tag className="w-4 h-4 text-primary" /> Expenses by Category
            </CardTitle>
            {loadingRates && <p className="text-xs text-muted-foreground">Converting currencies...</p>}
          </CardHeader>
          <CardContent className="p-6">
            {categoryTotals.length > 0 ? (
              <div className="h-64 w-full flex items-center">
                <div className="w-1/2 h-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={categoryTotals}
                        dataKey="total"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        innerRadius={40}
                      >
                        {categoryTotals.map((_, index) => (
                          <Cell key={`pie-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ borderRadius: '12px', border: '1px solid hsl(var(--border))', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', backgroundColor: 'hsl(var(--card))' }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                        formatter={(value: number) => [formatCurrency(value), 'Total']}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="w-1/2 space-y-1.5 overflow-y-auto max-h-64 pl-2">
                  {categoryTotals.map((cat, i) => (
                    <div key={cat.name} className="flex items-center gap-2 text-sm">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                      <span className="text-foreground truncate flex-1">{cat.name}</span>
                      <span className="text-muted-foreground whitespace-nowrap font-medium">{formatCurrency(cat.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-muted-foreground">
                <Tag className="w-12 h-12 mb-3 opacity-20" />
                <p>No expenses logged this month yet.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <h3 className="text-base font-bold font-display flex items-center gap-2">
          <Clock className="w-4 h-4 text-muted-foreground" /> Upcoming Cut-offs
        </h3>
        <div className="space-y-2">
          {upcomingCutoffs.map(company => (
            <div key={company.id} className="bg-card p-4 rounded-xl border border-border/60 flex items-center justify-between premium-shadow">
              <div>
                <h4 className="font-semibold text-sm text-foreground">{company.name}</h4>
                <p className="text-xs text-muted-foreground mt-0.5">Day {company.cutoffDay} &middot; {company.cutoffTime}</p>
              </div>
              <div className="text-right flex items-center gap-3">
                <div>
                  <div className="text-sm font-bold text-foreground">{company.daysLeft}d left</div>
                  <div className="text-[11px] text-muted-foreground">{format(company.cutoffDate, 'MMM d')}</div>
                </div>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${company.daysLeft <= 3 ? 'bg-red-500' : company.daysLeft <= 7 ? 'bg-amber-500' : 'bg-green-500'}`} />
              </div>
            </div>
          ))}
          {upcomingCutoffs.length === 0 && (
            <p className="text-muted-foreground text-center py-8 text-sm">No companies configured.</p>
          )}
        </div>
      </div>
    </div>
  );
}
