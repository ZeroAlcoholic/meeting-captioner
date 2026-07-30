import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OPENAI_URL = 'https://api.openai.com/v1/realtime/translations/client_secrets';
const GEMINI_AUTH_URL = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';
const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const OPENAI_MODEL = 'gpt-realtime-translate';
const GEMINI_MODEL = 'models/gemini-3.5-live-translate-preview';
const REQUEST_TIMEOUT_MS = 15_000;
const OPENAI_FIXTURE = 'openai-realtime-translate.json';
const GEMINI_FIXTURE = 'gemini-live-translate.json';

type JsonRecord = Record<string, unknown>;

export interface GeminiGoldenContract {
  provider: 'gemini';
  model: typeof GEMINI_MODEL;
  clientFrame: {
    setup: {
      model: typeof GEMINI_MODEL;
      contextWindowCompression: { slidingWindow: JsonRecord };
      sessionResumption: JsonRecord;
      inputAudioTranscription: JsonRecord;
      outputAudioTranscription: JsonRecord;
      generationConfig: {
        responseModalities: ['AUDIO'];
        translationConfig: {
          targetLanguageCode: 'zh-Hant';
          echoTargetLanguage: false;
        };
      };
    };
  };
  serverFrame: { setupComplete: JsonRecord };
}

export interface OpenAIGoldenContract {
  provider: 'openai';
  model: typeof OPENAI_MODEL;
  response: JsonRecord;
}

const GEMINI_CLIENT_FRAME: GeminiGoldenContract['clientFrame'] = {
  setup: {
    model: GEMINI_MODEL,
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: {},
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: {
        targetLanguageCode: 'zh-Hant',
        echoTargetLanguage: false,
      },
    },
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactOpenAIValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => redactOpenAIValue(item));
  if (!isRecord(value)) {
    if (key === 'value' && typeof value === 'string') return '<ephemeral-token>';
    if ((key === 'id' || key.endsWith('_id')) && typeof value === 'string') {
      return key === 'id' ? '<session-id>' : `<${key.replaceAll('_', '-')}>`;
    }
    if (
      (key === 'expires_at' || key === 'created_at' || key === 'updated_at') &&
      typeof value === 'number'
    ) {
      return '<unix-seconds>';
    }
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactOpenAIValue(child, childKey),
    ]),
  );
}

export function redactOpenAIResponse(value: unknown): JsonRecord {
  const redacted = redactOpenAIValue(value);
  if (!isRecord(redacted)) throw new Error('invalid OpenAI client-secret response');
  return redacted;
}

export function assertRedacted(value: unknown, forbidden: string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of forbidden.filter((item) => item.length > 0)) {
    if (serialized.includes(secret)) throw new Error('redaction failure');
  }
}

export function validateGeminiGolden(value: unknown): GeminiGoldenContract {
  if (!isRecord(value)) throw new Error('invalid Gemini golden contract');
  const clientFrame = value.clientFrame;
  const serverFrame = value.serverFrame;
  if (
    value.provider !== 'gemini' ||
    value.model !== GEMINI_MODEL ||
    !isRecord(clientFrame) ||
    !isRecord(clientFrame.setup) ||
    clientFrame.setup.model !== GEMINI_MODEL ||
    !isRecord(clientFrame.setup.inputAudioTranscription) ||
    !isRecord(clientFrame.setup.outputAudioTranscription) ||
    !isRecord(clientFrame.setup.generationConfig) ||
    !Array.isArray(clientFrame.setup.generationConfig.responseModalities) ||
    clientFrame.setup.generationConfig.responseModalities.length !== 1 ||
    clientFrame.setup.generationConfig.responseModalities[0] !== 'AUDIO' ||
    !isRecord(clientFrame.setup.generationConfig.translationConfig) ||
    clientFrame.setup.generationConfig.translationConfig.targetLanguageCode !== 'zh-Hant' ||
    clientFrame.setup.generationConfig.translationConfig.echoTargetLanguage !== false ||
    !isRecord(serverFrame) ||
    !isRecord(serverFrame.setupComplete)
  ) {
    throw new Error('invalid Gemini golden contract');
  }
  return value as unknown as GeminiGoldenContract;
}

export function validateOpenAIGolden(value: unknown): OpenAIGoldenContract {
  if (
    !isRecord(value) ||
    value.provider !== 'openai' ||
    value.model !== OPENAI_MODEL ||
    !isRecord(value.response) ||
    value.response.value !== '<ephemeral-token>'
  ) {
    throw new Error('invalid OpenAI golden contract');
  }
  return value as unknown as OpenAIGoldenContract;
}

async function readJsonFixture(filePath: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`missing upstream contract fixture: ${path.basename(filePath)}`);
    }
    throw error;
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`invalid JSON fixture: ${path.basename(filePath)}`);
  }
}

