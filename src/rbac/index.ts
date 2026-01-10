import { AbilityBuilder, createMongoAbility, MongoAbility } from '@casl/ability';

export type Role = 'ADMIN' | 'OPERATOR' | 'DEPARTMENT';

export type Action = 'create' | 'read' | 'update' | 'delete' | 'manage';

export type Subject =
  | 'User'
  | 'Department'
  | 'Media'
  | 'Layout'
  | 'Presentation'
  | 'Schedule'
  | 'ScheduleRequest'
  | 'Screen'
  | 'ScreenGroup'
  | 'Request'
  | 'Notification'
  | 'AuditLog'
  | 'DevicePairing'
  | 'Emergency'
  | 'EmergencyType'
  | 'ApiKey'
  | 'Webhook'
  | 'SsoConfig'
  | 'OrgSettings'
  | 'Conversation'
  | 'ProofOfPlay'
  | 'Dashboard'
  | 'all';

// Define the fields that can be used in conditions for each subject
export interface SubjectFields {
  User: { department_id?: string };
  Request: { created_by?: string };
  Notification: { user_id?: string };
  ScheduleRequest: { requested_by?: string };
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
    can('create', 'Layout');
    can('update', 'Layout');
    can('create', 'ScreenGroup');
    can('update', 'ScreenGroup');
    can('read', 'ScreenGroup');
    can('create', 'ScheduleRequest');
    can('read', 'ScheduleRequest', { requested_by: userId } as any);
    can('update', 'ScheduleRequest', { requested_by: userId } as any);
    can('create', 'Presentation');
    can('update', 'Presentation');
    can('read', 'AuditLog');
    can('read', 'Dashboard');
    can('read', 'ProofOfPlay');
    can('read', 'Conversation');
  } else if (role === 'DEPARTMENT') {
    // Department users can only manage their own department's resources
    can('read', 'User', { department_id: departmentId } as any);
    can('read', 'Request', { created_by: userId } as any);
    can('create', 'Request');
    can('update', 'Request', { created_by: userId } as any);
    can('read', 'Notification', { user_id: userId } as any);
    can('update', 'Notification', { user_id: userId } as any);
    can('create', 'ScheduleRequest');
    can('read', 'ScheduleRequest', { requested_by: userId } as any);
    can('update', 'ScheduleRequest', { requested_by: userId } as any);
    can('read', 'Conversation');
  }

  return build();
}

export function checkAbility(ability: AppAbility, action: Action, subject: Subject): boolean {
  return ability.can(action, subject);
}
