# eval_audio — ASR Comparison Test Set

Place `.wav` files here to evaluate models. Update `transcripts.json` with correct transcriptions.

## Recording guidelines

- 16 kHz, mono, 16-bit PCM WAV (faster-whisper native format)
- 5–15 seconds per clip
- Cover: pure zh-TW speech, Mandarin-English code-switching
- No background music; meeting-style room noise is fine

## Running the comparison

```bash
cd services/offline
python scripts/compare_models.py --models distil-large-v3 breeze-asr-25
```

Results written to `eval_results.json`.

## Quick recording on Windows (PowerShell)

```powershell
# Record 10 seconds from default mic
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
# Or use ffmpeg:
ffmpeg -f dshow -i audio="Microphone" -t 10 -ar 16000 -ac 1 eval_audio/zh_tw_01.wav
```
