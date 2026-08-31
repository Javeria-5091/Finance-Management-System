import { z } from 'zod';

export const AIResponseContractSchema = z.object({
  answer: z.string(),
  metric_or_report: z.string().nullable(),
  period: z.object({ from: z.string(), to: z.string() }).nullable(),
  currency: z.string(),
  filters: z.array(z.object({ field: z.string(), value: z.string() })),
  data_as_of: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  warnings: z.array(z.string()),
  source_rows_or_report: z.string().nullable(),
  suggested_safe_actions: z.array(z.string()),
});

export type AiResponseContract = z.infer<typeof AIResponseContractSchema>;

export function buildAiResponse<T extends Record<string, unknown>>(
  payload: T,
  contract: AiResponseContract,
): T & AiResponseContract {
  const validated = AIResponseContractSchema.parse(contract);
  return { ...payload, ...validated } as T & AiResponseContract;
}
