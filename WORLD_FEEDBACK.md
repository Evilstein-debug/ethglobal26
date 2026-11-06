# World ID integration debrief

Integration: IDKit 4.x (`@worldcoin/idkit-core` 4.6.0 on the server, `@worldcoin/idkit` 4.6.0 in
the web app), credential **Proof of Human**, verified on our backend via
`POST https://developer.world.org/api/v4/verify/{rp_id}`.

**Trust moment.** One unique human = one AgentArena owner account. Without it, one person could
run many accounts to farm the reward pool, stack the predictor leaderboard, or predict against
their own trading agents. **Minimum sufficient assurance:** we don't need identity, nationality
or age, only uniqueness, which Proof of Human gives exactly. The nullifier is scoped to our app
and the action `agentarena-owner-v1`, so it can't be linked to anything else.

## What we built

- RP signatures generated on our server (`/api/world/rp-signature`); the signing key never
  reaches the browser.
- The proof's `signal` is the owner's wallet. The backend checks `signal_hash` against
  `hashSignal(wallet)` before calling the Developer Portal, so a proof can't be replayed for
  another wallet.
- Nullifiers are normalized to decimal integers before the uniqueness check, so hex casing or
  padding can't create a second account.
- Onchain: the verified human's ID (`keccak256(nullifier)`) is registered in `Arena`, which reverts
  predictions on your own human's agents and pays at most one reward per human per epoch.
- Alternative paths in the demo: a second wallet for the same human is rejected
  (`human_already_registered`); a cancelled verification shows a cancelled state; a proof for
  another wallet is rejected (`signal_mismatch`).

## Debrief (fill in after the first live verification)

| Question                                     | Answer                                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time to first successful verification        | _TODO (team): measure with the simulator / World App_                                                                                                                                                                                   |
| Friction                                     | From the docs: World ID 4.0 adds RP registration and server-side RP signatures on top of 3.0's app id + action. The integrate guide covers it well, but it's an extra moving part (`rp_id`, signing key, nonce/expiry) for a hackathon. |
| Missing capability or docs                   | _TODO_. Candidate: a documented, copy-paste way to bind the signal to a wallet and check `signal_hash` server-side (we derived it from `hashSignal` in `@worldcoin/idkit-core/hashing`).                                                |
| The one improvement with the greatest impact | _TODO_                                                                                                                                                                                                                                  |
