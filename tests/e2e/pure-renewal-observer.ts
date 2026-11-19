/** Test-only browser measurements; no provider mocks or per-frame logging. */
export function installRenewalResourceObserver() {
  const measurements = {
    workers: [] as Array<{ createdAt: number; terminatedAt: number | null }>,
    worklets: [] as Array<{
      createdAt: number;
      disconnectedAt: number | null;
      frames: number;
      bytes: number;
    }>,
    longTasks: [] as Array<{ at: number; duration: number }>,
    frameIntervals: [] as Array<{ at: number; duration: number }>,
    overflow: false,
  };
  Object.defineProperty(window, '__pureRenewalResources', { value: measurements });
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker;
      if (!String(args[0]).includes('transcription-vad.worker')) return worker;
      const record = { createdAt: Date.now(), terminatedAt: null as number | null };
      measurements.workers.push(record);
      const terminate = worker.terminate.bind(worker);
      Object.defineProperty(worker, 'terminate', {
        value: () => {
          terminate();
          record.terminatedAt ??= Date.now();
        },
      });
      return worker;
    },
  });
  const NativeWorklet = window.AudioWorkletNode;
  window.AudioWorkletNode = new Proxy(NativeWorklet, {
    construct(target, args) {
      const node = Reflect.construct(target, args) as AudioWorkletNode;
      if (args[1] !== 'pcm-worklet') return node;
      const record = {
        createdAt: Date.now(),
        disconnectedAt: null as number | null,
        frames: 0,
        bytes: 0,
      };
      measurements.worklets.push(record);
      node.port.addEventListener('message', (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          record.frames++;
          record.bytes += event.data.byteLength;
        }
      });
      const disconnect = node.disconnect;
      Object.defineProperty(node, 'disconnect', {
        value: (...args: unknown[]) => {
          const result = Reflect.apply(disconnect, node, args);
          record.disconnectedAt ??= Date.now();
          return result;
        },
      });
      return node;
    },
  });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (measurements.longTasks.length >= 256) measurements.overflow = true;
      else
        measurements.longTasks.push({
          at: performance.timeOrigin + entry.startTime,
          duration: entry.duration,
        });
    }
  }).observe({ type: 'longtask', buffered: true });
  let previous = performance.now();
  const frame = (now: number) => {
    // This machine delivers ~160 frames/s; cover the full 150s test timeout.
    if (measurements.frameIntervals.length >= 32768) {
      measurements.overflow = true;
      return;
    }
    measurements.frameIntervals.push({
      at: performance.timeOrigin + now,
      duration: now - previous,
    });
    previous = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export interface RenewalResources {
  workers: Array<{ createdAt: number; terminatedAt: number | null }>;
  worklets: Array<{
    createdAt: number;
    disconnectedAt: number | null;
    frames: number;
    bytes: number;
  }>;
  longTasks: Array<{ at: number; duration: number }>;
  frameIntervals: Array<{ at: number; duration: number }>;
  overflow: boolean;
}
