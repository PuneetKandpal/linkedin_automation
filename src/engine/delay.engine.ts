import { DelayRange } from '../config/types';
import { Logger } from './logger';

export class DelayEngine {
  constructor(
    private delayProfile: DelayRange,
    private logger?: Logger
  ) {}

  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private async waitWithLabel(label: string, min: number, max: number): Promise<void> {
    const delay = this.randomBetween(min, max);
    this.logger?.debug(`DelayEngine → ${label}`, { min, max, delay });
    await this.wait(delay);
  }

  async preLaunch(): Promise<void> {
    const [min, max] = this.delayProfile.preLaunch;
    await this.waitWithLabel('preLaunch', min, max);
  }

  async beforeEditorFocus(): Promise<void> {
    const [min, max] = this.delayProfile.beforeEditorFocus;
    await this.waitWithLabel('beforeEditorFocus', min, max);
  }

  async betweenParagraphs(): Promise<void> {
    const [min, max] = this.delayProfile.betweenParagraphs;
    await this.waitWithLabel('betweenParagraphs', min, max);
  }

  async beforePublish(): Promise<void> {
    const [min, max] = this.delayProfile.beforePublish;
    await this.waitWithLabel('beforePublish', min, max);
  }

  async afterPublish(): Promise<void> {
    const [min, max] = this.delayProfile.afterPublish;
    await this.waitWithLabel('afterPublish', min, max);
  }

  async wait(ms: number): Promise<void> {
    this.logger?.debug('DelayEngine → wait', { ms });
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async randomWait(min: number, max: number): Promise<void> {
    await this.waitWithLabel('randomWait', min, max);
  }
}
