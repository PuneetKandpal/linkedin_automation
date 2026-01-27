import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

export function markdownToLinkedInHtml(markdown: string): string {
  const normalized = normalizeMarkdown(markdown);

  const html = marked.parse(normalized, {
    gfm: true,
    breaks: true,
  }) as string;

  const sanitized = sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'a',
      'blockquote',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'pre',
      'code',
      'hr',
      'del',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (tagName: string, attribs: Record<string, string>) => {
        const href = attribs.href || '';
        const isHttp = /^https?:\/\//i.test(href);
        return {
          tagName,
          attribs: {
            ...attribs,
            target: isHttp ? '_blank' : attribs.target,
            rel: isHttp ? 'noopener noreferrer' : attribs.rel,
          },
        };
      },
    },
  });

  return sanitized.trim();
}
