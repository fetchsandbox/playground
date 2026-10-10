# Set Up Product Catalog with Prices

Source workflow: https://fetchsandbox.com/docs/stripe?page=workflow-product-catalog-management

## Declared application rule
Local catalog must preserve Stripe unit_amount integer cents exactly; never divide by 100 before storing cents.

## Running surface
POST /records creates the local entity with a provider_id. POST /records/{id}/sync retrieves its provider object and persists the derived business state in SQLite. GET /records/{id} reads the persisted result. Provider failure must leave state unchanged and return 503. Test positive and negative provider states and at least two entities.

The loopback app is a bounded consumer-state fixture, not a complete UI or every endpoint in the guide. It reads provider JSON through urllib. Provider/twin transport is established only if the recorded execution shows it. A provider recorder does not establish live or twin parity. Never use real keys, customer data, payments or messages.
