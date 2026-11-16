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

## Still to build

Complete Sharesight extraction and reconciliation (including closed portfolios and sold assets); bulk imports and paginated archive search; PDF attachments; historical market-data backfill; security/ISIN mapping; holdings and cash ledgers; corporate-action effects on quantities and cost basis; performance and tax calculations; Xero OAuth, account mapping and controlled posting. An automatic retail HL connection has not been established: the current workflow uses exported files and notices.

The interface shows the latest 100 transactions, imports and corporate events. All archived data remains in the database. JSON export refuses datasets above 10,000 rows per table rather than returning an incomplete backup. There is no automated restore workflow yet. Do not use this release as the sole copy of financial records.

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

Local D1 is separate from production. Apply `migrations/0001_initial.sql` to that local database using the development server's Local Explorer. For local secret validation, an ignored `.dev.vars` file can contain placeholders for `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `OWNER_EMAIL`; these are unnecessary for loopback development authentication itself.

## Deployment

Build in production mode. Apply the migration to the bound D1 database before the first deployment. Provision these secret bindings separately:

| Binding              | Value                                               |
| -------------------- | --------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team hostname, without `https://` |
| `ACCESS_AUD`         | The Portfolio Access application's audience         |
| `OWNER_EMAIL`        | The exact email allowed in the Access policy        |

`LOCAL_DEVELOPMENT` must be `false` in production. Keep the entire custom domain behind the owner-only Access application, with no bypass policies. The cron schedule is `15 */4 * * *` in UTC. The initial deployment uses the Cloudflare API through the connected account; subsequent CLI deployments require an authenticated account with permission to deploy this Worker and preserve its secrets.

```sh
npm run build
npm run deploy
```

The GitHub workflow runs tests, type checks and the production build. Automatic production deployment from GitHub is not configured.

## Validation

The Node test suite covers exact decimals, UK dates, CSV quoting, sold records, duplicate imports, Unicode source preservation, failed-import rollback, review validation, CSRF, signed-owner authentication, and retention of feed data when providers fail. These tests use an in-memory SQLite adapter for D1; they do not certify investment calculations or substitute for reconciling actual broker data.
