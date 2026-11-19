import { beforeAll, describe, expect, it } from 'vitest';
import { loadTranscriptNormalizer, normalizeTranscript } from './transcript-normalization.js';

describe('transcription script normalization', () => {
  beforeAll(() => loadTranscriptNormalizer());

  it('preserves mixed Latin, URLs, email, versions, numbers and repeated speech', () => {
    const raw =
      '不是 approve，是 pending review；API p95 300 ms。https://EXAMPLE.com/v1.2 A@B.com yes yes';
    expect(normalizeTranscript(raw)).toEqual({ text: raw });
  });
  it('preserves the original ASR text when Chinese glyphs change', () => {
    expect(normalizeTranscript('会议 API v2')).toEqual({
      text: '會議 API v2',
      rawText: '会议 API v2',
      textNormalization: 'opencc-cn-twp-v2',
    });
  });
  it('does not rewrite case-sensitive URL paths or email local parts', () => {
    const raw = '会议 https://example.com/会议?q=软件 用户@example.com';
    expect(normalizeTranscript(raw).text).toBe(
      '會議 https://example.com/会议?q=软件 用户@example.com',
    );
  });

  it.each([
    ['视频会议软件', '視訊會議軟體'],
    ['默认设置和鼠标', '預設設定和滑鼠'],
    ['数据库信息', '資料庫資訊'],
    ['这个项目', '這個專案'],
    ['内存和硬盘', '記憶體和硬碟'],
    ['网络连接', '網路連線'],
    ['人工智能服务器打印机', '人工智慧伺服器印表機'],
    ['文档和链接', '文件和連結'],
    ['屏幕交互', '螢幕互動'],
  ])('uses Taiwanese wording, not just Traditional glyphs: %s', (raw, expected) => {
    expect(normalizeTranscript(raw).text).toBe(expected);
  });

  it.each([
    ['調研結論', '研究結論'],
    ['先做走查', '先做逐步檢視'],
    ['移動端畫面', '行動裝置畫面'],
    ['批處理任務', '批次處理任務'],
  ])('applies the project glossary where OpenCC stops: %s', (raw, expected) => {
    expect(normalizeTranscript(raw).text).toBe(expected);
  });

  it.each(['質量管理與物體的質量', '他下午要訪問客戶'])(
    'leaves ambiguous wording alone: %s',
    (raw) => {
      expect(normalizeTranscript(raw)).toEqual({ text: raw });
    },
  );

  it.each([
    '最後一句，明天下午三點再測試。',
    '預算是三十美元，不是三百美元。',
    '這個專案的軟體資訊與預設設定。',
  ])('is idempotent for text that already reads as Taiwanese: %s', (raw) => {
    expect(normalizeTranscript(raw)).toEqual({ text: raw });
  });
});
