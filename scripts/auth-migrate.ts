import { getAuthService, migrateAuth } from "../api/_lib/auth-service.ts";
const service = getAuthService();
try {
  await migrateAuth(service.pool);
  console.log("Authentication schema is ready.");
} finally {
  await service.pool.end();
}
