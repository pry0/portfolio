# Portfolio

Private investment workspace at **https://portfolio.pry0.com/**. This is a standalone application at the subdomain root; there is no `/portfolio` route in this app.

The first release provides a durable source archive and a feature planner. It is not yet a replacement for Sharesight's holdings, performance or tax calculations.

## Implemented

- Owner-only Cloudflare Access sign-in, with a second signed-JWT check in the API.
- Separate personal, company, ISA, LISA, SIPP and junior accounts.
- CSV column mapping, validation and preview, up to 200 rows / 2 MB per import.
- Original CSV content and SHA-256 hashes retained privately in D1, linked to all source rows, including sales.
- Exact decimal strings, explicit currency handling and duplicate warnings. Nothing is silently merged or deleted.
- Review, accept or ignore records, with an audit trail. Accepting a record does not calculate positions.
- Corporate-action register with effective date, security and supporting notes.
- Kraken last-trade observations for BTC, ETH, LINK and XMR, plus dated ECB reference exchange rates. Refresh every four hours and on demand.
- 78 features with Need now / Later / Don't need / Undecided choices, saved privately and exportable.
- JSON record export; original CSV files downloaded separately.
- Resumable Sharesight API migration with an explicit endpoint coverage and gap register.
- Original API responses and documents preserved byte for byte, with SHA-256 hashes. A separate exact-decimal index makes source records browsable without changing financial meaning.
- All portfolios are discovered independently. Trades and reports include sales; historical holding IDs trigger detailed holding exports even if a holding is absent from today's list.
- Income, cash, custom investment prices, adjustments, labels, preferences, groups, memberships, available documents, valuation/performance snapshots and holding value history are requested using documented public APIs. API v3 availability is checked by each request; access failures remain visible gaps.

## Still to build

Run and reconcile the real Sharesight migration; manually recover unavailable contract notes and UK tax reports; bulk CSV imports; historical licensed market-data backfill; security/ISIN mapping; holdings and cash ledgers; corporate-action effects on quantities and cost basis; performance and tax calculations; Xero OAuth, account mapping and controlled posting. An automatic retail HL connection has not been established: the current workflow uses exported files and notices.

The interface shows the latest 100 transactions, imports and corporate events. All archived data remains in the database. JSON export refuses datasets above 10,000 rows per table rather than returning an incomplete backup. There is no automated restore workflow yet. Do not use this release as the sole copy of financial records.

## Sharesight migration

Open **Sharesight migration** in the private app. Connect an existing, already authorised Sharesight API application with its client ID and secret. The app uses the documented `client_credentials` grant for the owner's own linked account. It does not register or authorise a new application and does not revoke the existing crypto-price script. A grant that is not already linked must be authorised separately in Sharesight.

The client ID/secret are used only for that request and are not persisted. The temporary token is encrypted with AES-GCM, bound to its run ID, and retained for at most 30 minutes. It is discarded when all queued endpoints have been attempted. The only POST to Sharesight is the token request. Every data request is a GET to an endpoint allowlist; document redirects never receive the bearer token. User requests also require the existing owner Access authentication and same-origin checks.

Choose **Continue transfer** and leave the page open. Each endpoint is checkpointed. Reconnect to the same snapshot after token expiry. Gaps can be retried individually. Repeated imports do not duplicate source IDs within a snapshot; separate snapshots remain independently archived. No source trades or payouts are confirmed, rejected, edited or deleted. The importer creates account containers, but does not insert inferred accounting entries or alter the cash/cost-basis ledger.

The migration screen has a paginated source-record browser and a separate **Download complete API archive** action. The download assembles bounded API pages into NDJSON containing the manifest, jobs, response metadata, base64 source chunks, exact-value record index, and an `end` marker. An interrupted download is never presented as complete. Credentials and encrypted temporary tokens are excluded. Source chunks reconstruct the original bytes and must match the response SHA-256. The current browser download limit is 128 MB; larger archives require a client that consumes the same paginated export API. Individual responses over 4 MB are flagged for separate recovery, not truncated.

`awaiting_reconciliation` means the API queue has finished, including explicit failures. It does **not** certify completeness. Check the manifest against the account's portfolio list, each portfolio's all-time trade and income reports, closed holdings, cash exports, custom price histories and document counts. UK tax reports, unavailable contract notes, licensed price/FX datasets and connection credentials are not assumed to be covered. Historical record fields and original confirmation states are preserved; no investment calculations are certified by this migration.

Public API contracts: [OAuth](https://portfolio.sharesight.com/api/2/configuring_oauth), [v2](https://portfolio.sharesight.com/api/2/doc/index.html), [v3](https://portfolio.sharesight.com/api/3/doc/index.html).

## Stack and privacy

TypeScript Worker, a small vanilla-JavaScript interface, Cloudflare D1 and Cloudflare Access. No PostgreSQL, paid market-data key or third-party analytics is required by this release. Provider availability and Cloudflare usage limits still apply. Free feeds do not supply every asset, corporate action or historical price.

The source repository contains application code only. Do not commit statements, portfolio records, OAuth tokens or access credentials. R2 is not required for this first release; CSV originals are chunked in D1. Larger documents can use a private object store in a later release.

Production API access requires the configured owner email, issuer and Access application audience, plus a valid RS256 signature and unexpired token. Mutations also check Origin. `workers.dev` and preview URLs are disabled. Cloudflare Access is independently configured on the whole custom domain. The local development bypass requires explicit development mode AND a loopback HTTP URL.

## Development

Use Node 24 and npm:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

The project uses Cloudflare's `cf` CLI and Vite plugin. Generated Worker types and build output are under `.cloudflare/` and are not committed. `cloudflare.config.ts` is the source deployment configuration. The development server binds to `127.0.0.1`.

Local D1 is separate from production. Apply all files in `migrations/` in order to that local database using the development server's Local Explorer. For local secret validation, an ignored `.dev.vars` file can contain placeholders for `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `OWNER_EMAIL`; these are unnecessary for loopback development authentication itself. Migration token encryption additionally requires a random 32-byte `MIGRATION_KEY` encoded as 64 lowercase hexadecimal characters.

## Deployment

Build in production mode. Apply the migration to the bound D1 database before the first deployment. Provision these secret bindings separately:

| Binding              | Value                                               |
| -------------------- | --------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team hostname, without `https://` |
| `ACCESS_AUD`         | The Portfolio Access application's audience         |
| `OWNER_EMAIL`        | The exact email allowed in the Access policy        |
| `MIGRATION_KEY`      | Random 32-byte AES key, encoded as 64 lowercase hex characters |

`LOCAL_DEVELOPMENT` must be `false` in production. Keep the entire custom domain behind the owner-only Access application, with no bypass policies. The cron schedule is `15 */4 * * *` in UTC. The initial deployment uses the Cloudflare API through the connected account; subsequent CLI deployments require an authenticated account with permission to deploy this Worker and preserve its secrets.

```sh
npm run build
npm run deploy
```

The GitHub workflow runs tests, type checks and the production build. Automatic production deployment from GitHub is not configured.

## Validation

The Node test suite covers exact decimals, UK dates, CSV quoting, sold records, duplicate imports, Unicode source preservation, failed-import rollback, review validation, CSRF, signed-owner authentication, and retention of feed data when providers fail. These tests use an in-memory SQLite adapter for D1; they do not certify investment calculations or substitute for reconciling actual broker data.
