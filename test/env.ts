// Safety net: unit and integration tests must never run against a non-test database.
if (process.env.DATABASE_URL && !/_test(\?|$)/.test(process.env.DATABASE_URL)) {
  throw new Error("Tests must use a *_test database");
}
