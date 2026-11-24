import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      projects: [
        { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node' } },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations, PBKDF2_ITERATIONS: '1000', SUPERUSER_EMAILS: 'superuser@example.org' } },
            }),
          ],
          test: { name: 'api', include: ['test/api/**/*.test.ts'], setupFiles: ['./test/api/setup.ts'], testTimeout: 30000 },
        },
      ],
    },
  };
});
