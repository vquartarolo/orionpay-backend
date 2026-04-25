export const PERMISSIONS = [
  "cashout:approve",
  "cashout:reject",
  "kyc:approve",
  "kyc:reject",
  "user:freeze",
  "user:unfreeze",
  "user:manage",
  "compliance:view",
  "accounting:view",
  "security:view",
  "backup:create",
  "config:update",
  "approvals:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  user:            [],
  seller:          [],
  moderator:       [
    "compliance:view", "accounting:view", "security:view",
    "kyc:approve", "kyc:reject",
  ],
  super_moderator: [
    "compliance:view", "accounting:view", "security:view",
    "kyc:approve", "kyc:reject",
    "user:freeze", "user:unfreeze", "user:manage",
    "cashout:approve", "cashout:reject",
    "approvals:manage",
  ],
  admin: [
    "compliance:view", "accounting:view", "security:view",
    "kyc:approve", "kyc:reject",
    "user:freeze", "user:unfreeze", "user:manage",
    "cashout:approve", "cashout:reject",
    "approvals:manage", "config:update", "backup:create",
  ],
  master: [
    "compliance:view", "accounting:view", "security:view",
    "kyc:approve", "kyc:reject",
    "user:freeze", "user:unfreeze", "user:manage",
    "cashout:approve", "cashout:reject",
    "approvals:manage", "config:update", "backup:create",
  ],
};
