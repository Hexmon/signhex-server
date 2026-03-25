import { AppError } from '@/utils/app-error';

type MediaScopeRow = {
  id: string;
  created_by?: string | null;
  createdBy?: string | null;
  department_id?: string | null;
  departmentId?: string | null;
  scope_department_id?: string | null;
  scopeDepartmentId?: string | null;
  status?: string | null;
};

type AttachmentAuthInput = {
  requestedMediaIds: string[];
  mediaRows: MediaScopeRow[];
  senderId: string;
  senderRole?: string;
  senderDepartmentId?: string | null;
  canOverrideMedia: boolean;
};

function isAdminRole(roleName?: string): boolean {
  return roleName === 'ADMIN' || roleName === 'SUPER_ADMIN';
}

export function assertAttachmentAccess(input: AttachmentAuthInput): void {
  if (input.mediaRows.length !== input.requestedMediaIds.length) {
    throw AppError.badRequest('One or more attachments are invalid');
  }

  for (const media of input.mediaRows) {
    const ownerId = media.created_by ?? media.createdBy ?? null;
    const mediaDepartmentId =
      media.department_id ?? media.departmentId ?? media.scope_department_id ?? media.scopeDepartmentId ?? null;

    if (mediaDepartmentId && input.senderDepartmentId && mediaDepartmentId !== input.senderDepartmentId) {
      throw AppError.forbidden('Attachment media is outside your department scope');
    }

    const isOwner = ownerId === input.senderId;
    if (!isOwner && !isAdminRole(input.senderRole) && !input.canOverrideMedia) {
      throw AppError.forbidden('You cannot attach this media');
    }
  }
}

export function assertAttachmentMediaReady(
  mediaRows: Array<Pick<MediaScopeRow, 'id' | 'status'>>,
  allowedStatuses: string[] = ['READY']
): void {
  const allowed = new Set(allowedStatuses);
  const notReady = mediaRows.filter((row) => !row.status || !allowed.has(row.status));
  if (notReady.length === 0) return;

  throw new AppError({
    statusCode: 409,
    code: 'MEDIA_NOT_READY',
    message: 'One or more attachments are not ready',
    details: { media_ids: notReady.map((row) => row.id) },
  });
}
