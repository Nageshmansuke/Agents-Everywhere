import * as Effect from "effect/Effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { isSqlError } from "effect/unstable/sql/SqlError"
import assert from "node:assert/strict"
import { layer } from "../src/database/sqlite.node.ts"

const provide = Effect.provide(layer({ filename: ":memory:", disableWAL: true }))

const error = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* SqlClient
    return yield* client.unsafe("selectzzz from nope", []).withoutTransform
  }).pipe(Effect.flip, Effect.scoped, provide),
)

assert.ok(isSqlError(error), "Expected SqlError")
assert.equal(error.reason.message, "Failed to execute statement")
assert.ok(
  error.reason.cause instanceof Error && error.reason.cause.message.includes("syntax error"),
  "Expected the underlying prepare failure to be preserved",
)
console.log("OK: core sqlite.node fails invalid SQL with SqlError, not a defect")

const valuesError = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* SqlClient
    return yield* client.unsafe("selectzzz from nope", []).values
  }).pipe(Effect.flip, Effect.scoped, provide),
)

assert.ok(isSqlError(valuesError), "Expected SqlError")
console.log("OK: core sqlite.node fails invalid SQL on the values path with SqlError")
