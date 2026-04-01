import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getAuthImageUrl(imageUrl: string | null | undefined): string {
  if (!imageUrl) return "";
  const token = localStorage.getItem("claimbase_session_token");
  const baseUrl = imageUrl.startsWith("/api/") ? imageUrl : `/api/storage/${imageUrl.replace(/^\//, "")}`;
  return token ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : baseUrl;
}
