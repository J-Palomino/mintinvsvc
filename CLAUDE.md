# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm start          # Run migrations then start the service
npm run migrate    # Run database migrations only
npm test           # Run Jest test suite
```

Tests are located in `tests/` and use Jest with mocking for database and API clients.

## Architecture Overview

This is a multi-location inventory synchronization service that:
1. Fetches store configurations from a Strapi backend
2. Syncs inventory, discounts, and product enrichment data from Dutchie POS APIs to PostgreSQL
3. Bidirectional sync with Odoo ERP (inventory master migration in progress)
4. Caches data in Redis for fast API responses
5. Provides REST endpoints for frontend consumption

**Tech Stack:** Node.js, Express.js, PostgreSQL, Redis, Dutchie POS API, Dutchie Plus GraphQL, Odoo ERP

## Sync Flow

```
                    ┌─────────────────┐
                    │   Dutchie POS   │
                    └────────┬────────┘
                             │
                             ↓ (every 10 min)
                             │ inventory-sync
                             │
                   ┌─────────────────┐
                   │   PostgreSQL    │
                   │ (source=dutchie │
                   │  or source=odoo)│
                   └────────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              ↓             ↓             ↓
        (every 15 min) (every 10 min) (Phase 5)
        odoo-sync      cache-refresh  odoo push
              │             │             │
        ┌─────↓─────┐ ┌─────↓─────┐ ┌─────↓─────┐
        │   Odoo    │ │   Redis   │ │   Odoo    │
        │ (pull in) │ │  (cache)  │ │ (push out)│
        └───────────┘ └───────────┘ └───────────┘
```

### Source Protection

Each sync only updates records matching its source to prevent data overwrites:
- **Dutchie sync** only updates where `source IS NULL OR source = 'dutchie'`
- **Odoo sync** only updates where `source IS NULL OR source = 'odoo'`

### Dutchie → PostgreSQL (inventory-sync)

Every 10 minutes, orchestrated by BullMQ:

1. **Phase 1 - Inventory Sync:** Fetches from Dutchie `/reporting/inventory`, transforms camelCase to snake_case, upserts to PostgreSQL with `source='dutchie'`
2. **Phase 2 - Product Enrichment:** Calls Dutchie Plus GraphQL for effects, tags, images, potency data; matches by SKU
3. **Phase 3 - Discount Sync:** Fetches from Dutchie v2 API with restriction data (product/brand/category eligibility)
4. **Phase 4 - Cache Refresh:** Syncs PostgreSQL data to Redis
5. **Phase 5 - Odoo Sync:** Pushes Dutchie inventory to Odoo ERP (if configured)

### Odoo → PostgreSQL (odoo-sync)

Every 15 minutes (`:05,:20,:35,:50`), pulls products from Odoo with `source='odoo'`

### PostgreSQL → Dutchie (DISABLED)

The `dutchie-sync` job is currently disabled because Dutchie's API does not support external product creation (405 Method Not Allowed) or updates (404 Not Found). Products must be created through Dutchie's compliance integration. The service file exists at `src/services/postgresToDutchieSync.js` and can be re-enabled if Dutchie adds write API support.

### Daily Scheduled Tasks

- **8:00 AM** - GL Journal Export: Generates accounting journal entries for previous day's transactions
- **5:00 AM** - Banner Sync: Updates Strapi tickertape from Dutchie Plus retailer banner

## Key Services

| Service | File | Purpose |
|---------|------|---------|
| InventorySyncService | `src/services/inventorySync.js` | Dutchie POS → PostgreSQL (134-field mapping) |
| DiscountSyncService | `src/services/discountSync.js` | POS discounts with eligibility restrictions → PostgreSQL |
| ProductEnrichmentService | `src/services/productEnrichment.js` | GraphQL enrichment (effects, images, potency) |
| OdooSyncService | `src/services/odooSync.js` | PostgreSQL → Odoo ERP (push Dutchie products) |
| OdooToPostgresSync | `src/services/odooToPostgresSync.js` | Odoo → PostgreSQL (pull Odoo products) |
| PostgresToDutchieSync | `src/services/postgresToDutchieSync.js` | **DISABLED** - Dutchie API doesn't support writes |
| CacheSyncService | `src/services/cacheSync.js` | PostgreSQL → Redis cache |
| BannerSyncService | `src/services/bannerSync.js` | Daily retailer banner → Strapi tickertape |
| GLExportService | `src/services/glExportService.js` | Daily GL journal export for Accumatica (8 AM) |
| HourlySalesService | `src/services/hourlySalesService.js` | Weekly hourly sales aggregation by store |
| StoreConfigService | `src/services/storeConfig.js` | Fetches location configs from Strapi backend |

## API Endpoints

All inventory/discount endpoints are location-scoped:
- `GET /health` - Health check
- `GET /api/locations` - All locations with metadata
- `GET /api/locations/:locationId/inventory` - Paginated inventory (supports `category`, `brand`, `search`, `limit`, `offset`)
- `GET /api/locations/:locationId/inventory/:sku` - Single item with applicable discounts
- `GET /api/locations/:locationId/categories` - Unique categories
- `GET /api/locations/:locationId/brands` - Unique brands
- `GET /api/locations/:locationId/discounts` - Active discounts
- `GET /api/locations/:locationId/sync-status` - Last sync timestamp

Reports:
- `GET /api/reports/daily-sales?date=YYYY-MM-DD` - Generate GL journal export for a specific date
- `GET /api/reports/daily-sales?date=YYYY-MM-DD&email=true` - Generate and email GL journal export
- `GET /api/reports/hourly-sales?startDate=YYYY-MM-DD` - Weekly hourly sales by store (7 days)
- `GET /api/reports/hourly-sales?startDate=...&endDate=...&view=aggregated|detailed|both` - Custom date range

## Database

**Schema:** `src/db/schema.sql` with migrations in `src/db/migrations/`

Key tables:
- `locations` - Store location records
- `inventory` - ~200+ columns from Dutchie product data, keyed by `(location_id, inventory_id)`
- `discounts` - Promotion data with JSONB restriction fields for product/brand/category eligibility
- `sync_metadata` - Tracks last sync timestamps for bidirectional sync

**Source Tracking Columns** (inventory table):
- `source` - Origin system: `'dutchie'`, `'odoo'`, or `'manual'`
- `source_synced_at` - Last sync timestamp from source
- `source_external_id` - ID in source system (e.g., `odoo:product.product:123`)

Composite IDs follow pattern: `{locationId}_{recordId}`

## Cache Strategy

**Architecture:** PostgreSQL (source of truth) → Redis (read cache)

```
Dutchie APIs ──→ PostgreSQL ──→ Redis ──→ API Responses
                    ↑↓
                   Odoo
