import { test, expect } from '@playwright/test';
import {
  buildPrompt,
  cleanGeneratedContent,
  columnKey,
  detectFormat,
  finalPrompt,
  findPlaceholders,
  reviewArticle,
  wordCount,
  wordTarget,
} from '../../src/services/generate-prompt';

const links = { sample: 'https://x.test/sample', discount: 'https://x.test/discount', customization: 'https://x.test/custom' };
const build = (template: string, title = 'Leather Jewellery Box Market', values: Record<string, string> = {}, rowLinks = links) =>
  buildPrompt({ title, template, links: rowLinks, values });

test.describe('market name', () => {
  test('{{industry_name}} Market reads as the report title, not "... Market Market"', () => {
    const { prompt } = build('About the "{{industry_name}} Market" for {{industry_name}} makers.');
    expect(prompt).toBe('About the "Leather Jewellery Box Market" for Leather Jewellery Box makers.');
  });

  test('[XYZ] becomes the title and absorbs the "market" after it', () => {
    const { prompt } = build(
      'a briefing on the [XYZ] market for allocators.\n[XYZ] Market (By [Actual Segment 1]: [Sub-segs])\nreport for: [XYZ]',
      'Corrosion Inhibitors Market'
    );
    expect(prompt).toBe(
      'a briefing on the Corrosion Inhibitors Market for allocators.\nCorrosion Inhibitors Market (By [Actual Segment 1]: [Sub-segs])\nreport for: Corrosion Inhibitors Market'
    );
  });

  test('a title without "Market" keeps the template\'s own word', () => {
    expect(build('on the [XYZ] market; the {{industry_name}} Market', 'Cat Sitting Services').prompt).toBe(
      'on the Cat Sitting Services market; the Cat Sitting Services Market'
    );
  });
});

test.describe('links', () => {
  test('each CTA placeholder gets its own row link, and the placed links are listed', () => {
    const { prompt, unresolvedLinks, placedLinks } = build('A\n(Paste Sample Download link here)\nB\n(Paste Discount link here)\nC\n(Paste Customization Link here)');
    expect(prompt).toBe('A\nhttps://x.test/sample\nB\nhttps://x.test/discount\nC\nhttps://x.test/custom');
    expect(unresolvedLinks).toEqual([]);
    expect(placedLinks).toEqual(['https://x.test/sample', 'https://x.test/discount', 'https://x.test/custom']);
  });

  test('a template without link placeholders places no links', () => {
    expect(build('Write about [XYZ].').placedLinks).toEqual([]);
  });

  test('an empty link cell is reported, never invented', () => {
    const { prompt, unresolvedLinks } = build('(Paste Discount link here)', undefined, {}, { ...links, discount: '' });
    expect(prompt).toBe('(Paste Discount link here)');
    expect(unresolvedLinks).toEqual([{ placeholder: '(Paste Discount link here)', kind: 'discount' }]);
  });

  test('a placeholder that does not name its link is reported', () => {
    expect(build('Visit:\n(Insert Link here)').unresolvedLinks).toEqual([{ placeholder: '(Insert Link here)', kind: null }]);
  });
});

test.describe('{{placeholders}}', () => {
  test('supplied values fill placeholders; blank and missing ones stay and are listed', () => {
    const { prompt, unfilled } = build('{{base_year}}-{{forecast_year}} | CAGR {{ cagr }}% | {{key_players_list}}', undefined, {
      base_year: '2025',
      forecast_year: '2033',
      cagr: ' ',
    });
    expect(prompt).toBe('2025-2033 | CAGR {{ cagr }}% | {{key_players_list}}');
    expect(unfilled).toEqual(['{{cagr}}', '{{key_players_list}}']);
  });

  test('{{current_year}} is this year', () => {
    expect(build('Update {{current_year}}').prompt).toBe(`Update ${new Date().getFullYear()}`);
  });

  test('values are inserted literally, even with $ patterns', () => {
    expect(build('{{industry_name}} / {{note}}', 'Price $& Co Market', { note: '$1 off' }).prompt).toBe('Price $& Co / $1 off');
  });

  test('filling an already filled prompt changes nothing, and its links still count as placed', () => {
    const once = build('the [XYZ] market, {{industry_name}}, {{cagr}}\n(Paste Sample Download link here)');
    const twice = build(once.prompt);
    expect(twice.prompt).toBe(once.prompt);
    expect(twice.placedLinks).toEqual(['https://x.test/sample']);
  });

  test('a header becomes a placeholder name', () => {
    expect(columnKey(' Base Year ')).toBe('base_year');
    expect(columnKey('Market Size (2025)')).toBe('market_size_2025');
    expect(findPlaceholders('{{a}} {{ b }} {{a}}')).toEqual(['{{a}}', '{{b}}']);
  });
});

test.describe('format', () => {
  test('the template\'s own format line decides, even when it also mentions the other format', () => {
    expect(detectFormat('=== FORMAT ===\nFORMAT: Markdown\n...Output valid Markdown only — no HTML tags, no HTML at all')).toBe('markdown');
    expect(detectFormat('• Output: Clean HTML. <h1> title, <h2> sections. Markdown is not allowed.')).toBe('html');
  });

  test('without a format line, the format named more often wins; a tie means Markdown', () => {
    expect(detectFormat('Use an HTML table and HTML lists.')).toBe('html');
    expect(detectFormat('Write a short article.')).toBe('markdown');
  });
});

