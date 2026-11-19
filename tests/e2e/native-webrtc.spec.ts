import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { nativeSoakMinutes, runNativeSoak } from './native-soak.js';

for (const closeCandidate of [false, true]) {
  test(`production WebRTC native RTP candidate closes=${closeCandidate}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    let exchanges = 0;
    let releaseFailure!: () => void;
    const heldFailure = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'api.openai.com' && url.pathname === '/v1/realtime/translations/calls') {
        exchanges += 1;
        if (exchanges === 2 && !closeCandidate) {
          await heldFailure;
          return route.fulfill({ status: 503, body: 'Injected candidate SDP failure' });
        }
        const answer = await page.evaluate(async (offer) => {
          return window.__rtcLoopback.answer(offer);
        }, route.request().postData()!);
        // Stop can cancel a candidate while native ICE gathering is pending.
        // That request is terminal; finish this handler without an SDP reply.
        // A bare return leaves Playwright's handler promise pending at teardown.
        if (route.request().failure()?.errorText === 'net::ERR_ABORTED') return route.fallback();
        return route.fulfill({ contentType: 'application/sdp', body: answer });
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/session/info')
        return route.fulfill({
          json: { hasApiKey: true, hasGeminiKey: false, availableProviders: ['openai'] },
        });
      if (url.pathname === '/session')
        return route.fulfill({
          json: {
            client_secret: { value: 'local-loopback-only' },
            key_slot: 'primary',
            session_renewal_recommended_ms:
              exchanges === 0 ? 3000 : nativeSoakMinutes ? 25 * 60_000 : 999999,
          },
        });
      return route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await page.addInitScript(
      ({ closeCandidate }) => {
        const NativePeer = window.RTCPeerConnection;
        const NativeWorklet = window.AudioWorkletNode;
        const captureContexts: AudioContext[] = [];
        window.AudioWorkletNode = class extends NativeWorklet {
          constructor(ctx: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
            super(ctx, name, options);
            if (options?.processorOptions?.progressOnly) captureContexts.push(ctx as AudioContext);
          }
        };
        const clients: RTCPeerConnection[] = [];
        const servers: RTCPeerConnection[] = [];
        const channels: RTCDataChannel[] = [];
        const clientChannels: RTCDataChannel[] = [];
        const channelOwners = new WeakMap<
          RTCDataChannel,
          { side: 'client' | 'server'; peer: number }
        >();
        const streams: MediaStream[] = [];
        const sources: AudioContext[] = [];
        const events: NativeRtcEvent[] = [];
        const recordEvent = (side: 'client' | 'server', peer: number, event: string) => {
          const at = performance.now();
          events.push({ side, peer, event, at, wallMs: Date.now(), monotonicMs: at });
          if (events.length > 200) events.shift();
        };
        const watchPeer = (pc: RTCPeerConnection, side: 'client' | 'server', peer: number) => {
          pc.addEventListener('connectionstatechange', () =>
            recordEvent(side, peer, 'connection:' + pc.connectionState),
          );
          pc.addEventListener('iceconnectionstatechange', () =>
            recordEvent(side, peer, 'ice:' + pc.iceConnectionState),
          );
        };
        const watchChannel = (channel: RTCDataChannel, side: 'client' | 'server', peer: number) => {
          channelOwners.set(channel, { side, peer });
          for (const event of ['open', 'closing', 'close', 'error'])
            channel.addEventListener(event, () =>
              recordEvent(side, peer, 'dc:' + event + ':' + channel.readyState),
            );
        };
        const analysers: AnalyserNode[] = [];
        // All transport/codec/state machinery stays native. Local ICE only prevents
        // production's public STUN configuration from contacting external services.
        window.RTCPeerConnection = class extends NativePeer {
          constructor(configuration?: RTCConfiguration) {
            super({ ...configuration, iceServers: [] });
            clients.push(this);
            const peer = clients.length - 1;
            watchPeer(this, 'client', peer);
          }
          override createDataChannel(label: string, options?: RTCDataChannelInit) {
            const channel = super.createDataChannel(label, options);
            clientChannels.push(channel);
            const peer = clients.indexOf(this);
            watchChannel(channel, 'client', peer);
            return channel;
          }
        };
        navigator.mediaDevices.getUserMedia = async () => {
          const ctx = new AudioContext();
          sources.push(ctx);
          const oscillator = ctx.createOscillator();
          const destination = ctx.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          await ctx.resume();
          streams.push(destination.stream);
          return destination.stream;
        };
        window.__rtcLoopback = {
          captureContexts,
          clients,
          servers,
          channels,
          streams,
          events,
          async answer(offer: string) {
            const pc = new NativePeer({ iceServers: [] });
            servers.push(pc);
            watchPeer(pc, 'server', servers.length - 1);
            pc.ontrack = ({ track }) => {
              const ctx = new AudioContext();
              sources.push(ctx);
              const source = ctx.createMediaStreamSource(new MediaStream([track]));
              const analyser = ctx.createAnalyser();
              analysers.push(analyser);
              const gain = ctx.createGain();
              gain.gain.value = 0;
              source.connect(analyser).connect(gain).connect(ctx.destination);
              void ctx.resume();
              const audio = document.createElement('audio');
              audio.srcObject = new MediaStream([track]);
              audio.muted = true;
              document.body.append(audio);
              void audio.play();
            };
            pc.ondatachannel = ({ channel }) => {
              channels.push(channel);
              watchChannel(channel, 'server', servers.indexOf(pc));
              if (closeCandidate && servers.indexOf(pc) === 1) {
                channel.close();
                return;
              }
              const acknowledgeSession = () =>
                channel.send(
                  JSON.stringify({ type: 'session.created', session: { id: 'local-loopback' } }),
                );
              if (channel.readyState === 'open') acknowledgeSession();
              else channel.addEventListener('open', acknowledgeSession, { once: true });
              channel.onmessage = ({ data }) => {
                if (JSON.parse(data).type === 'session.close')
                  channel.send(JSON.stringify({ type: 'session.closed' }));
              };
            };
            await pc.setRemoteDescription({ type: 'offer', sdp: offer });
            await pc.setLocalDescription(await pc.createAnswer());
            if (pc.iceGatheringState !== 'complete') {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('Loopback ICE gathering timed out')),
                  5000,
                );
                pc.addEventListener('icegatheringstatechange', () => {
                  if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                  }
                });
              });
            }
            return pc.localDescription!.sdp;
          },
          async stats(index: number) {
            const pc = servers[index];
            let packets = 0;
            let energy = 0;
            if (pc)
              (await pc.getStats()).forEach((report) => {
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                  packets += report.packetsReceived ?? 0;
                  energy += report.totalAudioEnergy ?? 0;
                }
              });
            const buffer = new Float32Array(2048);
            analysers[index]?.getFloatTimeDomainData(buffer);
            return {
              packets,
              energy,
              decodedRms: Math.sqrt(
                buffer.reduce((sum, sample) => sum + sample * sample, 0) / buffer.length,
              ),
              contexts: sources.map((ctx) => ctx.state),
            };
          },
          snapshot() {
            const describe = (pc: RTCPeerConnection, peer: number) => ({
              peer,
              connection: pc.connectionState,
              ice: pc.iceConnectionState,
              signaling: pc.signalingState,
              senders: pc.getSenders().map((sender) =>
                sender.track
                  ? {
                      id: sender.track.id,
                      readyState: sender.track.readyState,
                      enabled: sender.track.enabled,
                      muted: sender.track.muted,
                    }
                  : null,
              ),
              receivers: pc.getReceivers().map((receiver) => ({
                id: receiver.track.id,
                readyState: receiver.track.readyState,
                muted: receiver.track.muted,
              })),
            });
            return {
              wallMs: Date.now(),
              monotonicMs: performance.now(),
              visibility: document.visibilityState,
              online: navigator.onLine,
              clients: clients.map(describe),
              servers: servers.map(describe),
              serverChannels: channels.map((channel) => ({
                ...channelOwners.get(channel),
                state: channel.readyState,
              })),
              clientChannels: clientChannels.map((channel) => ({
                ...channelOwners.get(channel),
                state: channel.readyState,
              })),
              contexts: sources.map((ctx) => ctx.state),
              events: [...events],
            };
          },
          async cleanup() {
            clients.forEach((pc) => pc.close());
            servers.forEach((pc) => pc.close());
            streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
            await Promise.all(sources.map((ctx) => ctx.close()));
          },
        };
      },
      { closeCandidate },
    );
    await page.goto('/');
    // The production fixture shares one archive. Closing the preceding browser
    // leaves its real 15s writer lease to expire; Stop retains it for editing.
    if (closeCandidate) {
      test.setTimeout(45_000);
      await page.waitForTimeout(16_000);
    }
    await page.getByTestId('start-real').click();
    try {
      await expect
        .poll(() => page.evaluate(async () => (await window.__rtcLoopback.stats(0)).decodedRms), {
          timeout: 12000,
        })
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => window.__rtcLoopback.channels[0]?.readyState))
        .toBe('open');
      await page.evaluate(() => {
        window.__rtcLoopback.channels[0]!.send(
          JSON.stringify({
            type: 'session.output_transcript.delta',
            delta: '原生傳輸測試字幕',
          }),
        );
      });
      await expect(page.locator('body')).toContainText('原生傳輸測試字幕');
      if (closeCandidate) {
        await expect
          .poll(() => page.evaluate(() => window.__rtcLoopback.channels[1]?.readyState), {
            timeout: 7000,
          })
          .toBe('closed');
        const closedCandidateEvidence = await page.evaluate(async () => ({
          states: window.__rtcLoopback.clients.map((pc) => ({
            connection: pc.connectionState,
            senders: pc.getSenders().map((s) => s.track?.readyState ?? null),
          })),
          events: window.__rtcLoopback.events,
          initial: await window.__rtcLoopback.stats(0),
          candidate: await window.__rtcLoopback.stats(1),
        }));
        await writeFile(
          test.info().outputPath('closed-candidate-evidence.json'),
          JSON.stringify(closedCandidateEvidence, null, 2),
        );
        expect(closedCandidateEvidence.states[0]?.connection).toBe('connected');
        const before = closedCandidateEvidence.initial.packets;
        await expect
          .poll(() => page.evaluate(async () => (await window.__rtcLoopback.stats(0)).packets))
          .toBeGreaterThan(before + 5);
        await page.getByTestId('stop-fake-replay').click();
        return;
      }
      // Scheduled renewal waits on a failed candidate while the primary sends
      // real RTP. The candidate has no attached capture track before activation.
      await expect.poll(() => exchanges, { timeout: 7000 }).toBe(2);
      expect(
        await page.evaluate(() =>
          window.__rtcLoopback.clients[1]!.getSenders().every((sender) => sender.track === null),
        ),
      ).toBe(true);
      const beforeFailure = await page.evaluate(() => window.__rtcLoopback.stats(0));
      await expect
        .poll(() => page.evaluate(async () => (await window.__rtcLoopback.stats(0)).packets))
        .toBeGreaterThan(beforeFailure.packets + 5);
      releaseFailure();
      await expect
        .poll(() => page.evaluate(() => window.__rtcLoopback.clients[1]!.connectionState))
        .toBe('closed');
      expect(await page.evaluate(() => window.__rtcLoopback.clients[0]!.connectionState)).toBe(
        'connected',
      );
      const afterFailure = await page.evaluate(() => window.__rtcLoopback.stats(0));
      expect(afterFailure.decodedRms).toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(async () => (await window.__rtcLoopback.stats(1)).decodedRms), {
          timeout: 12000,
        })
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => window.__rtcLoopback.channels[1]?.readyState))
        .toBe('open');
      await page.evaluate(() =>
        window.__rtcLoopback.channels[1]!.send(JSON.stringify({ type: 'session.closed' })),
      );
      await expect
        .poll(() => page.evaluate(async () => (await window.__rtcLoopback.stats(2)).decodedRms), {
          timeout: 12000,
        })
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => window.__rtcLoopback.channels[2]?.readyState))
        .toBe('open');
      const afterSessionClosed = await page.evaluate(() => window.__rtcLoopback.stats(2));
      // Close only the active caption channel: ICE and RTP may remain connected.
      await page.evaluate(() => window.__rtcLoopback.channels[2]!.close());
      await expect
        .poll(() => page.evaluate(async () => (await window.__rtcLoopback.stats(3)).decodedRms), {
          timeout: 12000,
        })
        .toBeGreaterThan(0);
      expect(exchanges).toBe(5);
      const evidence = await page.evaluate(async () => ({
        initial: await window.__rtcLoopback.stats(0),
        renewed: await window.__rtcLoopback.stats(3),
        afterCandidateRetry: await window.__rtcLoopback.stats(1),
        events: window.__rtcLoopback.events,
        captures: window.__rtcLoopback.streams.length,
        manualRecoveryActions: 0,
        scope: 'Native loopback RTP; external ICE/NAT and cloud semantics unverified',
      }));
      await writeFile(
        test.info().outputPath('native-rtp-evidence.json'),
        JSON.stringify(
          { ...evidence, afterSessionClosed, candidateFailure: { beforeFailure, afterFailure } },
          null,
          2,
        ),
      );
      expect(evidence.captures).toBe(1);
      expect(evidence.renewed.packets).toBeGreaterThan(0);
      await test.info().attach('native-rtp-evidence', {
        contentType: 'application/json',
        body: JSON.stringify(evidence),
      });
      let finishSoak: Awaited<ReturnType<typeof runNativeSoak>> | undefined;
      if (nativeSoakMinutes) {
        const initialExchanges = exchanges;
        let sequence = 0;
        let previousIndex = -1;
        let previousPackets = -1;
        finishSoak = await runNativeSoak(page, test.info(), {
          provider: 'openai',
          marker: '長測字幕',
          async tick() {
            sequence += 1;
            await page.evaluate((sequence) => {
              const channel = window.__rtcLoopback.channels.findLast(
                (channel) => channel.readyState === 'open',
              );
              if (channel)
                channel.send(
                  JSON.stringify({
                    type: 'session.output_transcript.delta',
                    delta: `長測字幕 ${sequence}。`,
                  }),
                );
            }, sequence);
          },
          async snapshot() {
            return {
              exchanges,
              snapshot: await page.evaluate(() => window.__rtcLoopback.snapshot()),
            };
          },
          async sample(recordRaw) {
            const current = await page.evaluate(async () => {
              const harness = window.__rtcLoopback;
              const index = harness.channels.findLastIndex(
                (channel) => channel.readyState === 'open',
              );
              return {
                index,
                ...(await harness.stats(index)),
                captures: harness.streams.length,
                snapshot: harness.snapshot(),
              };
            });
            await recordRaw({ exchanges, ...current });
            expect(current.index).toBeGreaterThanOrEqual(0);
            expect(current.captures).toBe(1);
            expect(current.decodedRms).toBeGreaterThan(0);
            expect(current.packets).toBeGreaterThan(
              current.index === previousIndex ? previousPackets : 0,
            );
            previousIndex = current.index;
            previousPackets = current.packets;
            return {
              receiverIndex: current.index,
              packets: current.packets,
              decodedRms: current.decodedRms,
              energy: current.energy,
              captures: current.captures,
              exchanges,
              renewals: exchanges - initialExchanges,
            };
          },
        });
        expect(exchanges - initialExchanges).toBe(Math.floor(nativeSoakMinutes / 25));
      }
      if (!nativeSoakMinutes) {
        const beforeSuspend = exchanges;
        await page.evaluate(async () => {
          if (!window.__rtcLoopback.captureContexts.length) throw new Error('No capture probe');
          await Promise.all(
            [...new Set(window.__rtcLoopback.captureContexts)].map((ctx) => ctx.suspend()),
          );
        });
        await expect(page.getByTestId('mic-level-bar')).toHaveAttribute(
          'data-reason',
          'context_suspended',
        );
        await page.evaluate(async () => {
          await Promise.all(
            [...new Set(window.__rtcLoopback.captureContexts)].map((ctx) => ctx.resume()),
          );
        });
        await expect(page.getByTestId('mic-level-bar')).toHaveAttribute(
          'data-reason',
          'capture_resumed',
        );
        expect(exchanges).toBe(beforeSuspend);
      }
      await page.getByTestId('stop-fake-replay').click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__rtcLoopback.clients.every((pc) => pc.connectionState === 'closed'),
          ),
        )
        .toBe(true);
      expect(
        await page.evaluate(() =>
          window.__rtcLoopback.streams
            .flatMap((s) => s.getTracks())
            .every((t) => t.readyState === 'ended'),
        ),
      ).toBe(true);
      await finishSoak?.({ liveTracks: 0, openClientPeers: 0, exchanges });
    } finally {
      // Block fresh requests while draining already-started SDP callbacks.
      // Closing native peers first can strand their ICE waiter past test end.
      await page.route('**/*', (route) => route.abort());
      releaseFailure();
      await context.unrouteAll({ behavior: 'wait' });
      await page.evaluate(() => window.__rtcLoopback.cleanup());
    }
  });
}

interface NativeRtcEvent {
  side: 'client' | 'server';
  peer: number;
  event: string;
  at: number;
  wallMs: number;
  monotonicMs: number;
}

declare global {
  interface Window {
    __rtcLoopback: {
      captureContexts: AudioContext[];
      events: NativeRtcEvent[];
      clients: RTCPeerConnection[];
      servers: RTCPeerConnection[];
      channels: RTCDataChannel[];
      streams: MediaStream[];
      answer(offer: string): Promise<string>;
      stats(index: number): Promise<{
        packets: number;
        energy: number;
        decodedRms: number;
        contexts: AudioContextState[];
      }>;
      snapshot(): unknown;
      cleanup(): Promise<void>;
    };
  }
}
