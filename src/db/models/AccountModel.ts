import mongoose from 'mongoose';

export type AccountStatus = 'active' | 'disabled';
export type AuthStatus = 'unknown' | 'valid' | 'needs_reauth';

export interface AccountDoc {
  accountId: string;
  displayName: string;
  email: string;
  timezone: string;
  status: AccountStatus;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
  authStatus: AuthStatus;
  storageStateEnc?: string;
  storageStateUpdatedAt?: Date;
  lastAuthError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SchemaAny: any = (mongoose as any).Schema;

const ProxySchema = new SchemaAny(
  {
    server: { type: String, required: true },
    username: { type: String, required: false },
    password: { type: String, required: false },
  },
  { _id: false }
);

const AccountSchema = new SchemaAny(
  {
    accountId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    email: { type: String, required: true },
    timezone: { type: String, required: true },
    status: { type: String, required: true, enum: ['active', 'disabled'], default: 'active' },
    proxy: { type: ProxySchema as any, required: false },
    authStatus: {
      type: String,
      required: true,
      enum: ['unknown', 'valid', 'needs_reauth'],
      default: 'unknown',
    },
    storageStateEnc: { type: String, required: false },
    storageStateUpdatedAt: { type: Date, required: false },
    lastAuthError: { type: String, required: false },
  } as any,
  { timestamps: true }
);

export const AccountModel =
  ((mongoose.models as any).Account as any) ||
  (mongoose.model('Account', AccountSchema) as any);
