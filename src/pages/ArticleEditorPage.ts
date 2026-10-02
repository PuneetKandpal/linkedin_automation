import { Page } from '@playwright/test';
import { createWriteStream, existsSync } from 'fs';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { BasePage } from './BasePage';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';
import { Selectors, ArticleContentBlock } from '../config/types';
import { EditorError, LoginRedirectError } from '../errors/error.types';

export class ArticleEditorPage extends BasePage {
  private readonly ARTICLE_EDITOR_URL = 'https://www.linkedin.com/article/new';

  constructor(
    page: Page,
    logger: Logger,
    humanEngine: HumanEngine,
    delayEngine: DelayEngine,
    private editorSelectors: Selectors
  ) {
    super(page, logger, humanEngine, delayEngine);
  }

  async openNewArticle(): Promise<void> {
    this.logger.info('Opening article editor');
    await this.navigateTo(this.ARTICLE_EDITOR_URL);
    await this.delayEngine.beforeEditorFocus();
    await this.waitForEditorReady();
  }

  async openNewCompanyPageArticle(params: { companyPageUrl?: string; companyPageName?: string }): Promise<void> {
    const { companyPageUrl, companyPageName } = params;
    this.logger.info('Opening company page article editor', { companyPageUrl, companyPageName });

    // Preferred: open the page's article editor directly (the same URL the Create menu links to).
    // The admin "Create" dialog intermittently shows "Create is not available".
    const companyId = companyPageUrl?.match(/\/company\/(\d+)/)?.[1];
    if (companyId) {
      const editorUrl = `https://www.linkedin.com/article/new/?author=${encodeURIComponent(`urn:li:fsd_company:${companyId}`)}`;
      await this.navigateTo(editorUrl);
      await this.delayEngine.wait(1500);

      const landedUrl = this.page.url();
      if (/\/(login|uas\/login|authwall)/.test(landedUrl)) {
        throw new LoginRedirectError('LinkedIn redirected the article editor to sign-in - reconnect the account', {
          url: landedUrl,
          step: 'open_company_editor',
        });
      }

      await this.delayEngine.beforeEditorFocus();
      await this.waitForEditorReady();
      await this.assertCompanyAuthor(companyPageName);
      this.logger.info('Company page article editor opened', { url: this.page.url() });
      return;
    }

    if (companyPageUrl && companyPageUrl.trim().length > 0) {
      await this.navigateTo(companyPageUrl.trim());
    } else if (companyPageName && companyPageName.trim().length > 0) {
      // Best-effort: LinkedIn sometimes exposes managed pages as direct links in nav.
      await this.navigateTo('https://www.linkedin.com/feed/');
      await this.delayEngine.wait(1500);
      await this.page.getByRole('link', { name: companyPageName.trim(), exact: true }).first().click();
    } else {
      throw new Error('Missing companyPageUrl/companyPageName for company page publishing');
    }

    await this.delayEngine.wait(1500);

    const landedUrl = this.page.url();
    if (/\/(login|uas\/login|authwall)/.test(landedUrl)) {
      throw new LoginRedirectError('LinkedIn redirected the company page to sign-in - reconnect the account', {
        url: landedUrl,
        step: 'open_company_page',
      });
    }

    // Codegen path: Page -> Create -> Publish an article
    await this.page.getByRole('link', { name: /create/i }).first().click();
    await this.delayEngine.wait(800);

    // LinkedIn renders this option as a link on most pages; accept menu items/buttons and the
    // "Write an article" wording too.
    const articleOptionName = /(publish|write) an article|write article/i;
    const articleOption = this.page
      .getByRole('link', { name: articleOptionName })
      .or(this.page.getByRole('menuitem', { name: articleOptionName }))
      .or(this.page.getByRole('button', { name: articleOptionName }))
      .first();

    try {
      await articleOption.waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      const options = await this.visibleCreateMenuOptions();
      this.logger.error('Create menu has no article option', { url: this.page.url(), options });
      throw new EditorError(
        `Company page Create menu has no "Publish an article" option. Check the account is a Super or Content admin of this page. Options shown: ${options.join(' | ') || '(none found)'}`,
        { url: this.page.url(), step: 'open_company_article_menu', options }
      );
    }
    await articleOption.click();

    await this.delayEngine.beforeEditorFocus();
    await this.waitForEditorReady();
    this.logger.info('Company page article editor opened', { url: this.page.url() });
  }

