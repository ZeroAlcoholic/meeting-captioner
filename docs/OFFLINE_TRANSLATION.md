# OFFLINE_TRANSLATION.md

> Local English → Traditional Chinese translation strategy.
> See [`REFERENCE.md`](../REFERENCE.md) §6.

---

## Backend Selection

**Current implementation, not usability acceptance (2026-10-22):**
OPUS-MT en↔zh models run through CTranslate2 CPU int8, followed by OpenCC
`s2twp` and the TSV glossary. Argos is not the implemented MT engine.
Real-model diagnostics found missing source EOS; adding it improved specific
omissions/repetition, but residual quality failures, worker timeout recovery,
and audio-to-caption latency remain unaccepted. See [measurements and limits](evals/2026-10-22-offline-calibration.md).

**Earlier candidate:** [Argos Translate](https://github.com/argosopentech/argos-translate).
**Current model family:** [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT).
**Restricted:** NLLB-200 — internal PoC only, license review required, not default.

**Research only:** Granite Speech 5.0 2B consumes audio rather than source
text. Official English-to-Mandarin support has no 5.0 en→zh score in its
published FLEURS chart; local quality, Traditional Chinese terminology,
segmentation latency and integration are not verified. It is not a configured
provider or an available fallback.

---

## Hard Rules (from CLAUDE.md)

- Do **not** translate every partial transcript delta. Translate only
  finalized or semi-final segments.
- The UI must **not** claim online-equivalent quality.
- On translation failure, **keep the source transcript visible**.
- Provide a glossary hook for domain terms (e.g., proper nouns).
- Apply Traditional Chinese / Taiwan post-processing (e.g., terminology
  normalization where simplified-Chinese-trained models leak through).

---

## Provider Adapter Surface

`OfflineMTProvider` emits the normalized `TranslationEvent` contract
(see [`ARCHITECTURE.md`](ARCHITECTURE.md) §4).

Required methods (sketch):

- `translate(sourceSegment) → TranslationEvent`
- `health(): HealthEvent`
- `setGlossary(terms)`

---

## Quality Honesty

Offline MT will not match GPT-class output for English → zh-Hant on
spontaneous meeting speech. The UI must:

- show the source transcript alongside the translation, not below it
- show a small "offline" indicator near the translated caption
- not auto-switch to a "better" online provider without user consent

---

## Open Questions

- Can the selected model meet representative meeting quality after the EOS fix?
- How should a hung native MT call be terminated and recovered without blocking
  captions? The current single thread shares the FastAPI process; caller timeout
  does not reclaim it.
- How should failed or dropped translations be made visible per segment?
- The current glossary is TSV. Does a replacement preserve terms without hiding
  errors in numbers, negation, conditions or repeated speech?
