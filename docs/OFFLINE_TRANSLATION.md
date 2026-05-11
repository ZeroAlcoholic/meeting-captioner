# OFFLINE_TRANSLATION.md

> Local English → Traditional Chinese translation strategy.
> See [`REFERENCE.md`](../REFERENCE.md) §6.

---

## Backend Selection

**Primary candidate:** [Argos Translate](https://github.com/argosopentech/argos-translate)
**Secondary candidate:** [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT) (benchmark + license review)
**Restricted:** NLLB-200 — internal PoC only, license review required, not default.

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

- Argos Traditional Chinese model availability and quality vs Simplified.
- Do we run translation in the same Python process as STT, or as a
  separate worker (memory pressure)?
- Glossary file format — TSV? JSON? Editable in-app?
