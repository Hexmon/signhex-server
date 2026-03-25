import { eq, and, asc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class PresentationSlotItemRepository {
  async listByPresentation(presentationId: string) {
    const db = getDatabase();
    return db
      .select()
      .from(schema.presentationSlotItems)
      .where(eq(schema.presentationSlotItems.presentation_id, presentationId))
      .orderBy(asc(schema.presentationSlotItems.slot_id), asc(schema.presentationSlotItems.order));
  }

  async create(data: {
    presentation_id: string;
    slot_id: string;
    media_id: string;
    order?: number;
    duration_seconds?: number;
    fit_mode?: string;
    audio_enabled?: boolean;
    loop_enabled?: boolean;
  }) {
    const db = getDatabase();
    const [item] = await db.insert(schema.presentationSlotItems).values(data).returning();
    return item;
  }

  async findById(id: string) {
    const db = getDatabase();
    const [item] = await db.select().from(schema.presentationSlotItems).where(eq(schema.presentationSlotItems.id, id));
    return item || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.presentationSlotItems).where(eq(schema.presentationSlotItems.id, id));
  }
}

export function createPresentationSlotItemRepository(): PresentationSlotItemRepository {
  return new PresentationSlotItemRepository();
}
