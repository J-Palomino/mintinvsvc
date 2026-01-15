# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm start          # Run migrations then start the service
npm run migrate    # Run database migrations only
```

No test suite is currently configured.

## Architecture Overview

This is a multi-location inventory synchronization service that:
1. Fetches store configurations from a Strapi backend
2. Syncs inventory, discounts, and product enrichment data from Dutchie POS APIs to PostgreSQL
3. Caches data in Redis for fast API responses
4. Provides REST endpoints for frontend consumption

**Tech Stack:** Node.js, Express.js, PostgreSQL, Redis, Dutchie POS API, Dutchie Plus GraphQL

## Sync Flow

The main entry point (`src/index.js`) orchestrates sync in phases every 10 minutes (configurable):

1. **Phase 1 - Inventory Sync:** Fetches from Dutchie `/reporting/inventory`, transforms camelCase to snake_case, upserts to PostgreSQL
2. **Phase 2 - Product Enrichment:** Calls Dutchie Plus GraphQL for effects, tags, images, potency data; matches by SKU
3. **Phase 3 - Discount Sync:** Fetches from Dutchie v2 API with restriction data (product/brand/category eligibility)
4. **Phase 4 - Cache Refresh:** Syncs PostgreSQL data to Redis

**Daily Scheduled Tasks:**
- **8:00 AM** - GL Journal Export: Generates accounting journal entries for previous day's transactions
- **5:00 AM** - Banner Sync: Updates Strapi tickertape from Dutchie Plus retailer banner

## Key Services

| Service | File | Purpose |
|---------|------|---------|
| InventorySyncService | `src/services/inventorySync.js` | POS inventory → PostgreSQL (134-field mapping) |
| DiscountSyncService | `src/services/discountSync.js` | POS discounts with eligibility restrictions → PostgreSQL |
| ProductEnrichmentService | `src/services/productEnrichment.js` | GraphQL enrichment (effects, images, potency) |
| BannerSyncService | `src/services/bannerSync.js` | Daily retailer banner → Strapi tickertape |
| CacheSyncService | `src/services/cacheSync.js` | PostgreSQL → Redis cache |
| GLExportService | `src/services/glExportService.js` | Daily GL journal export for Accumatica (3 AM) |
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

## Database

**Schema:** `src/db/schema.sql` with migrations in `src/db/migrations/`

Key tables:
- `locations` - Store location records
- `inventory` - ~200+ columns from Dutchie product data, keyed by `(location_id, inventory_id)`
- `discounts` - Promotion data with JSONB restriction fields for product/brand/category eligibility

Composite IDs follow pattern: `{locationId}_{recordId}`

## Cache Keys

Redis key patterns:
- `inventory:{locationId}` - Cached inventory array
- `discounts:{locationId}` - Cached discounts array
- `locations:all` - All locations list
- `sync:{locationId}:timestamp` - Last sync time (ms)

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
