// ai.ts — Community Edition
// AI receipt parsing is available in Claimbase Pro.
// This stub provides the interface for manual receipt entry.
// To implement your own: use any vision AI API to extract
// amount, currency, date, and description from receipt images.

import { logger } from "./logger";

export interface ParsedReceipt {
  amount: string | null;
  currency: string | null;
  date: string | null;
  description: string | null;
  category: string | null;
  receiptType: "standard" | "transfer";
  confidence: number;
}

export async function parseReceiptImage(
  _imageUrl: string,
  _existingCategories: string[] = []
): Promise<ParsedReceipt[]> {
  logger.info("AI parsing is available in Claimbase Pro");
  return [{
    amount: null,
    currency: null,
    date: null,
    description: null,
    category: null,
    receiptType: "standard",
    confidence: 0,
  }];
}

export async function parseReceiptPdfText(
  _text: string,
  _existingCategories: string[] = []
): Promise<ParsedReceipt[]> {
  logger.info("AI parsing is available in Claimbase Pro");
  return [{
    amount: null,
    currency: null,
    date: null,
    description: null,
    category: null,
    receiptType: "standard",
    confidence: 0,
  }];
}
