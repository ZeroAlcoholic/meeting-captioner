import { Silero } from '@ricky0123/vad-web/dist/models/silero';
import { ort } from '@ricky0123/vad-web/dist/real-time-vad';

let model: Awaited<ReturnType<typeof Silero.new>> | undefined;
self.onmessage = async (
  event: MessageEvent<{ type: 'initialize' | 'process'; frame?: Float32Array }>,
) => {
  try {
    if (event.data.type === 'initialize') {
      if (model) throw new Error('VAD already initialized');
      ort.env.wasm.wasmPaths = new URL('/vad/', self.location.href).href;
      ort.env.wasm.numThreads = 1;
      // Model state stays here; proxy mode would detach Silero's reusable tensors.
      ort.env.wasm.proxy = false;
      model = await Silero.new(ort, async () => {
        const response = await fetch('/vad/silero_vad_v5.onnx');
        if (!response.ok) throw new Error('Silero VAD model unavailable');
        return response.arrayBuffer();
      });
      self.postMessage({ type: 'ready' });
    } else {
      if (!model || !(event.data.frame instanceof Float32Array) || event.data.frame.length !== 512)
        throw new Error('Invalid VAD frame or uninitialized model');
      const { isSpeech } = await model.process(event.data.frame);
      self.postMessage({ type: 'result', isSpeech });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'VAD worker failed',
    });
  }
};
