import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

const TRANSLATION_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/translations/client_secrets';

// Maps our langPair key to OpenAI output language code
const LANG_OUTPUT: Record<string, string> = {
  'en→zh-TW': 'zh',
  'zh-TW→en': 'en',
};

const DEFAULT_LANG_PAIR = 'en→zh-TW';

interface SessionBody {
  langPair?: string;
}

// /v1/realtime/translations/client_secrets returns a flat object (not nested under client_secret)
interface ClientSecretResponse {
  value: string;
  expires_at: number;
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  app.get('/session/info', async () => ({
    hasApiKey: Boolean(config.OPENAI_API_KEY),
  }));

  app.post<{ Body: SessionBody }>('/session', async (req, reply) => {
    if (!config.OPENAI_API_KEY) {
      return reply.status(503).send({ error: 'OPENAI_API_KEY not configured on server' });
    }

    const langPair =
      req.body?.langPair && req.body.langPair in LANG_OUTPUT
        ? req.body.langPair
        : DEFAULT_LANG_PAIR;

    const outputLanguage = LANG_OUTPUT[langPair] ?? 'zh';

    const res = await fetch(TRANSLATION_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          model: 'gpt-realtime-translate',
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
              noise_reduction: { type: 'near_field' },
            },
            output: { language: outputLanguage },
          },
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return reply.status(res.status).send({ error: err });
    }

    const data = (await res.json()) as ClientSecretResponse;
    // NEVER expose OPENAI_API_KEY — return only the ephemeral client_secret
    return { client_secret: { value: data.value, expires_at: data.expires_at } };
  });
}
