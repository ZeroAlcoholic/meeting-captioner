import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Controlled upstream with native capture/VAD. Tests archive recovery, not recognition. */
export async function installRecoveryTranscription(
  page: Page,
  provider: 'openai' | 'gemini',
  bothProviders = false,
) {
  let connections = 0;
  let mintCalls = 0;
  const channels: Array<{
    send(message: unknown): void;
    submitted: number;
    sequence: number;
    backend: 'openai' | 'gemini';
  }> = [];
  const sourceChannels = new Map<'mic' | 'remote', (typeof channels)[number]>();
  await page.addInitScript((provider) => {
    localStorage.setItem(
      'meeting-audio:settings:v1',
      JSON.stringify({
        v: 1,
        modeId: 'online_full',
        onlineProvider: provider,
        audioSource: 'mic',
        micDistance: 'off',
        captionTask: {
          purpose: 'transcription',
          inputLanguages: ['en'],
          textPolicy: 'zh-TW-preserve-original',
        },
      }),
    );
    let acquisitions = 0;
    Object.defineProperty(window, '__recoveryCaptures', { get: () => acquisitions });
    navigator.mediaDevices.getUserMedia = async () => {
      acquisitions++;
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const audio = await fetch('/recovery-speech.wav').then((response) => response.arrayBuffer());
      const buffer = await context.decodeAudioData(audio);
      const firstSpeech =
        buffer.getChannelData(0).findIndex((sample) => Math.abs(sample) > 0.01) / buffer.sampleRate;
      Object.defineProperty(window, '__recoverySpeak', {
        value: () => {
          const speech = context.createBufferSource();
          speech.buffer = buffer;
          speech.connect(destination);
          speech.start(0, Math.max(0, firstSpeech), 2);
        },
      });
      const source = context.createConstantSource();
      source.offset.value = 0;
      source.connect(destination);
      source.start();
      await context.resume();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          source.stop();
          void context.close();
        };
      }
      return destination.stream;
    };
  }, provider);
  await page.route('**/recovery-speech.wav', async (route) =>
    route.fulfill({
      body: await readFile('.cache/live-caption-speech.wav'),
      contentType: 'audio/wav',
    }),
  );
  await page.route('**/session/info', (route) =>
    route.fulfill({
      json: {
        taskCapabilities: (bothProviders ? ['openai', 'gemini'] : [provider]).map((provider) => ({
          provider,
          purpose: 'transcription',
          configured: true,
          verified: false,
        })),
      },
    }),
  );
  await page.route('**/session/**/transcription', (route) => {
    mintCalls++;
    return route.fulfill({
      json: {
        token: 'test-only',
        expiresAt: Date.now() + 120000,
        model: 'models/gemini-3.5-transcribe-live',
        session_renewal_recommended_ms: 480000,
      },
    });
  });
  await page.route('**/session/transcription', (route) => {
    mintCalls++;
    return route.fulfill({
      json: {
        client_secret: { value: 'test-only', expires_at: Math.floor(Date.now() / 1000) + 600 },
        model: 'gpt-live-transcribe',
        session_renewal_recommended_ms: 1500000,
      },
    });
  });
  await page.routeWebSocket('**/*', (socket) => {
    connections++;
    const transmit = (message: unknown) => socket.send(JSON.stringify(message));
    const backend = socket.url().includes('api.openai.com')
      ? ('openai' as const)
      : ('gemini' as const);
    const channel = { send: transmit, submitted: 0, sequence: 0, backend };
    channels.push(channel);
    if (backend === 'openai')
      transmit({
        type: 'session.created',
        session: {
          type: 'transcription',
          audio: {
            input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: null },
          },
        },
      });
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.setup) transmit({ setupComplete: {} });
      if (message.type === 'input_audio_buffer.commit' || message.realtimeInput?.activityEnd)
        channel.submitted++;
    });
  });
  return {
    connectionCount: () => connections,
    mintCount: () => mintCalls,
    refuse(source: 'mic' | 'remote') {
      const channel = sourceChannels.get(source);
      if (!channel) throw new Error('Emit real speech on the source before injecting its failure');
      channel.send(
        channel.backend === 'openai'
          ? {
              type: 'error',
              error: { code: 'invalid_api_key', message: 'Controlled source refusal' },
            }
          : {
              error: {
                code: 403,
                status: 'PERMISSION_DENIED',
                message: 'Controlled source refusal',
              },
            },
      );
    },
    captures: () =>
      page.evaluate(() => (window as Window & { __recoveryCaptures: number }).__recoveryCaptures),
    async start() {
      await page.getByRole('combobox', { name: '雲端轉寫' }).selectOption(provider);
      await page.getByRole('button', { name: '開始純字幕', exact: true }).click();
      await expect(page.getByTestId('pure-session-status')).toContainText('正在顯示純字幕', {
        timeout: 30000,
      });
    },
    async emit(text: string, source: 'mic' | 'remote' = 'mic') {
      const before = channels.map((channel) => channel.submitted);
      await page.evaluate((source) => {
        const audio = window as Window & { __recoverySpeak(): void; __dualRemoteSpeak(): void };
        if (source === 'mic') audio.__recoverySpeak();
        else audio.__dualRemoteSpeak();
      }, source);
      // Identify the socket by actual submitted speech, independent of capture/mint completion order.
      await expect
        .poll(() => channels.filter((channel, i) => channel.submitted > (before[i] ?? 0)).length, {
          timeout: 15000,
        })
        .toBe(1);
      const channel = channels.find((channel, i) => channel.submitted > (before[i] ?? 0))!;
      sourceChannels.set(source, channel);
      const id = `recovery-${++channel.sequence}`;
      if (channel.backend === 'gemini')
        channel.send({
          serverContent: {
            inputTranscription: { text },
            generationComplete: true,
            turnComplete: true,
          },
        });
      else {
        channel.send({
          type: 'input_audio_buffer.committed',
          item_id: id,
          previous_item_id: channel.sequence > 1 ? `recovery-${channel.sequence - 1}` : null,
        });
        channel.send({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: id,
          content_index: 0,
          transcript: text,
        });
      }
      await expect(page.getByTestId('pure-history-line').filter({ hasText: text })).toHaveCount(1);
    },
  };
}
