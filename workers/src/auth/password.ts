import bcrypt from 'bcryptjs';

const BCRYPT_COST = 10;

// Hash a password using bcrypt
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

// Verify a password against a hash
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Validate password strength
export function validatePassword(password: string): { valid: boolean; error?: string } {
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  if (password.length > 72) {
    // bcrypt has a max of 72 bytes
    return { valid: false, error: 'Password must be at most 72 characters' };
  }
  return { valid: true };
}

// Validate username
export function validateUsername(username: string): { valid: boolean; error?: string } {
  if (username.length < 1) {
    return { valid: false, error: 'Username cannot be empty' };
  }
  if (username.length > 64) {
    return { valid: false, error: 'Username must be at most 64 characters' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { valid: false, error: 'Username can only contain letters, numbers, underscores, and hyphens' };
  }
  // Disallow reserved usernames
  const reserved = ['admin', 'root', 'system', 'anonymous', 'everyone', '*'];
  if (reserved.includes(username.toLowerCase())) {
    return { valid: false, error: 'This username is reserved' };
  }
  return { valid: true };
}
