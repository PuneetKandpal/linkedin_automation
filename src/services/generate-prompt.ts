/**
 * Prompt construction and article clean-up for li-generate, the "GenAI Content Automation" n8n workflow as a
 * terminal tool. The workflow asked Gemini to fill each template's placeholders ("Message a model2"); in its
 * outputs that skipped placeholders, dropped template lines and invented links for rows that had none. Here
 * the same replacements are plain text substitution: the template is never reworded and a link is never made up.
 */

export type ProviderName = 'openai' | 'gemini' | 'claude';

/** Website templates ask for HTML, LinkedIn templates for Markdown. */
export type OutputFormat = 'html' | 'markdown';

export const FORMAT_LABELS: Record<OutputFormat, string> = { html: 'HTML', markdown: 'Markdown' };

export type LinkKind = 'sample' | 'discount' | 'customization';

export const LINK_LABELS: Record<LinkKind, string> = {
  sample: 'Sample Download Link',
  discount: 'Discount Link',
  customization: 'Customization Link',
};

export interface PromptSource {
  title: string;
  template: string;
  links: Record<LinkKind, string>;
  /** Values for {{name}} placeholders, keyed by columnKey(). Blank values count as not supplied. */
  values: Record<string, string>;
}

export interface UnresolvedLink {
  /** The placeholder as written, e.g. "(Paste Discount link here)". */
  placeholder: string;
  /** The link it asks for; null when the placeholder does not say. */
  kind: LinkKind | null;
}

export interface BuiltPrompt {
  prompt: string;
  /** {{name}} placeholders still in the prompt because no value was supplied, e.g. "{{cagr}}". */
  unfilled: string[];
  /** Link placeholders still in the prompt: the row has no such link, or the placeholder does not name one. */
  unresolvedLinks: UnresolvedLink[];
  /** Links the template placed in the article; each should appear in it exactly once. */
  placedLinks: string[];
}

/** Market-name placeholders: "[XYZ]" in the website templates, the other two as the workflow's prompt named them. */
const MARKET_TOKENS = ['\\[XYZ\\]', '\\(insert market name\\)', '\\(start with market name\\)'];

/** "(Paste Sample Download link here)", "(Insert Discount Link here)", ... and a bare "(Insert Link here)". */
const LINK_PLACEHOLDER = /\((?:paste|insert)\s+(?:the\s+)?(?:(sample(?:\s+download)?|discount|customi[sz]ation|custom)\s+)?link\s+here\)/gi;

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** A column header as a {{placeholder}} name: "Base Year" -> base_year. */
export function columnKey(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * The format a template asks for: its own "FORMAT: Markdown" or "Output: Clean HTML" line, else the
 * format it names more often. LinkedIn templates also say "no HTML tags", so a plain mention is not enough.
 */
export function detectFormat(template: string): OutputFormat {
  const declared = template.match(/\b(?:format|output)\s*:\s*(?:clean\s+|valid\s+)?(markdown|html)\b/i);
  if (declared) return declared[1].toLowerCase() as OutputFormat;
  const mentions = (word: string) => (template.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length;
  return mentions('html') > mentions('markdown') ? 'html' : 'markdown';
}

/** "Leather Jewellery Box Market" -> "Leather Jewellery Box": the templates write "{{industry_name}} Market". */
export function industryName(title: string): string {
  return title.replace(/\s+market\s*$/i, '').trim() || title;
}

/** The {{name}} placeholders in a text, once each, in order of appearance. */
export function findPlaceholders(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(VARIABLE), match => `{{${match[1]}}}`))];
}

function linkKind(word: string): LinkKind {
  const lower = word.toLowerCase();
  if (lower.startsWith('sample')) return 'sample';
  if (lower.startsWith('discount')) return 'discount';
  return 'customization';
}

/**
 * Fills a row's template. Filling an already filled prompt changes nothing, so a continued run can
 * fill a row again and pick up a link or a value that was added since.
 */
export function buildPrompt(source: PromptSource): BuiltPrompt {
  const title = source.title.trim();
  const values: Record<string, string> = {
    industry_name: industryName(title),
    current_year: String(new Date().getFullYear()),
  };
  for (const [key, value] of Object.entries(source.values)) {
    if (value.trim()) values[key] = value.trim();
  }

  // The title usually ends in "Market" already, so "[XYZ] market" must not become "... Market market".
  const endsWithMarket = /\bmarket$/i.test(title);
  let prompt = source.template;
  for (const token of MARKET_TOKENS) {
    prompt = prompt.replace(new RegExp(endsWithMarket ? `${token}(?:\\s+market\\b)?` : token, 'gi'), () => title);
  }

  const unresolvedLinks: UnresolvedLink[] = [];
  prompt = prompt.replace(LINK_PLACEHOLDER, (placeholder: string, named: string | undefined) => {
    const kind = named ? linkKind(named) : null;
    const link = kind ? source.links[kind].trim() : '';
    if (link) return link;
    unresolvedLinks.push({ placeholder, kind });
    return placeholder;
  });

  prompt = prompt.replace(VARIABLE, (placeholder: string, name: string) => values[name.toLowerCase()] || placeholder);

  // Links already in the prompt count too: a continued run fills a prompt whose placeholders became links earlier.
  const placedLinks = Object.values(source.links)
    .map(link => link.trim())
    .filter(link => link && prompt.includes(link));
  return { prompt, unfilled: findPlaceholders(prompt), unresolvedLinks, placedLinks };
}

