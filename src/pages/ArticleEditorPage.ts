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
import { EditorError } from '../errors/error.types';

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

  async maybeUploadCoverImage(coverImagePath?: string): Promise<void> {
    const selector = this.editorSelectors.coverUploadButton;
    if (!selector) return;

    if (!coverImagePath) {
      this.logger.debug('Cover upload skipped (coverImagePath not set)');
      return;
    }

    const isUrl = this.isHttpUrl(coverImagePath);

    let localPath = coverImagePath;
    if (isUrl) {
      try {
        localPath = await this.downloadToTempFile(coverImagePath);
        this.logger.info('Cover image downloaded', { url: coverImagePath, localPath });
      } catch (error) {
        this.logger.warn('Cover upload skipped (failed to download URL)', { coverImagePath, error: String(error) });
        return;
      }
    }

    if (!existsSync(localPath)) {
      this.logger.warn('Cover upload skipped (file not found)', { coverImagePath: localPath });
      return;
    }

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
      } else {
        this.logger.warn('Cover upload button not visible', { selector });
      }
    } catch (error) {
      this.logger.warn('Cover upload failed, continuing', { error: String(error) });
    }
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

    for (let i = 0; i < contentBlocks.length; i++) {
      const block = contentBlocks[i];
      
      this.logger.debug(`Typing block ${i + 1}/${contentBlocks.length}`, { type: block.type });

      if (block.type === 'heading') {
        await this.typeHeading(block.text);
      } else if (block.type === 'list') {
        await this.typeList(block.text);
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

  private async typeParagraph(text: string): Promise<void> {
    await this.humanEngine.typeHumanLike(text, this.editorSelectors.editor);
    
    const editorElement = this.page.locator(this.editorSelectors.editor).first();
    await editorElement.press('Enter');
    await editorElement.press('Enter');
    
    await this.delayEngine.wait(300);
  }

  private async typeHeading(text: string): Promise<void> {
    // LinkedIn editor supports headings; typing plain text still works even if styling isn't applied.
    await this.humanEngine.typeHumanLike(text, this.editorSelectors.editor);

    const editorElement = this.page.locator(this.editorSelectors.editor).first();
    await editorElement.press('Enter');
    await editorElement.press('Enter');
    await this.delayEngine.wait(300);
  }

  private async typeQuote(text: string): Promise<void> {
    await this.humanEngine.typeHumanLike(text, this.editorSelectors.editor);

    const editorElement = this.page.locator(this.editorSelectors.editor).first();
    await editorElement.press('Enter');
    await editorElement.press('Enter');
    await this.delayEngine.wait(300);
  }

  private async typeList(text: string): Promise<void> {
    const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
    const editorElement = this.page.locator(this.editorSelectors.editor).first();

    for (const line of lines) {
      await this.humanEngine.typeHumanLike(line, this.editorSelectors.editor);
      await editorElement.press('Enter');
    }

    await editorElement.press('Enter');
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