```

### Redis Key Patterns

| Key | Data | Purpose |
|-----|------|---------|
| `inventory:{locationId}` | JSON array | All active products for store |
| `discounts:{locationId}` | JSON array | All active discounts for store |
| `locations:all` | JSON array | All store metadata |
| `sync:{locationId}:timestamp` | milliseconds | Last sync time |

### Cache Characteristics

- **No TTL** - Data persists until next sync overwrites it
- **Cache-first API** - Endpoints read Redis only, return 503 if unavailable
- **In-memory filtering** - Category/brand/search filters applied after cache retrieval
- **Max staleness** - ~10 minutes between scheduled syncs
- **Manual trigger** - `POST /api/jobs/inventory-sync/trigger`

### Why This Design?

- Avoids N+1 queries on PostgreSQL
- Fast reads (single Redis GET + JSON parse)
- Predictable freshness (not dependent on cache hits)
- Simple invalidation (full replace, no partial updates)

## Environment Variables

Required:
- `DATABASE_URL` / `DATABASE_PUBLIC_URL` / `POSTGRES_URL` - PostgreSQL connection
- `REDIS_URL` - Redis connection
- `DUTCHIE_PLUS_API_KEY` - GraphQL API key for enrichment
- `STRAPI_API_TOKEN` - Authentication for Strapi updates

Optional:
- `STORES_API_URL` - Backend URL (default: production Railway URL)
- `SYNC_INTERVAL_MINUTES` - Sync frequency (default: 10)
- `PORT` / `API_PORT` - Server port (default: 3000)
- `API_KEY` - API key for `/api/*` endpoints (default: `7d176bcd2ea77429918fa50c85ebfa5ee5c09cde2ff72850660d81c4a4b40bb3`)

Odoo Integration (optional):
- `ODOO_URL` - Odoo server URL (e.g., `https://mycompany.odoo.com`)
- `ODOO_DATABASE` - Odoo database name (default: `odoo`)
- `ODOO_USERNAME` - Odoo username/email
- `ODOO_API_KEY` - Odoo API key or password
- `ODOO_SYNC_STOCK` - Enable stock quantity sync (default: `false`)

Dutchie Backoffice (for non-FL prepaid sales):
- `DUTCHIE_BACKOFFICE_USERNAME` - Backoffice login username (enables auto-login)
- `DUTCHIE_BACKOFFICE_PASSWORD` - Backoffice login password
- `DUTCHIE_SESSION_ID` - Static session ID (fallback if no username/password)
- `DUTCHIE_LSP_ID` - LSP ID (default: 575)
- `DUTCHIE_ORG_ID` - Org ID (default: 5134)

GL Export Email (optional):
- `SMTP_HOST` - SMTP server hostname
- `SMTP_PORT` - SMTP port (default: 587)
- `SMTP_USER` - SMTP username
- `SMTP_PASS` - SMTP password
- `GL_EMAIL_TO` - Recipient emails (comma-separated)
- `GL_EMAIL_FROM` - Sender email (default: SMTP_USER)

## Deployment

Deployed to Railway. Config in `railway.json`:
- Runs `npm run migrate && npm start`
- Health checks at `/health`
- Auto-restarts on failure (up to 10 retries)
