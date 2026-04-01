import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { UserResponse } from "@workspace/api-client-react";
import { Loader2, Wallet, MessageCircle, ShieldCheck, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AuthContextType {
  user: UserResponse | null;
  isLoading: boolean;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function getTelegramInitData(): string | null {
  // @ts-expect-error - Telegram global
  return window.Telegram?.WebApp?.initData || null;
}

function hasInitData(): boolean {
  return !!(getTelegramInitData() || localStorage.getItem("mock_init_data") || localStorage.getItem("claimbase_session_token"));
}

async function fetchMe(): Promise<UserResponse | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function webappLogin(initData: string): Promise<{ token: string; user: UserResponse } | null> {
  try {
    const res = await fetch("/api/auth/webapp-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function registerUser(name?: string): Promise<UserResponse> {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
  return res.json();
}

async function telegramWidgetLogin(data: Record<string, string>): Promise<{ token: string; user: UserResponse }> {
  const res = await fetch("/api/auth/telegram-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  return res.json();
}

async function requestOtp(telegramUsername: string): Promise<{ success?: boolean; error?: string }> {
  const res = await fetch("/api/auth/request-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ telegramUsername }),
  });
  const data = await res.json();
  if (!res.ok) return { error: data.error || "Failed to send code" };
  return { success: true };
}

async function verifyOtp(telegramUsername: string, code: string): Promise<{ token?: string; user?: UserResponse; error?: string }> {
  const res = await fetch("/api/auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ telegramUsername, code }),
  });
  const data = await res.json();
  if (!res.ok) return { error: data.error || "Verification failed" };
  return data;
}

declare global {
  interface Window {
    onTelegramAuth?: (user: Record<string, string>) => void;
  }
}

function TelegramLoginButton() {
  const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME;
  const [widgetReady, setWidgetReady] = useState(false);

  useEffect(() => {
    if (!BOT_USERNAME) return;

    window.onTelegramAuth = async (tgUser: Record<string, string>) => {
      try {
        const result = await telegramWidgetLogin(tgUser);
        localStorage.setItem("claimbase_session_token", result.token);
        window.location.reload();
      } catch {
        alert("Telegram login failed. Please try again.");
      }
    };

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", BOT_USERNAME);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "12");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    script.async = true;

    const container = document.getElementById("telegram-login-container");
    if (container) {
      container.innerHTML = "";
      container.appendChild(script);
    }

    const timer = setTimeout(() => {
      const iframe = container?.querySelector("iframe");
      if (iframe && iframe.offsetHeight >= 10) {
        setWidgetReady(true);
      }
    }, 2000);

    return () => {
      clearTimeout(timer);
      delete window.onTelegramAuth;
    };
  }, [BOT_USERNAME]);

  if (!BOT_USERNAME) return null;

  return (
    <div
      id="telegram-login-container"
      className="flex justify-center py-2"
      style={{ display: widgetReady ? "flex" : "none" }}
    />
  );
}

const BOT_LINK = "https://t.me/claimbase_bot";

type LoginStep = "username" | "otp";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showLogin, setShowLogin] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);

  const [loginStep, setLoginStep] = useState<LoginStep>("username");
  const [loginUsername, setLoginUsername] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadUser = async () => {
    const tgInitData = getTelegramInitData();

    if (tgInitData) {
      try {
        const result = await webappLogin(tgInitData);
        if (result) {
          localStorage.setItem("claimbase_session_token", result.token);
          setUser(result.user);
          setShowLogin(false);
          setShowRegister(false);
          setIsLoading(false);
          return;
        }
      } catch {}
    }

    if (!hasInitData()) {
      setShowLogin(true);
      setIsLoading(false);
      return;
    }
    try {
      const userData = await fetchMe();
      if (userData) {
        setUser(userData);
        setShowLogin(false);
        setShowRegister(false);
      } else {
        if (tgInitData || localStorage.getItem("mock_init_data")) {
          setShowRegister(true);
        } else {
          localStorage.removeItem("claimbase_session_token");
          setShowLogin(true);
        }
      }
    } catch {
      setShowLogin(true);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    // @ts-expect-error - Telegram global
    const tgApp = window.Telegram?.WebApp;
    if (tgApp?.initData) {
      tgApp.ready();
      tgApp.expand();
    }
    loadUser();
  }, []);

  const handleRequestOtp = async () => {
    if (!loginUsername.trim()) return;
    setIsSubmitting(true);
    setLoginError("");
    try {
      const result = await requestOtp(loginUsername.trim());
      if (result.error) {
        setLoginError(result.error);
      } else {
        setLoginStep("otp");
        setOtpCode("");
      }
    } catch {
      setLoginError("Something went wrong. Please try again.");
    }
    setIsSubmitting(false);
  };

  const handleVerifyOtp = async () => {
    if (!otpCode.trim()) return;
    setIsSubmitting(true);
    setLoginError("");
    try {
      const result = await verifyOtp(loginUsername.trim(), otpCode.trim());
      if (result.error) {
        setLoginError(result.error);
      } else if (result.token && result.user) {
        localStorage.setItem("claimbase_session_token", result.token);
        setUser(result.user);
        setShowLogin(false);
      }
    } catch {
      setLoginError("Verification failed. Please try again.");
    }
    setIsSubmitting(false);
  };

  const handleBackToUsername = () => {
    setLoginStep("username");
    setOtpCode("");
    setLoginError("");
  };

  const handleRegister = async () => {
    setIsRegistering(true);
    try {
      const newUser = await registerUser();
      setUser(newUser);
      setShowRegister(false);
    } catch {
      setShowLogin(true);
      setShowRegister(false);
    }
    setIsRegistering(false);
  };

  const logout = () => {
    localStorage.removeItem("mock_init_data");
    localStorage.removeItem("claimbase_session_token");
    setUser(null);
    setShowLogin(true);
    setLoginStep("username");
    setLoginUsername("");
    setOtpCode("");
    setLoginError("");
  };

  const refreshUser = useCallback(async () => {
    try {
      const userData = await fetchMe();
      if (userData) setUser(userData);
    } catch {}
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
      </div>
    );
  }

  if (showRegister) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="text-center pb-2">
            <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Wallet size={32} />
            </div>
            <CardTitle className="text-2xl">Welcome to Claimbase</CardTitle>
            <CardDescription>Create your account to start tracking expenses.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleRegister}
              className="w-full h-12 text-lg font-medium"
              disabled={isRegistering}
            >
              {isRegistering ? "Creating Account..." : "Create My Account"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (showLogin || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-4">
          <Card className="shadow-lg border border-border/60">
            <CardHeader className="text-center pb-2">
              <div className="w-14 h-14 bg-gradient-to-br from-blue-400 to-indigo-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-500/20">
                <Wallet size={28} className="text-white" />
              </div>
              <CardTitle className="text-2xl">Claimbase</CardTitle>
              <CardDescription>
                {loginStep === "username"
                  ? "Sign in with your Telegram account"
                  : "Enter the verification code sent to your Telegram"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 pt-4">
              <TelegramLoginButton />

              {loginStep === "username" ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="telegram-username">Telegram Username</Label>
                    <Input
                      id="telegram-username"
                      placeholder="e.g. johndoe"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleRequestOtp()}
                    />
                  </div>
                  {loginError && (
                    <p className="text-sm text-red-500 text-center">{loginError}</p>
                  )}
                  <Button
                    onClick={handleRequestOtp}
                    className="w-full h-11"
                    disabled={isSubmitting || !loginUsername.trim()}
                  >
                    {isSubmitting ? (
                      <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Sending code...</>
                    ) : (
                      <><ShieldCheck className="w-4 h-4 mr-2" /> Send Verification Code</>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg text-sm text-blue-700 dark:text-blue-300 flex items-start gap-2">
                    <MessageCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>
                      A 6-digit code was sent to <strong>@{loginUsername}</strong> on Telegram. Check your chat with @claimbase_bot.
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="otp-code">Verification Code</Label>
                    <Input
                      id="otp-code"
                      placeholder="Enter 6-digit code"
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      onKeyDown={(e) => e.key === "Enter" && handleVerifyOtp()}
                      maxLength={6}
                      className="text-center text-lg tracking-widest font-mono"
                      autoFocus
                    />
                  </div>
                  {loginError && (
                    <p className="text-sm text-red-500 text-center">{loginError}</p>
                  )}
                  <Button
                    onClick={handleVerifyOtp}
                    className="w-full h-11"
                    disabled={isSubmitting || otpCode.length !== 6}
                  >
                    {isSubmitting ? (
                      <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Verifying...</>
                    ) : (
                      "Verify & Sign In"
                    )}
                  </Button>
                  <div className="flex items-center justify-between">
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={handleBackToUsername}>
                      Change username
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={handleRequestOtp}
                      disabled={isSubmitting}
                    >
                      Resend code
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-dashed border-muted-foreground/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-primary" />
                New here?
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                To use Claimbase, you first need to register through our Telegram bot.
                The bot lets you snap and upload receipts directly from your phone.
              </p>
              <ol className="text-xs text-muted-foreground space-y-1.5 mb-3">
                <li className="flex items-start gap-2">
                  <span className="bg-primary/10 text-primary rounded-full w-5 h-5 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">1</span>
                  <span>Open <strong>@claimbase_bot</strong> on Telegram</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="bg-primary/10 text-primary rounded-full w-5 h-5 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">2</span>
                  <span>Tap <strong>Start</strong> and follow the setup</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="bg-primary/10 text-primary rounded-full w-5 h-5 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">3</span>
                  <span>Come back here and sign in with your username</span>
                </li>
              </ol>
              <a
                href={BOT_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                Open @claimbase_bot on Telegram <ArrowRight className="w-3 h-3" />
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, isLoading, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
