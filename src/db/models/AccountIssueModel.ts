import mongoose from 'mongoose';

export type AccountIssueStatus = 'open' | 'resolved';

export interface AccountIssueDoc {
  accountId: string;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
  status: AccountIssueStatus;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
}

const SchemaAny: any = (mongoose as any).Schema;

const AccountIssueSchema = new SchemaAny(
  {
    accountId: { type: String, required: true, index: true },
    code: { type: String, required: true, index: true },
    message: { type: String, required: true },
    metadata: { type: (SchemaAny as any).Types.Mixed, required: false },
    status: { type: String, required: true, enum: ['open', 'resolved'], default: 'open', index: true },
    resolvedAt: { type: Date, required: false },
  } as any,
  { timestamps: true }
);

AccountIssueSchema.index({ accountId: 1, status: 1, createdAt: -1 });

export const AccountIssueModel =
  ((mongoose.models as any).AccountIssue as any) ||
  (mongoose.model('AccountIssue', AccountIssueSchema) as any);