/** Added to every Claude prompt by the workflow's "Code in JavaScript3" node. */
const CLAUDE_OUTPUT_CONTROL = [
  'OUTPUT CONTROL (MANDATORY):',
  '',
  '• Strictly follow the length requirement already defined in the prompt',
  '• Do NOT exceed the expected length range',
  '• Keep all sections balanced — avoid over-explaining early sections',
  '• Ensure every section is completed fully (no cut-offs)',
  '',
  '• Write concisely and avoid repetition or filler',
  '• If nearing the limit, compress lower-priority sections instead of stopping mid-way',
  '',
  'FINAL CHECK:',
  'Before finishing, ensure the response is complete, well-balanced, and within the expected length.',
].join('\n');

/**
 * The prompt as sent: the filled template, then the closing text the workflow's node for that provider
 * added, word for word, then two rules of our own. In the workflow's outputs the models sometimes printed
 * "{{forecast_year}}" in the article, or ended it with word counts and self-check notes.
 */
export function finalPrompt(prompt: string, provider: ProviderName, format: OutputFormat): string {
  const closing =
    provider === 'claude'
      ? CLAUDE_OUTPUT_CONTROL
      : [
          'Final Instructions:',
          '',
          `Article content Format: ${FORMAT_LABELS[format]}`,
          '',
          'Important: Strictly follow the required word count for the article.',
          ...(provider === 'gemini' ? ['Please do not mention HTML or any other technical context in the response.'] : []),
        ].join('\n');

  const rules = ['Return only the article itself: no notes, word counts or checklists before or after it.'];
  const leftovers = findPlaceholders(prompt);
  if (leftovers.length > 0) rules.push(`Never print these template placeholders in the article: ${leftovers.join(', ')}.`);
  return [prompt, closing, rules.join('\n')].join('\n\n');
}

/**
 * Cleans a reply into the article. Models wrap it in a ```html fence and add notes outside it ("Word Count:
 * 1,398 words"); when a fenced block holds more text than everything around it, that block is the article.
 * HTML articles also lose a <!DOCTYPE>/<html>/<head>/<body> wrapper, since the templates ask for content that
 * starts with <h1>.
 */
export function cleanGeneratedContent(reply: string, format: OutputFormat): string {
  const text = reply.trim();
  const fenced = text.match(/```[\w-]*[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[^\S\r\n]*```/);
  let article = text;
  if (fenced) {
    const around = text.replace(fenced[0], '').trim();
    if (fenced[1].trim().length >= around.length) article = fenced[1].trim();
  } else {
    // A fence opened at the start and never closed on a line of its own.
    const opened = text.match(/^```[\w-]*[^\S\r\n]*\r?\n([\s\S]*?)(?:```)?$/);
    if (opened) article = opened[1].trim();
  }
  if (format === 'html') article = unwrapHtmlDocument(article);
  return article;
}

function unwrapHtmlDocument(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return (body ? body[1] : html)
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?(?:html|body)[^>]*>/gi, '')
    .trim();
}

/** Words of an article, not counting Markdown symbols, HTML tags or link addresses. */
export function wordCount(content: string): number {
  return content
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The length a template asks for: "2000 words MAXIMUM", "Word count: 1,350–1,450", or "Exactly 1,400 words (±50)". */
export function wordTarget(template: string): { min: number | null; max: number } | null {
  const num = (text: string) => Number(text.replace(/,/g, ''));
  const range = template.match(/word count:\s*([\d,]+)\s*[–-]\s*([\d,]+)/i);
  if (range) return { min: num(range[1]), max: num(range[2]) };
  const exact = template.match(/exactly\s+([\d,]+)\s+words\s*\(\s*±\s*([\d,]+)\s*\)/i);
  if (exact) return { min: num(exact[1]) - num(exact[2]), max: num(exact[1]) + num(exact[2]) };
  const maximum = template.match(/([\d,]+)\s+words\s+maximum/i);
  return maximum ? { min: null, max: num(maximum[1]) } : null;
}

/**
 * What a reader should check before publishing: problems a model can introduce that make an article wrong
 * rather than just different (a CTA link lost or doubled, a raw placeholder, no title heading).
 */
export function reviewArticle(content: string, format: OutputFormat, placedLinks: string[]): string[] {
  const issues: string[] = [];
  const startsWithTitle = format === 'html' ? /^<h1[\s>]/i.test(content) : /^# /.test(content);
  if (!startsWithTitle) issues.push(format === 'html' ? 'does not start with an <h1> title' : 'does not start with a # title');
  for (const link of placedLinks) {
    const count = content.split(link).length - 1;
    if (count !== 1) issues.push(count === 0 ? `link missing: ${link}` : `link appears ${count} times: ${link}`);
  }
  const leftovers = findPlaceholders(content);
  if (leftovers.length > 0) issues.push(`prints ${leftovers.join(', ')}`);
  return issues;
}
