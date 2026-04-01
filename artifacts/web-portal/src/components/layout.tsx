import { Link, useLocation } from "wouter";
import { LayoutDashboard, Receipt, Building2, Tags, FileText, User } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/receipts", label: "Receipts", icon: Receipt },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/categories", label: "Categories", icon: Tags },
  { href: "/claims", label: "Claims", icon: FileText },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row pb-16 md:pb-0 overflow-x-hidden">
      <aside className="hidden md:flex flex-col w-[260px] sidebar-bg fixed h-full z-10">
        <div className="p-6 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-blue-500/20">
            C
          </div>
          <span className="font-display font-bold text-xl tracking-tight" style={{ color: 'hsl(var(--sidebar-foreground))' }}>Claimbase</span>
        </div>
        
        <nav className="flex-1 px-3 space-y-0.5 mt-2 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={cn(
                "flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-200 text-[14px] font-medium",
                isActive 
                  ? "bg-white/10 text-white" 
                  : "text-white/50 hover:text-white/80 hover:bg-white/5"
              )}>
                <Icon className={cn("w-[18px] h-[18px]", isActive ? "text-blue-400" : "text-white/40")} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/8">
          <Link href="/profile" className={cn(
            "flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-200 text-[14px] font-medium",
            location === "/profile" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80 hover:bg-white/5"
          )}>
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
              <User size={14} className="text-white/70" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold truncate w-32">{user?.name}</span>
              <span className="text-[11px] text-white/40">View Profile</span>
            </div>
          </Link>
        </div>
      </aside>

      <main className="flex-1 md:ml-[260px] w-full min-w-0">
        <header className="md:hidden bg-card border-b border-border p-4 sticky top-0 z-10 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white font-bold text-sm shadow-md shadow-blue-500/20">
              C
            </div>
            <span className="font-display font-bold text-lg text-foreground">Claimbase</span>
          </div>
          <Link href="/profile">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center border border-border">
              <User size={15} className="text-muted-foreground" />
            </div>
          </Link>
        </header>
        
        <div className="p-4 md:p-8 lg:p-10 max-w-6xl mx-auto w-full animate-in fade-in slide-in-from-bottom-3 duration-400">
          {children}
        </div>
      </main>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-card/90 backdrop-blur-xl border-t border-border flex justify-around px-1 py-1.5 z-50 pb-safe">
        {navItems.slice(0, 5).map((item) => {
          const Icon = item.icon;
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href} className="flex flex-col items-center py-1.5 px-3 rounded-xl">
              <div className={cn(
                "p-1.5 rounded-lg transition-all",
                isActive ? "bg-primary/10 text-primary" : "text-muted-foreground"
              )}>
                <Icon className={cn("w-5 h-5", isActive && "stroke-[2.5px]")} />
              </div>
              <span className={cn(
                "text-[10px] mt-0.5 font-medium",
                isActive ? "text-primary" : "text-muted-foreground"
              )}>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
