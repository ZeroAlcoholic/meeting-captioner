import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  ONLINE_PORT: z.coerce.number().int().positive().default(8787),
  ONLINE_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  OPENAI_API_KEY: z.string().optional(),
});

export const config = ConfigSchema.parse(process.env);
export type Config = z.infer<typeof ConfigSchema>;
