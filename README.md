# Kindred Club

Golf scores, monthly draws and charitable giving, with Stripe-hosted checkout.

**The Stripe integration is implemented but not yet connected to a Stripe account or deployed for live payments.** Without configured credentials, checkout fails closed. There are no demo payment endpoints or default accounts.

## Prices

- US $19 per month, recurring until cancelled.
- US $190 per year, recurring until cancelled.
- One-off contributions: US $1 to $10,000.

The user requested dollars; the original numeric prices were retained. The backend validates the actual Stripe Price objects against these amounts, currency and billing intervals.

## Run

Node.js 24 or newer is required.

```sh
npm ci
npm start
```

Open http://127.0.0.1:4173. The Windows Start Kindred Club.vbs launcher works after installing dependencies.

Copy .env.example to a private .env file. Set BOOTSTRAP_ADMIN_EMAIL and a unique BOOTSTRAP_ADMIN_PASSWORD of at least 16 characters, then start the server. Remove those bootstrap values after the owner account is created. Sign in, open Admin and add real charity partners. Member registration opens after at least one cause is listed.

No default credentials exist. This version uses data-live/kindred.sqlite. The previous prototype's data directory is preserved but is not loaded. Keep databases, secrets and uploaded evidence out of GitHub.

## Payment integration

Read STRIPE-SETUP.md to connect the owner's account, recurring prices, portal configuration and signed webhook endpoint.

- Stripe Checkout collects card details; the application never sees or stores them.
- Server-controlled prices and stable idempotency keys protect checkout creation. Repeated clicks reuse open sessions. Uncertain failures preserve the pending order for safe retry or reconciliation.
- A browser return from checkout never activates access. Signed paid-invoice notifications grant membership.
- The official Stripe SDK verifies the raw webhook body and a five-minute signature tolerance.
- Event IDs and payment references are separately deduplicated, preventing duplicate ledger entries.
- Current subscriptions are retrieved from Stripe before updating status, handling out-of-order delivery. Paid renewals extend access; past-due or cancelled subscriptions cannot gain access.
- The Stripe billing portal handles invoices, payment methods and cancellation. Administrators cannot manually activate paid membership.
- Donations are recorded only after verified successful payment.
- Charity allocations are internal accounting records. Incoming money goes to the platform's Stripe account. Automatic charity transfers and winner payouts are not implemented. Marking a prize paid records an externally completed payment; it does not send funds.

## Before live operation

No Stripe account, keys or public domain were supplied. No actual Stripe-account checkout or live charge has been performed.

The subscription-linked prize draw and fundraising model must be supported by Stripe in the business's country. Stripe generally prohibits paid prize games, while limited charity-raffle categories require approval in supported countries. An activated account alone does not establish acceptance of this model. See https://stripe.com/legal/restricted-businesses.

Host on a persistent Node.js server with HTTPS and durable storage. This SQLite application cannot use Vercel's ephemeral serverless filesystem as its production database. Supabase/Postgres migration and a Vercel server adapter remain separate work.

Refund and dispute reconciliation, automated remittances, actual prize transfers, email verification/password recovery and charity media uploads are not included. The owner must establish these operational processes before accepting real customers.

## Other features

Member and admin panels; signup/login and password hashing; five-score Stableford retention; unique round dates; charity directory and preferences; weighted or random draw simulations; immutable published snapshots; jackpot rollover; winner evidence and review; contribution reporting.

Draw assumptions: sample five numbers from 1–45 with replacement; reserve 20% of monthly-equivalent active fees; allocate 40%, 35%, 25% across the five/four/three-match tiers; roll over only an unclaimed five-match jackpot; split prizes equally in whole cents, leaving rounding remainders unallocated.

## Verification

```sh
npm test
```

21 automated tests cover account restrictions, score and draw rules, checkout idempotency, paid invoices, renewals, cancellation, donations and signature rejection. Stripe network responses are controlled test doubles; signature tests use the actual Stripe SDK. These tests are not a substitute for an end-to-end test against the owner's Stripe account.

## Files

- server.mjs: HTTP API, sessions and authorisation.
- billing.mjs: Stripe Checkout, portal, webhook processing and verified access.
- schema.sql: persistent SQLite schema.
- lib.mjs: scoring and draw calculations.
- public/: responsive browser interface.
- tests/: isolated automated verification.

Save to Desktop.vbs copies source into the user's actual Desktop without overwriting an existing project. Databases, secrets, dependencies and scratch files must remain excluded. Run npm ci in the copied folder before launching.
