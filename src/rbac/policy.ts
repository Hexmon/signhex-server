import { eq, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export type ActorContext = {
  userId: string;
  roleName: string;
  departmentId?: string | null;
};

export const isSuperAdmin = (roleName?: string | null) => roleName === 'SUPER_ADMIN';
export const isAdmin = (roleName?: string | null) => roleName === 'ADMIN';
export const isAdminLike = (roleName?: string | null) => isAdmin(roleName) || isSuperAdmin(roleName);
export const isDepartmentScopedRole = (roleName?: string | null) =>
  roleName === 'DEPARTMENT' || roleName === 'OPERATOR';

export const canManageSystemRole = (actorRoleName: string, targetRoleName: string) => {
  if (isSuperAdmin(actorRoleName)) return true;
  if (actorRoleName === 'ADMIN') {
    return targetRoleName === 'DEPARTMENT' || targetRoleName === 'OPERATOR';
  }
  return false;
};

export const canManageUserRoleTarget = (actorRoleName: string, targetRoleName: string) => {
  if (actorRoleName === 'SUPER_ADMIN') return targetRoleName === 'ADMIN' || targetRoleName === 'OPERATOR';
  if (actorRoleName === 'ADMIN') return targetRoleName === 'DEPARTMENT' || targetRoleName === 'OPERATOR';
  if (actorRoleName === 'DEPARTMENT') return targetRoleName === 'OPERATOR';
  return false;
};

export const canViewUserRoleTarget = (actorRoleName: string, targetRoleName: string) => {
  if (isAdminLike(actorRoleName)) return true;
  if (actorRoleName === 'DEPARTMENT') return targetRoleName === 'OPERATOR';
  if (actorRoleName === 'OPERATOR') return targetRoleName === 'OPERATOR';
  return false;
};

export const isSameDepartment = (actorDepartmentId?: string | null, targetDepartmentId?: string | null) =>
  Boolean(actorDepartmentId && targetDepartmentId && actorDepartmentId === targetDepartmentId);

export const canManageUserRecord = (
  actor: ActorContext,
  target: { id: string; roleName: string; departmentId?: string | null }
) => {
  if (isSuperAdmin(actor.roleName)) return target.roleName === 'ADMIN' || target.roleName === 'OPERATOR';
  if (isAdmin(actor.roleName)) return target.roleName === 'DEPARTMENT' || target.roleName === 'OPERATOR';
  if (actor.roleName === 'DEPARTMENT') {
    return target.roleName === 'OPERATOR' && isSameDepartment(actor.departmentId, target.departmentId);
  }
  return false;
};

export const canReadUserRecord = (
  actor: ActorContext,
  target: { roleName: string; departmentId?: string | null }
) => {
  if (isAdminLike(actor.roleName)) return true;
  if (actor.roleName === 'DEPARTMENT') {
    return target.roleName === 'OPERATOR' && isSameDepartment(actor.departmentId, target.departmentId);
  }
  if (actor.roleName === 'OPERATOR') {
    return target.roleName === 'OPERATOR';
  }
  return false;
};

export async function getDepartmentUserIds(departmentId?: string | null) {
  if (!departmentId) return [] as string[];
  const db = getDatabase();
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.department_id, departmentId));
  return rows.map((row) => row.id);
}

export async function getUserDepartmentMap(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string | null>();
  const db = getDatabase();
  const rows = await db
    .select({ id: schema.users.id, department_id: schema.users.department_id })
    .from(schema.users)
    .where(inArray(schema.users.id, userIds as any));

  return new Map(rows.map((row) => [row.id, row.department_id ?? null]));
}

export async function getUserRoleMap(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string | null>();
  const db = getDatabase();
  const rows = await db
    .select({ id: schema.users.id, role: schema.roles.name })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.users.role_id, schema.roles.id))
    .where(inArray(schema.users.id, userIds as any));

  return new Map(rows.map((row) => [row.id, row.role ?? null]));
}

export async function canAccessOwnedResource(
  actor: ActorContext,
  ownerUserId?: string | null,
  options?: { creatorOnlyForScopedRoles?: boolean; allowUnownedForAdminOnly?: boolean }
) {
  if (isAdminLike(actor.roleName)) return true;
  if (!isDepartmentScopedRole(actor.roleName)) return false;
  if (!ownerUserId) {
    return options?.allowUnownedForAdminOnly ? false : true;
  }
  if (options?.creatorOnlyForScopedRoles) {
    return ownerUserId === actor.userId;
  }

  const ownerDepartments = await getUserDepartmentMap([ownerUserId]);
  return isSameDepartment(actor.departmentId, ownerDepartments.get(ownerUserId));
}

export async function canReadLayoutResource(actor: ActorContext, ownerUserId?: string | null) {
  if (isAdminLike(actor.roleName)) return true;
  if (!ownerUserId) return false;
  if (!isDepartmentScopedRole(actor.roleName)) return false;

  const ownerRoles = await getUserRoleMap([ownerUserId]);
  if (ownerRoles.get(ownerUserId) === 'ADMIN') {
    return true;
  }

  const ownerDepartments = await getUserDepartmentMap([ownerUserId]);
  return isSameDepartment(actor.departmentId, ownerDepartments.get(ownerUserId));
}

export async function canReadAdminSharedResource(actor: ActorContext, ownerUserId?: string | null) {
  if (isAdminLike(actor.roleName)) return true;
  if (ownerUserId && ownerUserId === actor.userId) return true;
  if (!ownerUserId || !isDepartmentScopedRole(actor.roleName)) return false;

  const ownerRoles = await getUserRoleMap([ownerUserId]);
  if (ownerRoles.get(ownerUserId) === 'ADMIN') {
    return true;
  }

  const ownerDepartments = await getUserDepartmentMap([ownerUserId]);
  return isSameDepartment(actor.departmentId, ownerDepartments.get(ownerUserId));
}

export async function getAdminUserIds() {
  const db = getDatabase();
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.users.role_id, schema.roles.id))
    .where(eq(schema.roles.name, 'ADMIN'));
  return rows.map((row) => row.id);
}
