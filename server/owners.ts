import type { User } from './users.ts';

export function isOwner(user: User | null): boolean {
  if (!user) return false;
  const owners = (process.env.LEGOS_OWNERS ?? '').split(',').map((owner) => owner.trim().toLowerCase()).filter(Boolean);
  return owners.includes(user.name.toLowerCase()) || !!user.email && owners.includes(user.email.toLowerCase());
}
