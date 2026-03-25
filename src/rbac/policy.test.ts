import { describe, expect, it } from 'vitest';
import { canManageSystemRole, canManageUserRecord, canManageUserRoleTarget, canReadUserRecord } from '@/rbac/policy';

describe('rbac policy helpers', () => {
  it('allows operator management for super admin, admin, and department actors', () => {
    expect(canManageUserRoleTarget('SUPER_ADMIN', 'OPERATOR')).toBe(true);
    expect(canManageUserRoleTarget('ADMIN', 'OPERATOR')).toBe(true);
    expect(canManageUserRoleTarget('DEPARTMENT', 'OPERATOR')).toBe(true);
    expect(canManageUserRoleTarget('OPERATOR', 'OPERATOR')).toBe(false);
  });

  it('keeps system-role editing restricted for admin vs super admin', () => {
    expect(canManageSystemRole('SUPER_ADMIN', 'ADMIN')).toBe(true);
    expect(canManageSystemRole('ADMIN', 'DEPARTMENT')).toBe(true);
    expect(canManageSystemRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canManageSystemRole('DEPARTMENT', 'OPERATOR')).toBe(false);
  });

  it('enforces department scoping for department-managed operator records', () => {
    expect(
      canManageUserRecord(
        { userId: 'dept-user', roleName: 'DEPARTMENT', departmentId: 'dept-a' },
        { id: 'operator-a', roleName: 'OPERATOR', departmentId: 'dept-a' }
      )
    ).toBe(true);

    expect(
      canManageUserRecord(
        { userId: 'dept-user', roleName: 'DEPARTMENT', departmentId: 'dept-a' },
        { id: 'operator-b', roleName: 'OPERATOR', departmentId: 'dept-b' }
      )
    ).toBe(false);
  });

  it('keeps operator users read-only to operator records across departments', () => {
    expect(
      canReadUserRecord(
        { userId: 'operator-user', roleName: 'OPERATOR', departmentId: 'dept-a' },
        { roleName: 'OPERATOR', departmentId: 'dept-b' }
      )
    ).toBe(true);

    expect(
      canReadUserRecord(
        { userId: 'operator-user', roleName: 'OPERATOR', departmentId: 'dept-a' },
        { roleName: 'DEPARTMENT', departmentId: 'dept-a' }
      )
    ).toBe(false);
  });
});
