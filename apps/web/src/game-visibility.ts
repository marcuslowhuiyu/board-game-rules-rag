/**
 * Non-game fixtures live in the same table as real games, so the player-facing
 * list filters them out by slug. Naming convention: evals create `<game>-eval`
 * copies, and acceptance and deploy checks create `acceptance-test-*` and
 * `*-smoke-test` games. They stay in the database; this is view-only.
 */
export const isTestFixtureGame = (game: { slug: string }): boolean =>
  game.slug.endsWith('-eval') ||
  game.slug.startsWith('acceptance-test') ||
  game.slug.endsWith('smoke-test');
