import type { User } from './users.ts';

export function isOwner(user: User | null): boolean {
  if (!user || !user.email) return false;
  const owners = (process.env.LEGOS_OWNERS ?? '').split(',').map((owner) => owner.trim().toLowerCase()).filter(Boolean);
  return owners.includes(user.email.toLowerCase());
}
