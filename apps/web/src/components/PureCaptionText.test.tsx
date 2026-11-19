import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PureCaptionText } from './PureCaptionText.js';
describe('pure captions presentation', () => {
  it('shows original mixed text once without a translation waiting state', () => {
    const html = renderToStaticMarkup(
      <PureCaptionText text="不是 approve，是 pending review。" status="partial" />,
    );
    expect(html.match(/pending review/g)).toHaveLength(1);
    expect(html).not.toContain('翻譯中');
    expect(html).toContain('辨識中');
  });
  it('escapes transcript markup rather than treating speech as HTML', () => {
    const html = renderToStaticMarkup(
      <PureCaptionText text={'<script>API</script>'} status="final" />,
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
