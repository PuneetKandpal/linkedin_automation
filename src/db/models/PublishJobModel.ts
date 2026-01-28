import mongoose from 'mongoose';

export type PublishJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'canceled';

export interface PublishJobDoc {
  jobId: string;
  accountId: string;
  articleId: string;
  delayProfile: string;
  typingProfile: string;
  companyPageUrl?: string;
  companyPageName?: string;
  requestedRunAt?: Date;
  schedulePolicy?: {
    minGapMinutesPerAccount?: number;
    minGapMinutesPerCompanyPage?: number;
  };
  runAt: Date;
  status: PublishJobStatus;
  startedAt?: Date;
  finishedAt?: Date;
  articleUrl?: string;
  error?: string;
  errorCode?: string;
  errorStep?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PublishJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    accountId: { type: String, required: true, index: true },
    articleId: { type: String, required: true, index: true },
    delayProfile: { type: String, required: true, default: 'default' },
    typingProfile: { type: String, required: true, default: 'medium' },
    companyPageUrl: { type: String, required: false },
    companyPageName: { type: String, required: false },
    requestedRunAt: { type: Date, required: false },
    schedulePolicy: {
      type: {
        minGapMinutesPerAccount: { type: Number, required: false },
        minGapMinutesPerCompanyPage: { type: Number, required: false },
      },
      required: false,
      _id: false,
    },
    runAt: { type: Date, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'running', 'success', 'failed', 'canceled'],
      default: 'pending',
      index: true,
    },
    startedAt: { type: Date, required: false },
    finishedAt: { type: Date, required: false },
    articleUrl: { type: String, required: false },
    error: { type: String, required: false },
    errorCode: { type: String, required: false },
    errorStep: { type: String, required: false },
  } as any,
  { timestamps: true }
);

PublishJobSchema.index({ status: 1, runAt: 1 });

export const PublishJobModel =
  ((mongoose.models as any).PublishJob as any) ||
  (mongoose.model('PublishJob', PublishJobSchema) as any);
