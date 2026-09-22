# Stripe setup

## Owner account

Create and activate your own account at https://dashboard.stripe.com/register. Complete identity, business and bank verification yourself. Describe the actual paid prize draw and fundraising model to Stripe; do not describe it as an unrelated product. Check the applicable country restrictions and obtain any required acceptance before using live keys: https://stripe.com/legal/restricted-businesses.

## Prices and portal

Create one product with two USD recurring Prices: $19 every month and $190 every year. Use a fixed quantity of 1, without trials or coupons. Set STRIPE_MONTHLY_PRICE_ID and STRIPE_YEARLY_PRICE_ID to their price_ identifiers.

Create a customer portal configuration with invoices, payment method updates and cancellation enabled. Disable subscription price/quantity updates, discounts and retention coupons; this implementation validates full-price invoices. Set STRIPE_PORTAL_CONFIGURATION_ID to its bpc_ identifier.

## Private environment

Copy .env.example to .env locally, or use the hosting provider's encrypted environment settings. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, both Price IDs, the portal configuration ID and APP_URL. Do not share secret values in chat or commit them to GitHub.

Live keys require a public HTTPS APP_URL containing only the origin, without a path. Keep Stripe test/live keys, prices, customers and webhooks separate. The default amounts are USD $19 and $190.

## Webhook

Register the public endpoint https://YOUR-DOMAIN/api/stripe/webhook in Stripe Workbench. Use snapshot event API version 2026-08-26.dahlia, matching the installed SDK, and subscribe to:

- checkout.session.completed
- checkout.session.async_payment_succeeded
- checkout.session.expired
- invoice.paid
- invoice.payment_failed
- customer.subscription.created
- customer.subscription.updated
- customer.subscription.deleted

Store its whsec_ signing secret privately. Access updates only after verified processing; returning to the success URL is not proof of payment.

For local Stripe-account testing, install the official Stripe CLI and run:

```sh
stripe listen --forward-to http://127.0.0.1:4173/api/stripe/webhook
```

Use that listener's signing secret locally. Production requires a publicly reachable HTTPS webhook.

## Hosting and acceptance

Use a persistent Node.js 24 host with a mounted DATA_DIR and the host's HTTPS reverse proxy. Configure HOST for that host, and set APP_URL to the public origin. SQLite files cannot serve as durable storage on an ephemeral Vercel function; migrate to a hosted database and adapt the server if that deployment target is required.

Verify checkout completion/cancellation, paid renewal, failed renewal, portal cancellation, duplicate notifications and donation settlement against your Stripe account's test environment. No such account-level tests have yet run. The owner must perform any real payment used for final validation.

Refund/dispute reconciliation requires an operational process. Incoming Checkout payments belong to the platform Stripe account; automatic remittance to charities and prize winners is not implemented. An admin payout entry only records a separately completed payment.

## Official references

- https://docs.stripe.com/payments/checkout/build-subscriptions
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/api/checkout/sessions/create
- https://docs.stripe.com/api/customer_portal/sessions/create
