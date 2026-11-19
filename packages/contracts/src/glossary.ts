/**
 * Shared Taiwanese meeting vocabulary. Data only — the renderer uses it to
 * finish display normalization, the session routes send it upstream as
 * recognition hints, and both must agree on one list.
 */

/**
 * Mainland wording that OpenCC's Taiwan phrase conversion leaves alone, mapped
 * to the Taiwanese wording. OpenCC already covers the common IT vocabulary in
 * both scripts (软件/軟件 → 軟體, 默认/默認 → 預設, 项目/項目 → 專案 …), so
 * only its gaps belong here.
 *
 * Ambiguous words stay out on purpose. `質量` is also the physical quantity and
 * `訪問` is also a visit, so rewriting them would change what a speaker said —
 * worse, in a verbatim transcript, than leaving one foreign-sounding word.
 */
export const TAIWAN_TERM_REPLACEMENTS: Readonly<Record<string, string>> = {
  調研: '研究',
  走查: '逐步檢視',
  移動端: '行動裝置',
  批處理: '批次處理',
};

/**
 * Terms a meeting is likely to contain that speech models tend to mangle. Sent
 * as `keywords` (OpenAI) and `custom_vocabulary` (Gemini); both treat them as
 * hints, never as required output.
 */
export const MEETING_KEYWORDS: readonly string[] = [
  'API',
  'deploy',
  'deadline',
  'latency',
  'p95',
  'production',
  'review',
  'rollback',
  'scope',
  'sprint',
  'staging',
  '逐字稿',
  '繁體',
];
