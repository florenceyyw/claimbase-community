import { zodResolver as originalZodResolver } from "@hookform/resolvers/zod";
import type { ZodSchema } from "zod";

export const zodResolver = (schema: ZodSchema) =>
  originalZodResolver(schema as unknown as Parameters<typeof originalZodResolver>[0]);
