import { useCaptionStore } from '../store/use-caption-store.js';

function LiveTrack({ track }: { track?: 'mic' | 'remote' }) {
  const partial = useCaptionStore((s) =>
    s.captionTask?.purpose !== 'transcription'
      ? null
      : track
        ? s.liveTracks[track]?.partial
        : s.livePartial,
  );
  const last = useCaptionStore((s) => {
    if (s.captionTask?.purpose !== 'transcription') return undefined;
    if (!track) return s.segments.at(-1);
    for (let i = s.segments.length - 1; i >= 0; i--) {
      const segment = s.segments[i]!;
      if (
        (segment.source === 'microphone' || segment.source === 'fake_replay') ===
        (track === 'mic')
      )
        return segment;
    }
    return undefined;
  });
  return (
    <PureCaptionText
      text={partial?.text ?? last?.text ?? ''}
      status={partial ? 'partial' : 'final'}
      label={track ? (track === 'mic' ? '麥克風' : '遠端') : undefined}
    />
  );
}

export function PureLiveCaptions() {
  const separateTracks = useCaptionStore((s) => s.separateTracks);
  return separateTracks ? (
    <div className="pure-track-pair">
      <LiveTrack track="mic" />
      <LiveTrack track="remote" />
    </div>
  ) : (
    <LiveTrack />
  );
}

export function PureCaptionText({
  text,
  status,
  label,
}: {
  text: string;
  status: 'partial' | 'final';
  label?: string | undefined;
}) {
  return (
    <section className="pure-live" aria-label={label ?? '即時原文字幕'}>
      {label && <h2>{label}</h2>}
      <div className="pure-live-status">{status === 'partial' ? '辨識中' : '已確認片段'}</div>
      <p data-testid="pure-live-text" aria-live="polite">
        {text || '開始收音後，字幕會出現在這裡。'}
      </p>
    </section>
  );
}