  /**
   * The editor shows the author as a button ("LifeTrack Health Individual article"). If the
   * account cannot post for the page, LinkedIn may fall back to the personal profile, so never
   * continue unless the company is the author.
   */
  private async assertCompanyAuthor(companyPageName?: string): Promise<void> {
    const name = companyPageName?.trim();
    if (!name) {
      this.logger.warn('Company page name unknown, cannot verify the article author');
      return;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const authorButton = this.page.getByRole('button', { name: new RegExp(escaped, 'i') }).first();
    try {
      await authorButton.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      throw new EditorError(
        `Article editor is not posting as "${name}". Check the account is a Super or Content admin of this page.`,
        { url: this.page.url(), step: 'verify_company_author' }
      );
    }
    this.logger.info('Article author verified', { author: name });
  }

  /** Text of the clickable items in the open Create menu/dialog, for diagnosing a missing option. */
  private async visibleCreateMenuOptions(): Promise<string[]> {
    try {
      return await this.page.evaluate(() => {
        const doc = (globalThis as any).document as any;
        const isVisible = (el: any) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const clickable = 'a, button, [role="menuitem"], [role="option"]';
        const containers = Array.from(doc.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')).filter(isVisible);
        const items: any[] = containers.length
          ? containers.flatMap((c: any) => Array.from(c.querySelectorAll(clickable)))
          : Array.from(doc.querySelectorAll(clickable)).filter((el: any) =>
              /article|post|event|create|publish|write/i.test(el.innerText || '')
            );
        const texts = items
          .filter(isVisible)
          .map((el: any) => String(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter((t: string) => t.length > 0 && t.length < 80);
        return Array.from(new Set(texts)).slice(0, 25) as string[];
      });
    } catch {
      return [];
    }
  }

  async maybeUploadCoverImage(coverImagePath?: string): Promise<boolean> {
    const selector = this.editorSelectors.coverUploadButton;
    if (!selector) return false;

    if (!coverImagePath) {
      this.logger.debug('Cover upload skipped (coverImagePath not set)');
      return false;
    }

    const isUrl = this.isHttpUrl(coverImagePath);

    let localPath = coverImagePath;
    if (isUrl) {
      try {
        localPath = await this.downloadToTempFile(coverImagePath);
        this.logger.info('Cover image downloaded', { url: coverImagePath, localPath });
      } catch (error) {
        this.logger.warn('Cover upload skipped (failed to download URL)', { coverImagePath, error: String(error) });
        return false;
      }
    }

    if (!existsSync(localPath)) {
      this.logger.warn('Cover upload skipped (file not found)', { coverImagePath: localPath });
      return false;
    }

    let uploaded = false;
    try {
      if (await this.isVisible(selector)) {
        this.logger.info('Uploading cover image', { selector, coverImagePath: localPath });
        const upload = this.page.locator(selector).first();
        try {
          await upload.setInputFiles(localPath);
        } catch {
          const [chooser] = await Promise.all([
            this.page.waitForEvent('filechooser'),
            upload.click(),
          ]);
          await chooser.setFiles(localPath);
        }

        await this.handleCoverModalIfPresent();
        uploaded = true;
      } else {
        this.logger.warn('Cover upload button not visible', { selector });
      }
    } catch (error) {
      this.logger.warn('Cover upload failed, continuing', { error: String(error) });
    }

    return uploaded;
  }

  private async handleCoverModalIfPresent(): Promise<void> {
    const dialog = this.page.locator("role=dialog >> text=/Add cover image/i");

    try {
      if (!(await dialog.isVisible({ timeout: 5000 }))) {
        return;
      }
    } catch {
      return;
    }

    this.logger.info('Cover modal detected, confirming');

    // Prefer clicking "Next" once it becomes enabled.
    const nextBtn = this.page.locator("role=dialog >> role=button[name='Next']").first();
    const start = Date.now();
    while (Date.now() - start < 20000) {
      try {
        if (await nextBtn.isVisible({ timeout: 500 })) {
          if (await nextBtn.isEnabled()) {
            await nextBtn.click();
            break;
          }
        }
      } catch {
        // ignore
      }
      await this.delayEngine.wait(250);
    }

    // Fallbacks for UI variants
    const fallbackConfirmSelectors = [
      "role=dialog >> role=button[name='Done']",
      "role=dialog >> role=button[name='Save']",
      "role=dialog >> role=button[name='Apply']",
      "role=dialog >> role=button[name='Close']",
      "role=dialog >> role=button[name='Dismiss']",
      "role=dialog >> role=button[name='Cancel']",
    ];

    try {
      if (await dialog.isVisible({ timeout: 1000 })) {
        for (const selector of fallbackConfirmSelectors) {
          const btn = this.page.locator(selector).first();
          try {
            if (await btn.isVisible({ timeout: 500 })) {
              if (!(await btn.isEnabled())) continue;
              await btn.click();
              break;
            }
          } catch {
            // try next
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      await dialog.waitFor({ state: 'hidden', timeout: 20000 });
    } catch {
      // ignore
    }

    try {
      await this.waitForSelector(this.editorSelectors.titleInput, 20000);
    } catch {
      // ignore
    }
  }

  private isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
  }

  private async downloadToTempFile(url: string): Promise<string> {
    const resolved = await this.resolveRedirects(url, 0);
    const ext = extname(new URL(resolved).pathname) || '.jpg';
    const filePath = join(tmpdir(), `li_cover_${Date.now()}${ext}`);

    await new Promise<void>((resolve, reject) => {
      const client = resolved.startsWith('https://') ? httpsRequest : httpRequest;
      const req = client(resolved, res => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const stream = createWriteStream(filePath);
        res.pipe(stream);
        stream.on('finish', () => {
          stream.close();
          resolve();
        });
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

    return filePath;
  }

  private async resolveRedirects(url: string, depth: number): Promise<string> {
    if (depth > 5) return url;

    return await new Promise<string>((resolve, reject) => {
      const client = url.startsWith('https://') ? httpsRequest : httpRequest;
      const req = client(url, res => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          this.resolveRedirects(next, depth + 1).then(resolve).catch(reject);
          return;
        }

        res.resume();
        resolve(url);
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async waitForEditorReady(): Promise<void> {
    this.logger.info('Waiting for editor to be ready');
    
    try {
      const waitAny = async (selectors: string[], timeoutMs: number) => {
        let lastErr: unknown;
        for (const selector of selectors) {
          try {
            await this.waitForSelector(selector, timeoutMs);
            return selector;
          } catch (err) {
            lastErr = err;
            this.logger.debug('Editor wait fallback selector failed', { selector, error: String(err) });
          }
        }
        throw lastErr;
      };

      const titleSelector = await waitAny(
        [
          this.editorSelectors.titleInput,
          "div[data-placeholder='Title']",
          "div[aria-label='Title']",
          "div[role='textbox'][aria-label='Title']",
          "h1[contenteditable='true']",
          "h1[role='textbox']",
        ],
        15000
      );
      this.logger.info('Title input detected', { selector: titleSelector });

      const editorSelector = await waitAny(
        [
          this.editorSelectors.editor,
          "div.ql-editor[contenteditable='true']",
          "div[data-placeholder*='Write here']",
          "div[role='textbox'][aria-label*='Article editor content']",
        ],
        15000
      );
      this.logger.info('Body editor detected', { selector: editorSelector });
      this.logger.info('Editor is ready');
    } catch (error) {
      this.logger.error('Editor failed to load', { error: String(error) });
      throw new EditorError('Article editor did not load properly');
    }
  }

  async typeTitle(title: string): Promise<void> {
    this.logger.info('Typing article title');
    
    await this.humanEngine.scrollToElement(this.editorSelectors.titleInput);
    await this.delayEngine.wait(500);
    
    await this.humanEngine.typeHumanLike(title, this.editorSelectors.titleInput);
    
    this.logger.info('Title typed successfully', { length: title.length });
  }

  async typeContent(contentBlocks: ArticleContentBlock[]): Promise<void> {
    this.logger.info('Typing article content', { blocks: contentBlocks.length });

    await this.humanEngine.scrollToElement(this.editorSelectors.editor);
    await this.delayEngine.wait(800);

    const editorElement = this.page.locator(this.editorSelectors.editor).first();
    await editorElement.click();
    await this.delayEngine.wait(150);

    for (let i = 0; i < contentBlocks.length; i++) {
      const block = contentBlocks[i];
      
      this.logger.debug(`Typing block ${i + 1}/${contentBlocks.length}`, { type: block.type });

      if (block.type === 'heading') {
        await this.typeHeading(block.text);
      } else if (block.type === 'list') {
        await this.typeList(block.text, block.listStyle);
      } else if (block.type === 'quote') {
        await this.typeQuote(block.text);
      } else {
        await this.typeParagraph(block.text);
      }

      if (i < contentBlocks.length - 1) {
        await this.delayEngine.betweenParagraphs();
      }
    }

    this.logger.info('Content typed successfully');
  }

  async pasteHtmlContent(html: string): Promise<void> {
    this.logger.info('Pasting rich HTML into article editor', { length: html.length });

    await this.humanEngine.scrollToElement(this.editorSelectors.editor);
    await this.delayEngine.wait(800);

    const editorElement = this.page.locator(this.editorSelectors.editor).first();
    await editorElement.click();
    await this.delayEngine.wait(150);

    await editorElement.evaluate((el, richHtml) => {
      const doc = (globalThis as any).document as any;
      const win = (globalThis as any).window as any;

      if (!doc) throw new Error('Document not available');
      if (!el) throw new Error('Editor element not available');

      (el as any).focus?.();

      // Ensure selection is inside the editor before inserting.
      try {
        if (doc.createRange && win && win.getSelection) {
          const range = doc.createRange();
          range.selectNodeContents(el);
          const sel = win.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {
        // ignore
      }

      // Clear selected content then insert rich HTML.
      doc.execCommand('delete');
      doc.execCommand('insertHTML', false, richHtml);
    }, html);

    await this.delayEngine.wait(300);

    const ok = await this.verifyContentPresent();
    if (!ok) {
      throw new EditorError('Failed to paste content into editor');
    }

    this.logger.info('Rich HTML pasted successfully');
  }

  private async typeParagraph(text: string): Promise<void> {
    await this.humanEngine.typeHumanLike(text, this.editorSelectors.editor, { click: false });
    
    await this.page.keyboard.press('Enter');
    await this.page.keyboard.press('Enter');
    await this.delayEngine.wait(300);
  }

  private async typeHeading(text: string): Promise<void> {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page.keyboard.press(`${modifier}+B`);
    await this.humanEngine.typeHumanLike(text, this.editorSelectors.editor, { click: false });
    await this.page.keyboard.press(`${modifier}+B`);

    await this.page.keyboard.press('Enter');
    await this.page.keyboard.press('Enter');
    await this.delayEngine.wait(300);
  }

  private async typeQuote(text: string): Promise<void> {
    await this.humanEngine.typeHumanLike(text, this.editorSelectors.editor, { click: false });

    await this.page.keyboard.press('Enter');
    await this.page.keyboard.press('Enter');
    await this.delayEngine.wait(300);
  }

  private async typeList(text: string, style?: 'bullet' | 'ordered'): Promise<void> {
    const lines = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    if (lines.length === 0) return;

    const editorElement = this.page.locator(this.editorSelectors.editor).first();
    await editorElement.click();

    // Quill shortcuts (used by LinkedIn article editor):
    // - Bulleted list: Ctrl/Meta + Shift + 8
    // - Numbered list: Ctrl/Meta + Shift + 7
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const shortcut = style === 'ordered' ? `${modifier}+Shift+7` : `${modifier}+Shift+8`;

    // Enable list mode
    await this.page.keyboard.press(shortcut);
    await this.delayEngine.wait(150);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await this.humanEngine.typeHumanLike(line, this.editorSelectors.editor, { click: false });

      if (i < lines.length - 1) {
        await this.page.keyboard.press('Enter');
      } else {
        // End list cleanly: create next (empty) bullet, then backspace to exit list without leaving empty bullets.
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.press('Backspace');
        await this.page.keyboard.press('Enter');
      }
    }

    await this.delayEngine.wait(300);
  }

  async verifyContentPresent(): Promise<boolean> {
    try {
      const editorElement = this.page.locator(this.editorSelectors.editor).first();
      const content = await editorElement.textContent();
      return content !== null && content.trim().length > 0;
    } catch {
      return false;
    }
  }
}