export async function verifyFixtureDirectory(fixtureDir: string): Promise<{
  openAI: OpenAIGoldenContract;
  gemini: GeminiGoldenContract;
}> {
  const [openAIValue, geminiValue] = await Promise.all([
    readJsonFixture(path.join(fixtureDir, OPENAI_FIXTURE)),
    readJsonFixture(path.join(fixtureDir, GEMINI_FIXTURE)),
  ]);
  return {
    openAI: validateOpenAIGolden(openAIValue),
    gemini: validateGeminiGolden(geminiValue),
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return { status: response.status, body: null };
  return { status: response.status, body: await response.json() };
}

async function probeOpenAIKey(apiKey: string): Promise<{ status: number; body: unknown }> {
  return fetchJson(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        model: OPENAI_MODEL,
        audio: {
          input: {
            noise_reduction: { type: 'far_field' },
            transcription: { model: 'gpt-realtime-whisper' },
          },
          output: { language: 'zh' },
        },
      },
    }),
  });
}

async function probeOpenAI(primaryKey: string, audioKey: string | undefined) {
  let result = await probeOpenAIKey(primaryKey);
  if ((result.status === 401 || result.status === 403) && audioKey && audioKey !== primaryKey) {
    result = await probeOpenAIKey(audioKey);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`OpenAI upstream contract probe failed (${result.status})`);
  }
  const response = redactOpenAIResponse(result.body);
  const golden = validateOpenAIGolden({
    provider: 'openai',
    model: OPENAI_MODEL,
    response,
  });
  assertRedacted(golden, [primaryKey, audioKey ?? '']);
  return golden;
}

async function decodeSocketData(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  throw new Error('Gemini returned an unsupported WebSocket frame');
}

async function waitForGeminiSetupComplete(token: string): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(`${GEMINI_WS_URL}?access_token=${encodeURIComponent(token)}`);
    const timer = setTimeout(
      () => fail(new Error('Gemini setupComplete timed out')),
      REQUEST_TIMEOUT_MS,
    );

    const succeed = (frame: JsonRecord) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1000, 'contract probe complete');
      resolve(frame);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may not have opened yet.
      }
      reject(error);
    };

    socket.onopen = () => socket.send(JSON.stringify(GEMINI_CLIENT_FRAME));
    socket.onerror = () => fail(new Error('Gemini WebSocket contract probe failed'));
    socket.onclose = (event) => {
      if (!settled) fail(new Error(`Gemini closed before setupComplete (${event.code})`));
    };
    socket.onmessage = (event) => {
      void decodeSocketData(event.data)
        .then((text) => {
          const frame: unknown = JSON.parse(text);
          if (isRecord(frame) && isRecord(frame.setupComplete)) succeed(frame);
        })
        .catch((error: unknown) =>
          fail(error instanceof Error ? error : new Error('Gemini frame decode failed')),
        );
    };
  });
}

async function probeGemini(apiKey: string): Promise<GeminiGoldenContract> {
  const now = Date.now();
  const tokenResult = await fetchJson(`${GEMINI_AUTH_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
    }),
  });
  if (tokenResult.status < 200 || tokenResult.status >= 300 || !isRecord(tokenResult.body)) {
    throw new Error(`Gemini auth-token probe failed (${tokenResult.status})`);
  }
  const token = tokenResult.body.name;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Gemini auth-token response missing name');
  }

  const serverFrame = await waitForGeminiSetupComplete(token);
  const golden = validateGeminiGolden({
    provider: 'gemini',
    model: GEMINI_MODEL,
    clientFrame: GEMINI_CLIENT_FRAME,
    serverFrame,
  });
  assertRedacted(golden, [apiKey, token]);
  return golden;
}

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function storedFixtureDirectory(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDir, '../../..');
  return path.join(repositoryRoot, 'tests/fixtures/upstream-contracts');
}

export async function verifyStoredFixtures(): Promise<void> {
  await verifyFixtureDirectory(storedFixtureDirectory());
  process.stdout.write('Verified stored OpenAI and Gemini upstream contracts.\n');
}

export async function runProbe(): Promise<void> {
  const openAIKey = process.env.OPENAI_API_KEY;
  const openAIAudioKey = process.env.OPENAI_API_KEY_AUDIO;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!openAIKey) throw new Error('OPENAI_API_KEY is required');
  if (!geminiKey) throw new Error('GEMINI_API_KEY is required');

  const [openAIGolden, geminiGolden] = await Promise.all([
    probeOpenAI(openAIKey, openAIAudioKey),
    probeGemini(geminiKey),
  ]);

  const fixtureDir = storedFixtureDirectory();
  await writeAtomic(path.join(fixtureDir, OPENAI_FIXTURE), openAIGolden);
  await writeAtomic(path.join(fixtureDir, GEMINI_FIXTURE), geminiGolden);
  await verifyFixtureDirectory(fixtureDir);
  process.stdout.write('Recorded redacted OpenAI and Gemini upstream contracts.\n');
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  const operation = process.argv.includes('--verify-only') ? verifyStoredFixtures : runProbe;
  operation().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown upstream probe failure';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
