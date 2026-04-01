# Claimbase - Expense Claim Management System

## Overview

Telegram bot + web portal for employees to submit expense receipts throughout the month, with AI receipt parsing, automatic claim form generation (PDF/Excel), and scheduled cut-off processing.

**Telegram Bot**: t.me/claimbase_bot (`@claimbase_bot`, configurable via VITE_TELEGRAM_BOT_USERNAME)  
**Architecture**: pnpm workspace monorepo using TypeScript

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)
- **Telegram Bot**: Telegraf 4.x (polling mode)
- **AI**: Replit AI proxy (OpenAI-compatible, GPT vision for receipt parsing, pdf-parse for PDF text extraction)
- **PDF Generation**: PDFKit
- **Excel Generation**: ExcelJS
- **Scheduling**: node-cron (5-minute intervals)
- **Currency**: exchangerate-api.com (free, no key needed, 1-hour cache)
- **Web Portal**: React 19 + Vite (Telegram Mini App)
- **UI Components**: shadcn/ui + Tailwind CSS
- **Routing**: wouter
- **Charts**: Recharts
- **Forms**: react-hook-form + zod
- **State**: TanStack React Query (generated hooks via Orval)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── web-portal/            # React + Vite web portal (Telegram Mini App)
│   │   └── src/
│   │       ├── App.tsx        # Entry: routes, providers, dark mode detection (Telegram + system)
│   │       ├── lib/
│   │       │   ├── auth.tsx       # Auth context (Telegram WebApp + OTP login via bot)
│   │       │   └── fetch-patch.ts # Injects auth headers on API calls
│   │       ├── hooks/
│   │       │   └── use-upload.ts  # File upload via presigned URLs
│   │       ├── pages/
│   │       │   ├── dashboard.tsx  # Overview, charts, cut-off countdowns
│   │       │   ├── receipts.tsx   # Receipt CRUD + AI image parsing, grouped by company + month
│   │       │   ├── companies.tsx  # Company management
│   │       │   ├── categories.tsx # Custom + system categories
│   │       │   ├── claims.tsx     # Claim periods with partial receipt selection, status badges (Downloaded/Submitted), Mark as Submitted toggle, PDF/Excel/receipt proofs download
│   │       │   └── profile.tsx    # User profile settings
│   │       └── components/
│   │           └── layout.tsx     # Desktop sidebar + mobile tab bar
│   └── api-server/            # Express API + Telegram bot
│       └── src/
│           ├── index.ts       # Entry: starts Express, bot, scheduler
│           ├── app.ts         # Express app setup
│           ├── bot/
│           │   └── index.ts   # Telegram bot (all commands + flows)
│           ├── lib/
│           │   ├── ai.ts              # AI receipt image parsing (GPT vision)
│           │   ├── currency.ts        # Exchange rate fetching + cache
│           │   ├── claimGenerator.ts  # PDF + Excel claim form generation
│           │   ├── scheduler.ts       # Cron job for cut-off processing
│           │   ├── otp.ts             # OTP generation (crypto), verification, rate limiting, Telegram send
│           │   ├── logger.ts          # Pino logger
│           │   ├── objectStorage.ts   # Object storage service
│           │   ├── objectAcl.ts       # Object ACL
│           │   ├── native-fetch-shim.ts     # Node.js native fetch shim (for telegraf compat)
│           │   └── abort-controller-shim.ts # Native AbortController shim (for telegraf compat)
│           └── routes/
│               ├── index.ts        # Route barrel
│               ├── health.ts       # GET /healthz
│               ├── users.ts        # User CRUD
│               ├── companies.ts    # Company CRUD
│               ├── categories.ts   # Category CRUD
│               ├── receipts.ts     # Receipt CRUD + AI parsing
│               ├── currencyRoute.ts # Exchange rate lookup
│               ├── claims.ts       # Claim period management + download
│               └── storage.ts      # Object storage upload/download
├── lib/
│   ├── api-spec/          # OpenAPI spec + Orval codegen config
│   ├── api-client-react/  # Generated React Query hooks
│   ├── api-zod/           # Generated Zod schemas
│   └── db/                # Drizzle ORM schema + connection
│       └── src/schema/
│           ├── users.ts
│           ├── companies.ts
│           ├── categories.ts
│           ├── receipts.ts
│           └── claimPeriods.ts
├── scripts/               # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Database Schema

