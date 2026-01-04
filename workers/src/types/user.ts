export type UserRole = "admin" | "user" | "anonymous";

export interface User {
  id: string;
  username: string;
  role: UserRole;
  tier: string;
  sync_topic: string;
  created: number;
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  tier: string;
  sync_topic: string;
  created: number;
}

export interface Token {
  id: string;
  user_id: string;
  label: string;
  last_access: number;
  last_origin: string;
  expires: number;
}

export interface TokenRow {
  id: string;
  user_id: string;
  label: string;
  last_access: number;
  last_origin: string;
  expires: number;
}

export interface UserAccess {
  user_id: string;
  topic: string;
  read: boolean;
  write: boolean;
  owner_user_id?: string;
}

export interface UserAccessRow {
  user_id: string;
  topic: string;
  read: number;
  write: number;
  owner_user_id: string | null;
}

// API request/response types

export interface AccountCreateRequest {
  username: string;
  password: string;
}

export interface AccountLoginRequest {
  username: string;
  password: string;
}

export interface AccountTokenIssueRequest {
  label?: string;
  expires?: number;
}

export interface AccountTokenResponse {
  token: string;
  label?: string;
  last_access?: number;
  last_origin?: string;
  expires?: number;
}

export interface AccountResponse {
  username: string;
  role?: string;
  sync_topic?: string;
  tokens?: AccountTokenResponse[];
  tier?: {
    code: string;
    name: string;
  };
  limits?: AccountLimits;
  stats?: AccountStats;
}

export interface AccountLimits {
  basis?: string;
  messages: number;
  messages_expiry_duration: number;
  emails: number;
  calls: number;
  reservations: number;
  attachment_total_size: number;
  attachment_file_size: number;
  attachment_expiry_duration: number;
  attachment_bandwidth: number;
}

export interface AccountStats {
  messages: number;
  messages_remaining: number;
  emails: number;
  emails_remaining: number;
  calls: number;
  calls_remaining: number;
  reservations: number;
  reservations_remaining: number;
  attachment_total_size: number;
  attachment_total_size_remaining: number;
}

// JWT payload
export interface JWTPayload {
  sub: string; // user_id
  username: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// Authenticated request context
export interface AuthContext {
  user?: User;
  token?: Token;
  anonymous: boolean;
}
