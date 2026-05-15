import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  ONLINE_PORT: z.coerce.number().int().positive().default(8787),
  ONLINE_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  OPENAI_API_KEY: z.string().optional(),
  // Hard cap on the upstream OpenAI client_secrets fetch. Above this we 504 the caller
  // rather than letting the browser hang on a stalled WebRTC bring-up.
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Token-bucket cap on POST /session per remote IP. Single-process only;
  // a multi-instance deployment must front this with a shared store.
  SESSION_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),
  // OpenAI Realtime translation sessions cap around 30 min. We tell the client
  // to renew earlier so users never hit the silent freeze.
  SESSION_RENEW_MS: z.coerce.number().int().positive().default(25 * 60 * 1000),
});

export const config = ConfigSchema.parse(process.env);
export type Config = z.infer<typeof ConfigSchema>;
