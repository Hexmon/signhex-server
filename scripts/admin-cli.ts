// !/usr/bin/env node

import { program } from 'commander';
import { eq, lt } from 'drizzle-orm';
import { initializeDatabase, getDatabase, closeDatabase, schema } from '@/db';
import { hashPassword } from '@/auth/password';
import { randomUUID } from 'crypto';
import { createLogger } from '@/utils/logger';

const logger = createLogger('admin-cli');

async function getDb() {
  await initializeDatabase();
  return getDatabase();
}

program.hook('postAction', async () => {
  await closeDatabase().catch(() => {});
});

program.name('hexmon-admin').description('Hexmon Signage Admin CLI').version('1.0.0');

// Create admin user
program
  .command('create-admin')
  .description('Create an admin user')
  .option('-e, --email <email>', 'Admin email')
  .option('-p, --password <password>', 'Admin password')
  .option('-f, --first-name <name>', 'First name')
  .option('-l, --last-name <name>', 'Last name')
  .action(async (options) => {
    try {
      const db = await getDb();

      const email = options.email || (await prompt('Email: '));
      const password = options.password || (await prompt('Password: ', true));
      const firstName = options.firstName || (await prompt('First name: '));
      const lastName = options.lastName || (await prompt('Last name: '));

      const passwordHash = await hashPassword(password);

      const user = await db
        .insert(schema.users)
        .values({
          id: randomUUID(),
          email,
          password_hash: passwordHash,
          first_name: firstName,
          last_name: lastName,
          role: 'ADMIN',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning();

      logger.info(`Admin user created: ${user[0].email}`);
    } catch (error) {
      logger.error(error, 'Failed to create admin user');
      process.exit(1);
    }
  });

// List users
program
  .command('list-users')
  .description('List all users')
  .option('-r, --role <role>', 'Filter by role')
  .action(async (options) => {
    try {
      const db = await getDb();

      let query = db.select().from(schema.users);

      if (options.role) {
        query = query.where(eq(schema.users.role, options.role));
      }

      const users = await query;

      console.table(
        users.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          active: u.is_active,
          created: u.created_at.toISOString(),
        }))
      );
    } catch (error) {
      logger.error(error, 'Failed to list users');
      process.exit(1);
    }
  });

// Reset password
program
  .command('reset-password')
  .description('Reset user password')
  .option('-e, --email <email>', 'User email')
  .option('-p, --password <password>', 'New password')
  .action(async (options) => {
    try {
      const db = await getDb();

      const email = options.email || (await prompt('Email: '));
      const password = options.password || (await prompt('New password: ', true));

      const passwordHash = await hashPassword(password);

      const result = await db
        .update(schema.users)
        .set({ password_hash: passwordHash, updated_at: new Date() })
        .where(eq(schema.users.email, email))
        .returning();

      if (result.length === 0) {
        logger.error('User not found');
        process.exit(1);
      }

      logger.info(`Password reset for: ${result[0].email}`);
    } catch (error) {
      logger.error(error, 'Failed to reset password');
      process.exit(1);
    }
  });

// Deactivate user
program
  .command('deactivate-user')
  .description('Deactivate a user')
  .option('-e, --email <email>', 'User email')
  .action(async (options) => {
    try {
      const db = await getDb();

      const email = options.email || (await prompt('Email: '));

      const result = await db
        .update(schema.users)
        .set({ is_active: false, updated_at: new Date() })
        .where(eq(schema.users.email, email))
        .returning();

      if (result.length === 0) {
        logger.error('User not found');
        process.exit(1);
      }

      logger.info(`User deactivated: ${result[0].email}`);
    } catch (error) {
      logger.error(error, 'Failed to deactivate user');
      process.exit(1);
    }
  });

// Cleanup expired sessions
program
  .command('cleanup-sessions')
  .description('Clean up expired sessions')
  .action(async () => {
    try {
      const db = await getDb();

      const result = await db
        .delete(schema.sessions)
        .where(lt(schema.sessions.expires_at, new Date()))
        .returning();

      logger.info(`Cleaned up ${result.length} expired sessions`);
    } catch (error) {
      logger.error(error, 'Failed to cleanup sessions');
      process.exit(1);
    }
  });

// Helper function for prompting
async function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');

    if (hidden) {
      process.stdin.setRawMode(true);
    }

    let input = '';
    process.stdin.on('data', (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') {
        process.exit();
      } else {
        input += char;
        if (!hidden) {
          process.stdout.write(char);
        } else {
          process.stdout.write('*');
        }
      }
    });
  });
}

program.parse(process.argv);
