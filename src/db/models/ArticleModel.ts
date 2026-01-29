import mongoose from 'mongoose';

export type ArticleStatus = 'draft' | 'ready' | 'scheduled' | 'publishing' | 'published' | 'failed';

export interface ArticleDoc {
  articleId: string;
  language: string;
  title: string;
  markdownContent: string;
  coverImagePath?: string;
  communityPostText?: string;
  status: ArticleStatus;
  scheduledAt?: Date;
  publishedAt?: Date;
  publishedUrl?: string;
  publishedByAccountId?: string;
  publishedByAccountName?: string;
  publishedFromCompanyPageUrl?: string;
  publishedFromCompanyPageName?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SchemaAny: any = (mongoose as any).Schema;

const ArticleSchema = new SchemaAny(
  {
    articleId: { type: String, required: true, unique: true, index: true },
    language: { type: String, required: true },
    title: { type: String, required: true },
    markdownContent: { type: String, required: true },
    coverImagePath: { type: String, required: false },
    communityPostText: { type: String, required: false },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'ready', 'scheduled', 'publishing', 'published', 'failed'],
      default: 'draft',
    },
    scheduledAt: { type: Date, required: false },
    publishedAt: { type: Date, required: false },
    publishedUrl: { type: String, required: false },
    publishedByAccountId: { type: String, required: false },
    publishedByAccountName: { type: String, required: false },
    publishedFromCompanyPageUrl: { type: String, required: false },
    publishedFromCompanyPageName: { type: String, required: false },
    lastError: { type: String, required: false },
  } as any,
  { timestamps: true }
);

export const ArticleModel =
  ((mongoose.models as any).Article as any) ||
  (mongoose.model('Article', ArticleSchema) as any);
