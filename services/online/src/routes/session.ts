import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { config } from '../config.js';

const REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';

const LANG_PAIR_CONFIG = {
  'en→zh-TW': {
    instructions:
      'You are a simultaneous English-to-Traditional-Chinese interpreter. ' +
      'When the user speaks in English, respond ONLY with the Traditional Chinese (zh-TW) translation. ' +
      'Output the translation alone — no explanations, no English echo.',
    whisperLang: 'en',
  },
  'zh-TW→en': {
    instructions:
      'You are a simultaneous Mandarin-Chinese-to-English interpreter. ' +
      'When the user speaks in Mandarin (Traditional or Simplified Chinese), respond ONLY with the English translation. ' +
      'Output the translation alone — no explanations, no Chinese echo.',
    whisperLang: 'zh',
  },
} as const;

type LangPair = keyof typeof LANG_PAIR_CONFIG;
const DEFAULT_LANG_PAIR: LangPair = 'en→zh-TW';

interface SessionBody {
  langPair?: string;
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  app.get('/session/info', async () => ({
    hasApiKey: Boolean(config.OPENAI_API_KEY),
  }));

  app.post<{ Body: SessionBody }>('/session', async (req, reply) => {
    if (!config.OPENAI_API_KEY) {
      return reply.status(503).send({ error: 'OPENAI_API_KEY not configured on server' });
    }

    const langPair: LangPair =
      req.body?.langPair && req.body.langPair in LANG_PAIR_CONFIG
        ? (req.body.langPair as LangPair)
        : DEFAULT_LANG_PAIR;

    const { instructions, whisperLang } = LANG_PAIR_CONFIG[langPair];

    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

    const session = await client.beta.realtime.sessions.create({
      model: REALTIME_MODEL,
      modalities: ['audio', 'text'],
      instructions,
      voice: 'alloy',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
      input_audio_transcription: { model: 'whisper-1', language: whisperLang },
    });

    // Return ONLY the client_secret — NEVER expose OPENAI_API_KEY to the browser
    return { client_secret: session.client_secret };
  });
}
