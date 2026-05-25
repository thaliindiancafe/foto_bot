import type { Context } from 'telegraf';
import { prisma } from '../db/client.js';
import type { LanguageCode, RoleKey } from '../config/roles.js';

export function resolveLocationForRole(role: RoleKey): 'restaurant' | 'cafe' {
  return role === 'barista' ? 'cafe' : 'restaurant';
}

export async function ensureUserFromContext(ctx: Context) {
  const from = ctx.from;

  if (!from) {
    throw new Error('Missing ctx.from, cannot identify user');
  }

  const telegramId = String(from.id);

  const user = await prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      username: from.username ?? null,
    },
    update: {
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      username: from.username ?? null,
    },
  });

  return user;
}

export async function upsertRegisteredUser(params: {
  telegramId: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  displayName: string;
  role: RoleKey;
  language: LanguageCode;
  location?: string;
}) {
  const resolvedLocation = params.location ?? resolveLocationForRole(params.role);

  const user = await prisma.user.upsert({
    where: { telegramId: params.telegramId },
    create: {
      telegramId: params.telegramId,
      firstName: params.firstName,
      lastName: params.lastName,
      username: params.username,
      displayName: params.displayName,
      role: params.role,
      language: params.language,
      location: resolvedLocation,
    },
    update: {
      firstName: params.firstName,
      lastName: params.lastName,
      username: params.username,
      displayName: params.displayName,
      role: params.role,
      language: params.language,
      location: resolvedLocation,
    },
  });

  await prisma.userRole.upsert({
    where: { userId_role: { userId: user.id, role: params.role } },
    create: { userId: user.id, role: params.role, language: params.language },
    update: { language: params.language },
  });

  return user;
}

/** Add an additional role+language for an existing user (does not switch active role). */
export async function addUserRole(params: {
  userId: number;
  role: RoleKey;
  language: LanguageCode;
}) {
  await prisma.userRole.upsert({
    where: { userId_role: { userId: params.userId, role: params.role } },
    create: { userId: params.userId, role: params.role, language: params.language },
    update: { language: params.language },
  });
}

/** Switch active role: pulls language and location from saved UserRole. */
export async function switchActiveRole(params: { userId: number; role: RoleKey }) {
  const userRole = await prisma.userRole.findUnique({
    where: { userId_role: { userId: params.userId, role: params.role } },
  });

  if (!userRole) {
    throw new Error(`User ${params.userId} does not have role ${params.role}`);
  }

  const location = resolveLocationForRole(params.role);

  return prisma.user.update({
    where: { id: params.userId },
    data: {
      role: params.role,
      language: userRole.language,
      location,
    },
  });
}

export async function getUserRoles(userId: number) {
  return prisma.userRole.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
}