- **users**: telegramId, name, timezone (GMT offset like "+08:00"), dashboardCurrency (ISO code, default MYR)
- **companies**: userId, name, baseCurrency, cutoffDay (1-31), cutoffTime (HH:MM), cutoffMonthOffset (0=same month, 1=following month; default 1)
- **categories**: name, description, examples, isSystem, userId (null for system)
- **receipts**: userId, companyId, categoryId, description, receiptDate, currency, amount, conversionRate, convertedAmount, imageUrl, claimMonth (nullable varchar(7) YYYY-MM — override for which claim period this receipt belongs to)
- **claim_periods**: userId, companyId, periodLabel (YYYY-MM), periodStart, periodEnd, status, pdfUrl, excelUrl, baseCurrency, totalAmount

9 system categories seeded: Travel, Meals & Entertainment, Equipment & Tools, Utilities, Software Purchases & Subscriptions, Transportation, Office Supplies & Stationery, Telecommunications, Miscellaneous / Others

## Key Design Decisions

- **Node.js v24 Compatibility**: esbuild aliases `node-fetch` and `abort-controller` to native shims because Telegraf uses `node-fetch@2` and `abort-controller` polyfill, which have `instanceof` check issues with Node.js v24's native fetch/AbortController
- **Bot uses polling mode** (not webhooks) for development simplicity
- **Bulk receipt upload**: Both bot (media groups via Telegram) and web portal (multi-file select) support bulk uploads. AI parses each image, auto-detects currency, and applies conversion rates. Web portal uses direct API calls (not mutation hooks) to avoid per-item refetch/toast spam.
- **AI receipt parsing**: GPT vision extracts amount, currency, date, description + suggests category (system category name) and detects receipt type ("standard" vs "transfer"/bank payment proofs)
- **Bot receipt flow**: After AI parse, bot shows detected details and prompts user to type a description before saving. Transfer receipts also prompt for category selection. Bulk uploads save with "Needs description" placeholder and direct user to portal to add descriptions.
- **Currency conversion**: rates fetched from free API with 1-hour cache; users confirm/adjust rates in currency confirmation dialog before claim generation
- **Currency confirmation before export**: When generating a claim, users see all receipts with their conversion rates, can refresh rates or manually adjust per-receipt, and totals recalculate live before confirming. Rate overrides are applied to receipts server-side before PDF/Excel generation.
- **Receipt-to-period matching**: Receipts are matched to claim periods by their `createdAt` month (upload timestamp), NOT by `receiptDate`. A January-dated receipt uploaded in March belongs to March's claim period.
- **Claim periods = calendar months**: Period always spans 1st to last day of the month. The `periodLabel` (YYYY-MM) is the canonical identifier.
- **Cutoff month flexibility**: `cutoffMonthOffset` (0 = same month, 1 = following month). When 0, cutoff day X of the same month means claims for that month are due by day X of that month. When 1 (default), cutoff day X means claims for the previous month are due by day X of the following month.
- **Per-company cut-off**: each company has its own cutoff day/time/month offset; scheduler checks every 5 minutes
- **Flexible receipt inclusion**: Receipts from any month can be included in any claim — receipt date does not restrict which claim period they belong to. Users select a "claim period" label and then choose from all unclaimed receipts for the company.
- **Claim period override (claimMonth)**: Receipts can have an optional `claimMonth` (YYYY-MM) override. When set, the receipt is grouped into that month's claim instead of its receipt date month. Useful for late receipts whose original month already has a submitted claim. The edit dialog shows a "Claim in Period" selector. Late receipts (whose month already has a completed claim) get an amber "Late" badge.
- **Saved descriptions**: localStorage-based; users can manually add descriptions via "+" button on the Saved Descriptions card, or they auto-save from receipt entries (min 10 chars). Max 50 entries.
- **Monthly reminders**: Scheduler sends Telegram notifications 3 days and 1 day before each company's cutoff date. Uses proper cross-month date math, company-level dedup, and createdAt-month receipt counts.
- **Claim forms**: generated on-the-fly when downloading; can be manually generated from web portal or auto-generated at cutoff. PDF includes receipt images as "Supporting Documents" appendix. Excel includes receipt image hyperlinks.
- **Claims page shows pending receipts**: Companies with unclaimed receipts (no claim period for that createdAt month) appear with dashed-border "Pending claim" cards alongside existing claims.
- **Uncategorized receipt warnings**: Web portal highlights uncategorized receipts with amber borders and shows a warning banner with count
- **Web login**: OTP-based authentication — user enters Telegram username, receives a 6-digit code via the bot on Telegram, enters code to get a session token. Uses cryptographic randomness (`crypto.randomInt`), 5-minute expiry, rate-limited to 3 requests per 10 minutes, max 5 verification attempts. New users are guided to register with the bot first.
- **Dashboard currency**: User sets a `dashboardCurrency` in Profile (default MYR). All dashboard charts (Expenses by Company, Expenses by Category) convert receipt amounts to this currency via the exchange rate API. Category chart uses a donut/pie visualization with a legend. Y-axis shows currency label.
- **Bot onboarding flow**: register_name → register_timezone → register_country (inline keyboard sets dashboardCurrency) → register_company_name → register_company_currency → register_cutoff_month (same/following month inline keyboard) → register_cutoff_day → creates user + company.
- **API auth**: `setAuthTokenGetter` configures the generated API client (Orval) to attach JWT Bearer tokens from localStorage (`claimbase_session_token`); `fetch-patch.ts` provides additional auth header injection for Telegram WebApp initData. Auth middleware also supports `?token=` query param for image URLs in `<img>` tags.
- **Receipt images**: Stored in object storage. Bot uploads return full API paths (`/api/storage/objects/receipts/{userId}/...`). Frontend uses `getAuthImageUrl()` helper (`src/lib/utils.ts`) to normalize the path and append auth token query param for `<img>` tag access.

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — `pnpm run typecheck`
- **`emitDeclarationOnly`** — only `.d.ts` files during typecheck; JS bundling by esbuild
- **Project references** — when package A depends on B, A's tsconfig lists B in references

