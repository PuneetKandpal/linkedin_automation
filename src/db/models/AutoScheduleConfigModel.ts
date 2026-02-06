import mongoose from 'mongoose';

export interface AutoScheduleConfigDoc {
  configId: string;
  maxArticlesPerCompanyPage: number;
  maxArticlesPerCompanyPageOptions?: number[];
  minGapMinutesSameCompanyPage: number;
  minGapMinutesSameCompanyPageOptions?: number[];
  minGapMinutesCompanyPagesSameAccount: number;
  minGapMinutesCompanyPagesSameAccountOptions?: number[];
  minGapMinutesAcrossAccounts: number;
  minGapMinutesAcrossAccountsOptions?: number[];
  estimatedPublishDurationMinutes: number;
  estimatedPublishDurationMinutesOptions?: number[];
  defaultStartOffsetMinutes: number;
  defaultStartOffsetMinutesOptions?: number[];
  createdAt: Date;
  updatedAt: Date;
}

const AutoScheduleConfigSchema = new mongoose.Schema(
  {
    configId: { type: String, required: true, unique: true, index: true, default: 'default' },
    maxArticlesPerCompanyPage: { type: Number, required: true, default: 10 },
    maxArticlesPerCompanyPageOptions: { type: [Number], required: false, default: undefined },
    minGapMinutesSameCompanyPage: { type: Number, required: true, default: 180 },
    minGapMinutesSameCompanyPageOptions: { type: [Number], required: false, default: undefined },
    minGapMinutesCompanyPagesSameAccount: { type: Number, required: true, default: 60 },
    minGapMinutesCompanyPagesSameAccountOptions: { type: [Number], required: false, default: undefined },
    minGapMinutesAcrossAccounts: { type: Number, required: true, default: 30 },
    minGapMinutesAcrossAccountsOptions: { type: [Number], required: false, default: undefined },
    estimatedPublishDurationMinutes: { type: Number, required: true, default: 18 },
    estimatedPublishDurationMinutesOptions: { type: [Number], required: false, default: undefined },
    defaultStartOffsetMinutes: { type: Number, required: true, default: 10 },
    defaultStartOffsetMinutesOptions: { type: [Number], required: false, default: undefined },
  } as any,
  { timestamps: true }
);

export const AutoScheduleConfigModel =
  ((mongoose.models as any).AutoScheduleConfig as any) ||
  (mongoose.model('AutoScheduleConfig', AutoScheduleConfigSchema) as any);
