import { AbilityBuilder, createMongoAbility, MongoAbility } from '@casl/ability';
import { createRoleRepository } from '@/db/repositories/role';
import { RolePermissions, PermissionAction, PermissionSubject, RoleRecord } from '@/rbac/permissions';
import { AppError } from '@/utils/app-error';

export type Action = PermissionAction;
export type Subject = PermissionSubject;

export type AppAbility = MongoAbility<[Action, Subject]>;

type UserContext = {
  id: string;
  department_id?: string | null;
};

const resolveConditionValue = (value: string, user: UserContext) => {
  if (value === '$user.id') return user.id;
  if (value === '$user.department_id') return user.department_id ?? undefined;
  return value;
};

const resolveConditions = (conditions: Record<string, string> | undefined, user: UserContext) => {
  if (!conditions) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(conditions)) {
    const resolvedValue = resolveConditionValue(value, user);
    if (resolvedValue === undefined || resolvedValue === null) {
      return undefined;
    }
    resolved[key] = resolvedValue;
  }
  return resolved;
};

const parsePermissions = (permissions: RolePermissions | null | undefined): RolePermissions => {
  if (!permissions || typeof permissions !== 'object') {
    return { grants: [] };
  }
  const grants = Array.isArray((permissions as any).grants) ? (permissions as any).grants : [];
  const inherits = Array.isArray((permissions as any).inherits) ? (permissions as any).inherits : [];
  return { grants, inherits };
};

const resolveRoleGrants = async (role: RoleRecord, visited: Set<string>): Promise<any[]> => {
  if (visited.has(role.id)) return [];
  visited.add(role.id);

  const roleRepo = createRoleRepository();
  const permissions = parsePermissions(role.permissions);
  const grants = [...permissions.grants];

  if (permissions.inherits && permissions.inherits.length > 0) {
    for (const inheritedId of permissions.inherits) {
      const inheritedRole = await roleRepo.findById(inheritedId);
      if (!inheritedRole) continue;
      const inheritedGrants = await resolveRoleGrants(inheritedRole as any, visited);
      grants.push(...inheritedGrants);
    }
  }

  return grants;
};

export async function defineAbilityFor(roleId: string, userId: string, departmentId?: string): Promise<AppAbility> {
  const roleRepo = createRoleRepository();
  const role = await roleRepo.findById(roleId);
  if (!role) {
    throw AppError.forbidden('Role not found');
  }

  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  if (role.name === 'SUPER_ADMIN') {
    can('manage', 'all');
    return build();
  }

  const userContext: UserContext = { id: userId, department_id: departmentId };
  const grants = await resolveRoleGrants(role as any, new Set<string>());

  grants.forEach((grant: any) => {
    if (!grant || !grant.action || !grant.subject) return;
    const conditions = resolveConditions(grant.conditions, userContext);
    if (grant.action === 'manage') {
      can('manage', grant.subject, conditions as any);
      return;
    }
    can(grant.action, grant.subject, conditions as any);
  });

  return build();
}

export function checkAbility(ability: AppAbility, action: Action, subject: Subject): boolean {
  return ability.can(action, subject);
}
