import { eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import type { PermissionGrant, RolePermissions } from '@/rbac/permissions';

export const SYSTEM_ROLE_NAMES = ['SUPER_ADMIN', 'ADMIN', 'DEPARTMENT', 'OPERATOR'] as const;
export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

const grant = (action: PermissionGrant['action'], subject: PermissionGrant['subject']): PermissionGrant => ({
  action,
  subject,
});

export const SYSTEM_ROLE_DEFAULTS: Record<SystemRoleName, RolePermissions> = {
  SUPER_ADMIN: {
    grants: [grant('manage', 'all')],
  },
  ADMIN: {
    grants: [grant('manage', 'all')],
  },
  DEPARTMENT: {
    grants: [
      grant('read', 'Dashboard'),
      grant('read', 'Media'),
      grant('create', 'Media'),
      grant('update', 'Media'),
      grant('delete', 'Media'),
      grant('read', 'Layout'),
      grant('create', 'Layout'),
      grant('update', 'Layout'),
      grant('delete', 'Layout'),
      grant('read', 'Presentation'),
      grant('create', 'Presentation'),
      grant('update', 'Presentation'),
      grant('delete', 'Presentation'),
      grant('read', 'Schedule'),
      grant('create', 'Schedule'),
      grant('update', 'Schedule'),
      grant('delete', 'Schedule'),
      grant('read', 'ScheduleItem'),
      grant('create', 'ScheduleItem'),
      grant('update', 'ScheduleItem'),
      grant('delete', 'ScheduleItem'),
      grant('read', 'ScheduleRequest'),
      grant('create', 'ScheduleRequest'),
      grant('update', 'ScheduleRequest'),
      grant('delete', 'ScheduleRequest'),
      grant('read', 'Screen'),
      grant('read', 'ScreenGroup'),
      grant('read', 'Conversation'),
      grant('read', 'Notification'),
      grant('read', 'Role'),
      grant('read', 'User'),
      grant('create', 'User'),
      grant('update', 'User'),
      grant('delete', 'User'),
    ],
  },
  OPERATOR: {
    grants: [
      grant('read', 'Dashboard'),
      grant('read', 'Media'),
      grant('create', 'Media'),
      grant('update', 'Media'),
      grant('delete', 'Media'),
      grant('read', 'Layout'),
      grant('create', 'Layout'),
      grant('update', 'Layout'),
      grant('delete', 'Layout'),
      grant('read', 'Presentation'),
      grant('create', 'Presentation'),
      grant('update', 'Presentation'),
      grant('delete', 'Presentation'),
      grant('read', 'Schedule'),
      grant('create', 'Schedule'),
      grant('update', 'Schedule'),
      grant('delete', 'Schedule'),
      grant('read', 'ScheduleItem'),
      grant('create', 'ScheduleItem'),
      grant('update', 'ScheduleItem'),
      grant('delete', 'ScheduleItem'),
      grant('read', 'ScheduleRequest'),
      grant('create', 'ScheduleRequest'),
      grant('update', 'ScheduleRequest'),
      grant('delete', 'ScheduleRequest'),
      grant('read', 'Screen'),
      grant('read', 'ScreenGroup'),
      grant('read', 'Conversation'),
      grant('read', 'Notification'),
      grant('read', 'Role'),
      grant('read', 'User'),
    ],
  },
};

export const isSystemRoleName = (value: string | null | undefined): value is SystemRoleName =>
  Boolean(value && SYSTEM_ROLE_NAMES.includes(value as SystemRoleName));

export async function syncSystemRolePermissions() {
  const db = getDatabase();

  for (const roleName of SYSTEM_ROLE_NAMES) {
    const [existingRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, roleName));
    if (!existingRole) continue;

    await db
      .update(schema.roles)
      .set({
        permissions: SYSTEM_ROLE_DEFAULTS[roleName],
        is_system: true,
        updated_at: new Date(),
      })
      .where(eq(schema.roles.id, existingRole.id));
  }
}