## Root Scripts

- `pnpm run build` — typecheck + recursive build
- `pnpm run typecheck` — `tsc --build --emitDeclarationOnly`

## Development Commands

- `pnpm --filter @workspace/api-server run dev` — dev server (bot + API + scheduler)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client/zod from OpenAPI
- `pnpm --filter @workspace/db run push` — push schema to DB

## Dark Mode / Theming

The web portal uses CSS custom properties (HSL values) for all colors, defined in `index.css` under `:root` (light) and `.dark` (dark) selectors. The `useDarkMode()` hook in `App.tsx` auto-detects Telegram WebApp's `colorScheme` or system `prefers-color-scheme` and toggles the `.dark` class on `<html>`.

**All pages must use theme-aware Tailwind classes** — never hardcode slate/gray/white colors:
- `text-foreground` / `text-muted-foreground` (not `text-slate-900`, `text-gray-600`)
- `bg-background` / `bg-card` / `bg-muted` (not `bg-white`, `bg-slate-50`)
- `border-border` (not `border-slate-200`)
- Semantic accent colors (blue, green, red) are OK with explicit dark variants (e.g. `text-blue-600 dark:text-blue-400`)

## Environment Variables

- `TELEGRAM_BOT_TOKEN` — Telegram bot token (secret)
- `DATABASE_URL` — PostgreSQL connection (auto-provided)
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — Replit AI proxy base URL (auto-provisioned)
- `AI_INTEGRATIONS_OPENAI_API_KEY` — Replit AI proxy API key (auto-provisioned)
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID` — Object storage bucket
- `PORT` — Server port (auto-assigned)
