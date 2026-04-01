// claimGenerator.ts — Community Edition
// PDF and Excel claim generation is available in Claimbase Pro.
// This community edition supports CSV export.

export interface ClaimReceipt {
  id: number;
  description: string;
  receiptDate: string;
  currency: string;
  amount: string;
  categoryName: string | null;
}

export async function generateClaimCsv(
  receipts: ClaimReceipt[],
  companyName: string,
  periodLabel: string,
  baseCurrency: string
): Promise<Buffer> {
  const headers = ["Date", "Description", "Category", "Currency", "Amount"];
  const rows = receipts.map(r => [
    r.receiptDate,
    `"${(r.description || "").replace(/"/g, '""')}"`,
    r.categoryName || "Uncategorised",
    r.currency,
    r.amount,
  ]);

  const csv = [
    `Expense Claim: ${companyName} — ${periodLabel}`,
    "",
    headers.join(","),
    ...rows.map(r => r.join(",")),
    "",
    `Total (${baseCurrency}),,,,"=SUM(E4:E${rows.length + 3})"`,
  ].join("\n");

  return Buffer.from(csv, "utf-8");
}

// PDF and Excel generation stubs
export async function generateClaimPdf(): Promise<Buffer> {
  throw new Error("PDF generation is available in Claimbase Pro");
}

export async function generateClaimExcel(): Promise<Buffer> {
  throw new Error("Excel generation is available in Claimbase Pro");
}
