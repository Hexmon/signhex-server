import { z } from 'zod';
import { validatePasswordStrength } from '@/auth/password';

export const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .refine((val) => {
      try {
        validatePasswordStrength(val);
        return true;
      } catch {
        return false;
      }
    }, 'Password must include upper, lower, number, and special character and meet length requirements'),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  role_id: z.string().uuid(),
  department_id: z.string().uuid().optional(),
});

export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  role_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  is_active: z.boolean().optional(),
});

export type UpdateUserRequest = z.infer<typeof updateUserSchema>;

export const userResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  role: z.string().nullable(),
  role_id: z.string().uuid(),
  department_id: z.string().uuid().optional(),
  is_active: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  role: z.string().min(1).optional(),
  role_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).optional(),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
