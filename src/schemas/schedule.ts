import { z } from 'zod';

export const createScheduleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

export type CreateScheduleRequest = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
});

export type UpdateScheduleRequest = z.infer<typeof updateScheduleSchema>;

export const createScheduleItemSchema = z.object({
  presentation_id: z.string().uuid(),
  start_at: z.string().datetime(),
  end_at: z.string().datetime(),
  priority: z.number().int().default(0),
});

export type CreateScheduleItemRequest = z.infer<typeof createScheduleItemSchema>;

export const publishScheduleSchema = z.object({
  screen_ids: z.array(z.string().uuid()).optional(),
  screen_group_ids: z.array(z.string().uuid()).optional(),
});

export type PublishScheduleRequest = z.infer<typeof publishScheduleSchema>;

export const scheduleResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  is_active: z.boolean(),
  created_by: z.string().uuid(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

export const scheduleSnapshotResponseSchema = z.object({
  id: z.string().uuid(),
  schedule_id: z.string().uuid(),
  payload: z.record(z.any()),
  created_at: z.string().datetime(),
});

export type ScheduleSnapshotResponse = z.infer<typeof scheduleSnapshotResponseSchema>;

export const listSchedulesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  is_active: z.enum(['true', 'false']).optional(),
});

export type ListSchedulesQuery = z.infer<typeof listSchedulesQuerySchema>;

