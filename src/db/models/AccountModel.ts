import mongoose from 'mongoose';

export type AccountStatus = 'active' | 'disabled';
export type AuthStatus = 'unknown' | 'valid' | 'needs_reauth';
export type LinkStatus = 'unlinked' | 'linked';

export type CompanyPage = {
  pageId: string;
  name: string;
  url: string;
};

export interface AccountDoc {
  accountId: string;
  displayName: string;
  email: string;
  timezone: string;
  status: AccountStatus;
  linkStatus: LinkStatus;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
  companyPages?: CompanyPage[];
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

const CompanyPageSchema = new SchemaAny(
  {
    pageId: { type: String, required: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
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
    linkStatus: { type: String, required: true, enum: ['unlinked', 'linked'], default: 'unlinked' },
    proxy: { type: ProxySchema as any, required: false },
    companyPages: { type: [CompanyPageSchema as any], required: false, default: [] },
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
