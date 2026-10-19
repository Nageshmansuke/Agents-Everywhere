export * as Sqlite from "./sqlite.ts"

import { Context } from "effect"
import type { drizzle } from "drizzle-orm/bun-sqlite"

export type DrizzleClient = ReturnType<typeof drizzle>
/** How long a connection waits on another process's lock before giving up. */
export const BUSY_TIMEOUT_MS = 5000

export class Native extends Context.Service<Native, unknown>()("@agents-everywhere/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@agents-everywhere/core/database/SqliteDrizzle") {}
