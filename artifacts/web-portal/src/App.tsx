import "./lib/fetch-patch"; // MUST BE FIRST TO PATCH FETCH FOR API CALLS
import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import { setAuthTokenGetter } from "@workspace/api-client-react";

import Dashboard from "@/pages/dashboard";
import Receipts from "@/pages/receipts";
import Companies from "@/pages/companies";
import Categories from "@/pages/categories";
import Claims from "@/pages/claims";
import Profile from "@/pages/profile";

setAuthTokenGetter(async () => {
  // @ts-expect-error - Telegram global
  const tgInitData = window.Telegram?.WebApp?.initData;
  if (tgInitData) return null;
  return localStorage.getItem("claimbase_session_token");
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

function useDarkMode() {
  useEffect(() => {
    function applyTheme() {
      // @ts-expect-error - Telegram global
      const tg = window.Telegram?.WebApp;
      const tgDark = tg?.colorScheme === "dark";
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (tgDark || systemDark) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    }
    applyTheme();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);
    // @ts-expect-error - Telegram global
    window.Telegram?.WebApp?.onEvent?.("themeChanged", applyTheme);
    return () => {
      mq.removeEventListener("change", applyTheme);
      // @ts-expect-error - Telegram global
      window.Telegram?.WebApp?.offEvent?.("themeChanged", applyTheme);
    };
  }, []);
}

function ProtectedRouter() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/receipts" component={Receipts} />
        <Route path="/companies" component={Companies} />
        <Route path="/categories" component={Categories} />
        <Route path="/claims" component={Claims} />
        <Route path="/profile" component={Profile} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  useDarkMode();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <ProtectedRouter />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
