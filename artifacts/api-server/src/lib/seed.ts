import { db } from "@workspace/db";
import { categoriesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const SYSTEM_CATEGORIES = [
  { name: "Travel", description: "Expenses related to business travel including flights, hotels, and accommodation", examples: "Flight tickets, hotel stays, Airbnb, travel insurance, visa fees" },
  { name: "Meals & Entertainment", description: "Food and beverage expenses for business meals, client entertainment, and team events", examples: "Business lunch, client dinner, team celebration, coffee meetings" },
  { name: "Equipment & Tools", description: "Physical equipment and tools purchased for work purposes", examples: "Laptop, monitor, keyboard, mouse, desk, chair, tools" },
  { name: "Utilities", description: "Recurring utility bills for business operations", examples: "Electricity, water, internet, office rent, co-working space fees" },
  { name: "Software Purchases & Subscriptions", description: "Software licenses, SaaS subscriptions, and digital tools", examples: "Microsoft 365, Adobe Creative Suite, Slack, Notion, domain renewals" },
  { name: "Transportation", description: "Daily commute and local transport expenses", examples: "Grab/Uber rides, parking fees, tolls, fuel, public transit, mileage claims" },
  { name: "Office Supplies & Stationery", description: "Consumable office supplies and stationery items", examples: "Paper, pens, printer ink, envelopes, folders, sticky notes" },
  { name: "Telecommunications", description: "Phone bills, mobile data plans, and communication services", examples: "Mobile phone bill, data plan, international calls, VoIP services" },
  { name: "Medical & Health", description: "Health-related expenses for medical visits, medications, and wellness", examples: "Doctor visits, prescriptions, health screenings, first aid supplies" },
  { name: "Grocery", description: "Grocery shopping and household consumables", examples: "Supermarket purchases, fresh produce, household essentials, cleaning supplies" },
  { name: "Miscellaneous / Others", description: "Catch-all category for expenses that do not fit other categories", examples: "Courier fees, printing services, registration fees, ad-hoc purchases" },
];

export async function seedDefaultCategories(): Promise<void> {
  for (const cat of SYSTEM_CATEGORIES) {
    const existing = await db.query.categoriesTable.findFirst({
      where: eq(categoriesTable.name, cat.name),
    });
    if (!existing) {
      await db.insert(categoriesTable).values({
        name: cat.name,
        description: cat.description,
        examples: cat.examples,
        isSystem: true,
        userId: null,
      });
    }
  }
  logger.info("Default system categories seeded");
}
