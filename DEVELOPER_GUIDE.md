# Hexmon Signage - Developer Guide

## Development Setup

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Git

### Quick Start

```bash
# Clone repository
git clone <repository>
cd server

# Install dependencies
npm install

# Start development environment
docker-compose up -d

# Run migrations
npm run migrate

# Seed initial data
npm run seed

# Start development server
npm run dev
```

The API will be available at `http://localhost:3000`
Swagger UI: `http://localhost:3000/docs`

## Project Structure

```
src/
├── auth/              # JWT, password hashing
├── config/            # Configuration management
├── db/
│   ├── schema.ts      # Database schema
│   └── repositories/  # Data access layer
├── rbac/              # Role-based access control
├── routes/            # API route handlers
├── s3/                # MinIO integration
├── schemas/           # Zod validation schemas
├── server/            # Fastify server setup
├── test/              # Test utilities
├── utils/             # Utility functions
└── index.ts           # Entry point

scripts/
├── seed.ts            # Database seeding
├── admin-cli.ts       # Admin CLI tool
├── backup_postgres.sh # PostgreSQL backup
└── backup_minio.sh    # MinIO backup

drizzle/
└── migrations/        # Database migrations
```

## Adding a New Route

### 1. Create Validation Schema

File: `src/schemas/example.ts`

```typescript
import { z } from 'zod';

export const createExampleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

export const listExamplesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
```

### 2. Create Repository

File: `src/db/repositories/example.ts`

```typescript
import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class ExampleRepository {
  async create(data: { name: string; description?: string }) {
    const db = getDatabase();
    const result = await db.insert(schema.examples).values(data).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.examples)
      .where(eq(schema.examples.id, id));
    return result[0] || null;
  }

  // ... other methods
}
```

### 3. Create Routes

File: `src/routes/examples.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { createExampleSchema } from '@/schemas/example';
import { createExampleRepository } from '@/db/repositories/example';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';

export async function exampleRoutes(fastify: FastifyInstance) {
  const repo = createExampleRepository();

  fastify.post<{ Body: typeof createExampleSchema._type }>(
    '/v1/examples',
    async (request, reply) => {
      const token = extractTokenFromHeader(request.headers.authorization);
      if (!token) return reply.status(401).send({ error: 'Unauthorized' });

      const payload = await verifyAccessToken(token);
      const ability = defineAbilityFor(payload.role as any, payload.sub);

      if (!ability.can('create', 'Example')) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const data = createExampleSchema.parse(request.body);
      const example = await repo.create(data);

      return reply.status(201).send(example);
    }
  );
}
```

### 4. Register Routes

File: `src/server/index.ts`

```typescript
import { exampleRoutes } from '@/routes/examples';

// In createServer function:
await fastify.register(exampleRoutes);
```

## Database Migrations

### Generate Migration

After modifying `src/db/schema.ts`:

```bash
npm run migrate:generate
```

This creates a new migration file in `drizzle/migrations/`.

### Run Migrations

```bash
npm run migrate
```

### Rollback

Drizzle doesn't support automatic rollback. To rollback:

1. Manually revert the migration file
2. Update the schema
3. Generate a new migration

## Testing

### Run Tests

```bash
npm test
```

### Run Tests with Coverage

```bash
npm run test:coverage
```

### Write a Test

File: `src/routes/example.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createTestServer, generateTestToken } from '@/test/helpers';

describe('Example Routes', () => {
  let server: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    server = await createTestServer();
    token = await generateTestToken('test-user', 'ADMIN');
  });

  afterAll(async () => {
    await server.close();
  });

  it('should create example', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/examples',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Test' },
    });

    expect(response.statusCode).toBe(201);
  });
});
```

## Code Style

### Formatting

```bash
npm run format
```

### Linting

```bash
npm run lint
npm run lint:fix
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

## Debugging

### Enable Debug Logging

```bash
DEBUG=* npm run dev
```

### VS Code Debugging

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug",
  "program": "${workspaceFolder}/node_modules/.bin/tsx",
  "args": ["watch", "src/index.ts"],
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen"
}
```

## Common Tasks

### Create Admin User

```bash
npm run admin-cli create-admin
```

### List Users

```bash
npm run admin-cli list-users
```

### Reset Password

```bash
npm run admin-cli reset-password
```

### Backup Database

```bash
./scripts/backup_postgres.sh /path/to/backup
```

### Backup MinIO

```bash
./scripts/backup_minio.sh /path/to/backup
```

## Performance Tips

1. **Use Indexes**: Add indexes for frequently queried columns
2. **Pagination**: Always paginate list endpoints
3. **Caching**: Use Redis for frequently accessed data
4. **Connection Pooling**: Configure PostgreSQL connection pool
5. **Query Optimization**: Use EXPLAIN ANALYZE for slow queries

## Security Checklist

- [ ] Validate all inputs with Zod
- [ ] Check authorization with CASL
- [ ] Hash passwords with argon2id
- [ ] Use HTTPS in production
- [ ] Rotate JWT secrets regularly
- [ ] Audit all mutations
- [ ] Rate limit endpoints
- [ ] Sanitize error messages
- [ ] Use environment variables for secrets
- [ ] Enable CORS only for trusted origins

## Troubleshooting

### Port Already in Use

```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

### Database Connection Error

```bash
# Check PostgreSQL is running
docker-compose ps

# Check connection string in .env
```

### MinIO Connection Error

```bash
# Check MinIO is running
docker-compose ps

# Check MinIO credentials
```

## Resources

- [Fastify Documentation](https://www.fastify.io/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Zod Documentation](https://zod.dev/)
- [CASL Documentation](https://casl.js.org/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)

