import { AbilityBuilder, createMongoAbility, MongoAbility } from '@casl/ability';

export type Role = 'ADMIN' | 'OPERATOR' | 'DEPARTMENT';

export type Action = 'create' | 'read' | 'update' | 'delete' | 'manage';

export type Subject =
  | 'User'
  | 'Department'
  | 'Media'
  | 'Presentation'
  | 'Schedule'
  | 'Screen'
  | 'Request'
  | 'Notification'
  | 'AuditLog'
  | 'DevicePairing'
  | 'Emergency'
  | 'all';

// Define the fields that can be used in conditions for each subject
export interface SubjectFields {
  User: { department_id?: string };
  Request: { created_by?: string };
  Notification: { user_id?: string };
}

export type AppAbility = MongoAbility<[Action, Subject]>;

export function defineAbilityFor(role: Role, userId: string, departmentId?: string): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  if (role === 'ADMIN') {
    // Admins can do everything
    can('manage', 'all');
  } else if (role === 'OPERATOR') {
    // Operators can read most things and manage requests/schedules
    can('read', 'all');
    can('create', 'Request');
    can('update', 'Request');
    can('create', 'Schedule');
    can('update', 'Schedule');
    can('create', 'Media');
    can('update', 'Media');
    can('create', 'Presentation');
    can('update', 'Presentation');
    can('read', 'AuditLog');
  } else if (role === 'DEPARTMENT') {
    // Department users can only manage their own department's resources
    can('read', 'User', { department_id: departmentId } as any);
    can('read', 'Request', { created_by: userId } as any);
    can('create', 'Request');
    can('update', 'Request', { created_by: userId } as any);
    can('read', 'Notification', { user_id: userId } as any);
    can('update', 'Notification', { user_id: userId } as any);
  }

  return build();
}

export function checkAbility(ability: AppAbility, action: Action, subject: Subject): boolean {
  return ability.can(action, subject);
}

