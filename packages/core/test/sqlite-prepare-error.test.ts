import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { isSqlError } from "effect/unstable/sql/SqlError"
import { layer } from "../src/database/sqlite.bun"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

test("fails invalid SQL with SqlError instead of a defect (execute path)", async () => {
  const error = await run(
    Effect.gen(function* () {
      const client = yield* SqlClient
      return yield* client.unsafe("selectzzz from nope", []).withoutTransform
    }).pipe(Effect.flip),
  )

  if (!isSqlError(error)) throw new Error("Expected SqlError")
  expect(error.reason.message).toBe("Failed to execute statement")
  expect(error.reason.cause instanceof Error ? error.reason.cause.message : "").toContain("syntax error")
})

test("fails invalid SQL with SqlError instead of a defect (values path)", async () => {
  const error = await run(
    Effect.gen(function* () {
      const client = yield* SqlClient
      return yield* client.unsafe("selectzzz from nope", []).values
    }).pipe(Effect.flip),
  )

  if (!isSqlError(error)) throw new Error("Expected SqlError")
  expect(error.reason.message).toBe("Failed to execute statement")
  expect(error.reason.cause instanceof Error ? error.reason.cause.message : "").toContain("syntax error")
})

test("keeps executing valid SQL", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* SqlClient
      const rows = yield* client.unsafe("select 1 as one", []).withoutTransform
      expect(rows).toEqual([{ one: 1 }])
    }),
  )
})
