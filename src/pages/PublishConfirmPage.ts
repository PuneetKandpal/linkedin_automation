import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';
import { Selectors } from '../config/types';
import { PublishError } from '../errors/error.types';

export class PublishConfirmPage extends BasePage {
  private publishedUrl: string | null = null;

  constructor(
    page: Page,
    logger: Logger,
    humanEngine: HumanEngine,
    delayEngine: DelayEngine,
    private publishSelectors: Selectors
  ) {
    super(page, logger, humanEngine, delayEngine);
  }

  async publish(options?: { communityPostText?: string }): Promise<void> {
    this.logger.info('Starting publish flow');

    await this.clickNext();
    await this.delayEngine.wait(1200);

    await this.maybeFillCommunityText(options?.communityPostText);

    // Some accounts see an extra wizard step with another Next.
    // Only click it if Publish is not visible yet.
    if (!(await this.isVisible("role=dialog >> role=button[name='Publish']")) && !(await this.isVisible(this.publishSelectors.publishButton))) {
      if (await this.isVisible(this.publishSelectors.nextButton)) {
        this.logger.info('Publish not visible yet, clicking Next again');
        await this.clickNext();
        await this.delayEngine.wait(1200);
        await this.maybeFillCommunityText(options?.communityPostText);
      }
    }

    await this.delayEngine.beforePublish();

    await this.clickPublish();
    await this.delayEngine.wait(1500);

    await this.maybeDismiss();

    await this.waitForPublishSuccess();
  }

  private async clickNext(): Promise<void> {
    const selector = this.publishSelectors.nextButton;
    this.logger.info('Clicking Next', { selector });

    const loc = this.page.locator(selector);
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      try {
        if (!(await el.isVisible())) continue;
        if (!(await el.isEnabled())) continue;
        await el.scrollIntoViewIfNeeded();
        await el.hover();
        await this.delayEngine.wait(400);
        await el.click();
        return;
      } catch {
        // try next
      }
    }

    throw new PublishError('Next button not clickable');
  }

  private async clickPublish(): Promise<void> {
    const modalSelector = "role=dialog >> role=button[name='Publish']";
    const selectors = [modalSelector, this.publishSelectors.publishButton].filter(Boolean) as string[];

    for (const selector of selectors) {
      try {
        this.logger.info('Clicking Publish', { selector });
        const loc = this.page.locator(selector);
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const el = loc.nth(i);
          try {
            if (!(await el.isVisible())) continue;
            if (!(await el.isEnabled())) continue;
            await el.scrollIntoViewIfNeeded();
            await el.hover();
            await this.delayEngine.wait(400);
            await el.click();
            return;
          } catch {
            // try next
          }
        }
      } catch (error) {
        this.logger.debug('Publish click fallback failed', { selector, error: String(error) });
      }
    }

    throw new PublishError('Publish button not clickable');
  }

  private async maybeDismiss(): Promise<void> {
    const selector = this.publishSelectors.dismissButton;
    if (!selector) return;

    try {
      if (await this.isVisible(selector)) {
        this.logger.info('Dismissing post-publish dialog', { selector });
        await this.page.locator(selector).first().click();
      }
    } catch {
      // ignore
    }
  }

  private async maybeFillCommunityText(text?: string): Promise<void> {
    if (!text) {
      this.logger.debug('Community text fill skipped (communityPostText not set)');
      return;
    }

    const finalSelector = this.publishSelectors.finalTextEditor;
    const modalSelector = this.publishSelectors.shareModalText;

    // Prefer the explicit named textbox when present.
    if (finalSelector) {
      try {
        if (await this.isVisible(finalSelector)) {
          this.logger.info('Filling community text (finalTextEditor)', { selector: finalSelector });
          await this.page.locator(finalSelector).first().fill(text);
          return;
        }
      } catch {
        // fall through
      }
    }

    if (modalSelector) {
      try {
        await this.waitForSelector(modalSelector, 15000);
        this.logger.info('Filling community text (share modal)');
        await this.page.locator(modalSelector).first().fill(text);
        return;
      } catch (error) {
        this.logger.warn('Failed to fill community text, continuing', { error: String(error) });
      }
    }
  }

  private async waitForPublishSuccess(): Promise<void> {
    this.logger.info('Waiting for publish confirmation');

    try {
      const urlChanged = await this.waitForUrlChange(30000);
      
      if (urlChanged) {
        this.logger.info('Article published successfully');
        await this.delayEngine.afterPublish();
        return;
      }

      if (await this.isVisible(this.publishSelectors.successIndicator)) {
        this.logger.info('Publish success indicator detected');
        await this.delayEngine.afterPublish();
        return;
      }

      if (this.publishSelectors.getLinkButton && (await this.isVisible(this.publishSelectors.getLinkButton))) {
        this.logger.info('Get link button detected');
        await this.tryCaptureLinkFromGetLink();
        await this.delayEngine.afterPublish();
        return;
      }

      if (this.publishSelectors.congratsHeading && (await this.isVisible(this.publishSelectors.congratsHeading))) {
        this.logger.info('Congrats heading detected');
        await this.tryCaptureLinkFromGetLink();
        await this.delayEngine.afterPublish();
        return;
      }

      throw new PublishError('Publish confirmation not detected');
    } catch (error) {
      this.logger.error('Publish failed', { error: String(error) });
      throw new PublishError('Failed to confirm article publication', { error: String(error) });
    }
  }

  private async waitForUrlChange(timeout: number): Promise<boolean> {
    const originalUrl = await this.getCurrentUrl();
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const currentUrl = await this.getCurrentUrl();
      
      if (currentUrl !== originalUrl && currentUrl.includes('/posts/')) {
        return true;
      }

      await this.delayEngine.wait(500);
    }

    return false;
  }

  async getPublishedArticleUrl(): Promise<string | null> {
    if (this.publishedUrl) {
      this.logger.info('Article URL captured', { url: this.publishedUrl });
      return this.publishedUrl;
    }

    const currentUrl = await this.getCurrentUrl();
    
    if (currentUrl.includes('/posts/') || currentUrl.includes('/pulse/') || currentUrl.includes('/article/')) {
      this.logger.info('Article URL captured', { url: currentUrl });
      return currentUrl;
    }

    return null;
  }

  private async tryCaptureLinkFromGetLink(): Promise<void> {
    const getLinkSelector = this.publishSelectors.getLinkButton;
    if (!getLinkSelector) return;

    try {
      if (await this.isVisible(getLinkSelector)) {
        await this.page.locator(getLinkSelector).first().click();

        if (this.publishSelectors.linkCopiedToast) {
          try {
            await this.waitForSelector(this.publishSelectors.linkCopiedToast, 15000);
          } catch {
            // ignore
          }
        }

        try {
          const clip = await this.page.evaluate(async () => {
            try {
              // @ts-expect-error
              return await navigator.clipboard.readText();
            } catch {
              return '';
            }
          });

          if (typeof clip === 'string' && clip.startsWith('http')) {
            this.publishedUrl = clip;
          }
        } catch {
          // ignore
        }

        const dismissSel = this.publishSelectors.linkCopiedDismissButton || this.publishSelectors.dismissButton;
        if (dismissSel) {
          try {
            if (await this.isVisible(dismissSel)) {
              await this.page.locator(dismissSel).first().click();
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (error) {
      this.logger.warn('Get link capture failed, continuing', { error: String(error) });
    }
  }
}