test.describe('closing text', () => {
  test('Gemini and OpenAI get the workflow\'s Final Instructions with the format; Gemini adds its own line', () => {
    expect(finalPrompt('P', 'gemini', 'markdown')).toBe(
      'P\n\nFinal Instructions:\n\nArticle content Format: Markdown\n\n' +
        'Important: Strictly follow the required word count for the article.\n' +
        'Please do not mention HTML or any other technical context in the response.\n\n' +
        'Return only the article itself: no notes, word counts or checklists before or after it.'
    );
    const openai = finalPrompt('P', 'openai', 'html');
    expect(openai).toContain('Article content Format: HTML');
    expect(openai).not.toContain('Please do not mention HTML');
  });

  test('Claude gets exactly the workflow\'s OUTPUT CONTROL block, with no Final Instructions', () => {
    const claude = finalPrompt('P', 'claude', 'html');
    expect(claude).toMatch(/^P\n\nOUTPUT CONTROL \(MANDATORY\):\n\n• Strictly follow[\s\S]*FINAL CHECK:\nBefore finishing, ensure the response is complete, well-balanced, and within the expected length\.\n\nReturn only the article itself/);
    expect(claude).not.toContain('Final Instructions');
  });

  test('placeholders still in the prompt are named so the model does not print them', () => {
    expect(finalPrompt('CAGR {{cagr}} by {{forecast_year}}', 'claude', 'markdown')).toContain(
      'Never print these template placeholders in the article: {{cagr}}, {{forecast_year}}.'
    );
    expect(finalPrompt('no placeholders', 'gemini', 'markdown')).not.toContain('Never print');
  });
});

test.describe('reply clean-up', () => {
  const article = '<h1>Title</h1>\n' + '<p>A long paragraph about the market.</p>\n'.repeat(5);

  test('keeps the fenced article and drops the notes around it', () => {
    expect(cleanGeneratedContent(`\`\`\`html\n${article}\`\`\`\n\n---\n\n**Word Count: 1,398 words**`, 'html')).toBe(article.trim());
  });

  test('an HTML document wrapper is removed: the article starts with <h1>', () => {
    const page = `\`\`\`html\n<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>T</title>\n</head>\n<body>\n\n${article}\n</body>\n</html>\n\`\`\``;
    expect(cleanGeneratedContent(page, 'html')).toBe(article.trim());
    expect(cleanGeneratedContent('<html>\n<h1>T</h1>\n</html>', 'html')).toBe('<h1>T</h1>');
  });

  test('a fence that is never closed loses its opening line', () => {
    expect(cleanGeneratedContent('```markdown\n# Title\nBody', 'markdown')).toBe('# Title\nBody');
    expect(cleanGeneratedContent('```html\n<h1>T</h1>```', 'html')).toBe('<h1>T</h1>');
  });

  test('plain replies are only trimmed, and a short code sample inside one stays', () => {
    expect(cleanGeneratedContent('\n# Title\n\nBody\n', 'markdown')).toBe('# Title\n\nBody');
    const withSample = `# Title\n\n${'Long paragraph. '.repeat(20)}\n\n\`\`\`\nx = 1\n\`\`\`\n\nMore text.`;
    expect(cleanGeneratedContent(withSample, 'markdown')).toBe(withSample);
  });

  test('word count ignores HTML tags, Markdown symbols and link addresses', () => {
    expect(wordCount('<h1>Two words</h1>\n## Three more words\n- one\nhttps://x.test/a-b-c')).toBe(6);
  });
});

test.describe('checks before publishing', () => {
  const md = '# Title\n\nIntro https://x.test/sample more https://x.test/discount and https://x.test/custom.';

  test('a clean article has nothing to check', () => {
    expect(reviewArticle(md, 'markdown', Object.values(links))).toEqual([]);
    expect(reviewArticle('<h1>T</h1><p>x</p>', 'html', [])).toEqual([]);
  });

  test('a lost or doubled CTA link, a printed placeholder and a missing title are reported', () => {
    const bad = 'Intro https://x.test/sample, https://x.test/sample, {{cagr}}%';
    expect(reviewArticle(bad, 'markdown', Object.values(links))).toEqual([
      'does not start with a # title',
      'link appears 2 times: https://x.test/sample',
      'link missing: https://x.test/discount',
      'link missing: https://x.test/custom',
      'prints {{cagr}}',
    ]);
    expect(reviewArticle('<h2>No title</h2>', 'html', [])).toEqual(['does not start with an <h1> title']);
  });

  test('the length a template asks for is read from its own wording', () => {
    expect(wordTarget('Word count: 1,350–1,450 words. Do NOT exceed')).toEqual({ min: 1350, max: 1450 });
    expect(wordTarget('WORD COUNT: Exactly 1,400 words (±50).')).toEqual({ min: 1350, max: 1450 });
    expect(wordTarget('The finished article must be 2000 words MAXIMUM.')).toEqual({ min: null, max: 2000 });
    expect(wordTarget('Write a short article.')).toBeNull();
  });
});
