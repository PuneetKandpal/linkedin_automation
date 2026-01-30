import mongoose from 'mongoose';

export interface AutoScheduleConfigDoc {
  configId: string;
  maxArticlesPerCompanyPage: number;
  minGapMinutesSameCompanyPage: number;
  minGapMinutesCompanyPagesSameAccount: number;
  minGapMinutesAcrossAccounts: number;
  estimatedPublishDurationMinutes: number;
  jitterMinutes: number;
  defaultStartOffsetMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

const AutoScheduleConfigSchema = new mongoose.Schema(
  {
    configId: { type: String, required: true, unique: true, index: true, default: 'default' },
    maxArticlesPerCompanyPage: { type: Number, required: true, default: 10 },
    minGapMinutesSameCompanyPage: { type: Number, required: true, default: 180 },
    minGapMinutesCompanyPagesSameAccount: { type: Number, required: true, default: 60 },
    minGapMinutesAcrossAccounts: { type: Number, required: true, default: 30 },
    estimatedPublishDurationMinutes: { type: Number, required: true, default: 18 },
    jitterMinutes: { type: Number, required: true, default: 8 },
    defaultStartOffsetMinutes: { type: Number, required: true, default: 10 },
  } as any,
  { timestamps: true }
);

export const AutoScheduleConfigModel =
  ((mongoose.models as any).AutoScheduleConfig as any) ||
  (mongoose.model('AutoScheduleConfig', AutoScheduleConfigSchema) as any);
