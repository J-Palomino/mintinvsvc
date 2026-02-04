# API Documentation

This document describes all REST API endpoints for the Mint Inventory Sync Service.

## Base URL

Production: `https://your-railway-url.up.railway.app`

## Authentication

All `/api/*` endpoints require the `x-api-key` header:

```
x-api-key: 7d176bcd2ea77429918fa50c85ebfa5ee5c09cde2ff72850660d81c4a4b40bb3
```

**Error Responses:**
- `401 Unauthorized` - Missing `x-api-key` header
- `403 Forbidden` - Invalid API key

**Public Endpoints (no auth required):**
- `GET /health`
- `GET /admin/queues`

---

## Endpoints Overview

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service health check |
| `/admin/queues` | GET | Bull Board job dashboard |
| `/api/locations` | GET | List all locations |
| `/api/locations/:locationId/inventory` | GET | Paginated inventory with filters |
| `/api/locations/:locationId/inventory/:sku` | GET | Single item with applicable discounts |
| `/api/locations/:locationId/categories` | GET | Unique categories for location |
| `/api/locations/:locationId/brands` | GET | Unique brands for location |
| `/api/locations/:locationId/discounts` | GET | Active discounts for location |
| `/api/locations/:locationId/sync-status` | GET | Last sync timestamp |
| `/api/reports/daily-sales` | GET | Generate GL journal export |
| `/api/reports/daily-sales` | POST | GL export from uploaded data |
| `/api/reports/hourly-sales` | GET | Hourly sales aggregation report |
| `/api/jobs/:queueName/trigger` | POST | Manually trigger a job |
| `/api/jobs/status` | GET | Job queue status |

---

## Health & Admin

### GET /health

Service health check.

**Authentication:** None

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-11T15:30:00.000Z"
}
```

---

### GET /admin/queues

Bull Board web dashboard for monitoring job queues.

**Authentication:** None

**Response:** HTML dashboard

---

## Locations

### GET /api/locations

Get all store locations with metadata.

**Response:**
```json
{
  "data": [
    {
      "id": "store-id",
      "name": "Store Name",
      "created_at": "2026-01-01T00:00:00Z"
    }
  ],
  "count": 5
}
```

**Status Codes:**
- `200` - Success
- `503` - Cache not ready

---

## Inventory

### GET /api/locations/:locationId/inventory

Get paginated inventory for a location with optional filtering.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Store location ID |

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `category` | string | - | Filter by category (case-insensitive) |
| `brand` | string | - | Filter by brand (partial match, case-insensitive) |
| `search` | string | - | Search product name, brand, or strain |
| `limit` | number | 100 | Items per page |
| `offset` | number | 0 | Pagination offset |

**Example Requests:**
```
GET /api/locations/store-1/inventory?limit=50&offset=0
GET /api/locations/store-1/inventory?category=flower
GET /api/locations/store-1/inventory?brand=Trulieve
GET /api/locations/store-1/inventory?search=OG%20Kush
GET /api/locations/store-1/inventory?category=edibles&brand=Wana&limit=25
```

**Response:**
```json
{
  "data": [
    {
      "id": "location-id_product-id",
      "location_id": "store-1",
      "product_id": "product-123",
      "inventory_id": "inv-456",
      "sku": "SKU123",
      "product_name": "OG Kush",
      "brand_name": "Premium Brand",
      "category": "Flower",
      "master_category": "Cannabis",
      "strain": "OG Kush",
      "strain_type": "Hybrid",
      "price": 45.99,
      "quantity_available": 125,
      "is_active": true
    }
  ],
  "total": 500,
  "limit": 50,
  "offset": 0
}
```

**Status Codes:**
- `200` - Success
- `404` - Location not found

---

### GET /api/locations/:locationId/inventory/:sku

Get single inventory item by SKU with applicable discounts.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Store location ID |
| `sku` | string | Product SKU |

**Response:**
```json
{
  "data": {
    "id": "composite-id",
    "sku": "SKU123",
    "product_name": "OG Kush",
    "product_id": "product-123",
    "price": 45.99,
    "quantity_available": 125
  },
  "discounts": [
    {
      "id": "discount-id",
      "discount_name": "20% Off Flower",
      "discount_amount": 0.20,
      "discount_type": "PERCENT",
      "is_active": true,
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": "2026-12-31T23:59:59Z"
    }
  ]
}
```

**Status Codes:**
- `200` - Success
- `404` - Location or SKU not found

---

### GET /api/locations/:locationId/categories

Get unique product categories for a location.

**Response:**
```json
{
  "categories": ["Flower", "Edibles", "Concentrates", "Tinctures"],
  "masterCategories": ["Cannabis", "Hemp", "Accessories"]
}
```

---

### GET /api/locations/:locationId/brands

Get unique brand names for a location.

**Response:**
```json
{
  "brands": ["Trulieve", "Surterra", "The Grow", "Stiiizy", "Verano"]
}
```

---

## Discounts

### GET /api/locations/:locationId/discounts

Get all active discounts for a location.

**Response:**
```json
{
  "data": [
    {
      "id": "location-id_discount-id",
      "location_id": "location-id",
      "discount_id": 12345,
      "discount_name": "Happy Hour - 20% Off",
      "discount_code": "HAPPY20",
      "discount_type": "PERCENT",
      "discount_method": "ALL_ITEMS",
      "discount_amount": 0.20,
      "calculation_method": "PERCENT_OFF",
      "is_active": true,
      "valid_from": "2026-01-01T08:00:00Z",
      "valid_until": "2026-01-01T20:00:00Z",
      "first_time_customer_only": false,
      "stack_on_other_discounts": false,
      "products": {
        "ids": [123, 456, 789],
        "isExclusion": false
      },
      "product_categories": {},
      "brands": {},
      "monday": true,
      "tuesday": true,
      "wednesday": true,
      "thursday": true,
      "friday": true,
      "saturday": false,
      "sunday": false,
      "start_time": "08:00:00",
      "end_time": "20:00:00"
    }
  ],
  "count": 8
}
```

---

## Sync Status

### GET /api/locations/:locationId/sync-status

Get last sync timestamp for a location.

**Response:**
```json
{
  "locationId": "store-1",
  "lastSync": "2026-01-11T15:30:45.123Z",
  "ageSeconds": 123
}
```

---

## Reports

### GET /api/reports/daily-sales

Generate GL journal export for a specific date.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | Yes* | Date in YYYY-MM-DD format |
| `email` | string | No | Set to `"true"` to email the report |
| `csvPath` | string | No | Use local CSV file instead of API |
| `jsonPath` | string | No | Use local JSON file instead of API |

*Required unless using `csvPath` or `jsonPath`

**Example Requests:**
```
GET /api/reports/daily-sales?date=2026-01-11
GET /api/reports/daily-sales?date=2026-01-11&email=true
GET /api/reports/daily-sales?csvPath=/path/to/file.csv
```

**Response:**
```json
{
  "success": true,
  "date": "2026-01-11",
  "source": "api",
  "stores": 5,
  "totalSales": 125450.75,
  "files": {
    "tsv": "exports/gl_journal_2026-01-11.tsv",
    "csv": "exports/gl_journal_2026-01-11.csv"
  },
  "email": {
    "sent": true,
    "to": "accounting@example.com",
    "subject": "GL Journal Export - 2026-01-11"
  },
  "failedStores": []
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid date format
- `503` - No active stores configured

---

### POST /api/reports/daily-sales

Generate GL journal export from uploaded data.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Date in YYYY-MM-DD (auto-detected if omitted) |
| `email` | string | No | Set to `"true"` to email the report |

**Content Types:**

**CSV Upload** (`Content-Type: text/csv`):
```bash
curl -X POST https://api.example.com/api/reports/daily-sales \
  -H "x-api-key: your-key" \
  -H "Content-Type: text/csv" \
  --data-binary @data.csv
```

**JSON Upload** (`Content-Type: application/json`):
```json
{
  "date": "2026-01-26",
  "data": [
    {
      "Location Name": "The Mint - Paradise",
      "Transaction Date": "2026-01-26",
      "Total Price": "$24,573.75",
      "Amount": "$7,945.60",
      "Total Tax": "$3,011.57",
      "Cash Paid": "$19,218.83",
      "Debit Paid": "$0.00",
      "Total Cost": "$8,408.69"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "date": "2026-01-26",
  "source": "post",
  "stores": 1,
  "totalSales": 24573.75,
  "files": {
    "tsv": "exports/gl_journal_2026-01-26.tsv",
    "csv": "exports/gl_journal_2026-01-26.csv"
  },
  "email": null
}
```

---

### GET /api/reports/hourly-sales

Generate hourly sales aggregation report.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startDate` | string | Yes | - | Start date (YYYY-MM-DD) |
| `endDate` | string | No | startDate + 6 days | End date (YYYY-MM-DD) |
| `storeId` | string | No | - | Filter to specific store |
| `view` | string | No | `"both"` | `"aggregated"`, `"detailed"`, or `"both"` |

**Example Requests:**
```
GET /api/reports/hourly-sales?startDate=2026-01-06
GET /api/reports/hourly-sales?startDate=2026-01-06&endDate=2026-01-12
GET /api/reports/hourly-sales?startDate=2026-01-06&storeId=abc-123&view=aggregated
```

**Response:**
```json
{
  "success": true,
  "dateRange": {
    "startDate": "2026-01-06",
    "endDate": "2026-01-12"
  },
  "generatedAt": "2026-01-11T15:30:00.000Z",
  "view": "both",
  "stores": [
    {
      "storeId": "store-1",
      "storeName": "The Mint - Paradise",
      "branchCode": "MTG",
      "transactionCount": 1250,
      "summary": {
        "totalGrossSales": 125450.75,
        "totalDiscounts": 5200.00,
        "totalReturns": 1500.00,
        "totalNetSales": 118750.75,
        "totalTax": 9500.00,
        "totalCashPaid": 95000.00,
        "totalDebitPaid": 23750.75
      },
      "aggregatedHourly": [
        {
          "hour": "08:00",
          "grossSales": 5200.50,
          "discounts": 200.00,
          "returns": 50.00,
          "netSales": 4950.50,
          "transactionCount": 45
        }
      ],
      "detailedByDayHour": {
        "2026-01-06": [
          { "hour": "08:00", "grossSales": 5200.50 }
        ]
      }
    }
  ],
  "grandTotals": {
    "totalGrossSales": 625000.00,
    "totalNetSales": 593000.00,
    "totalTransactions": 6000
  },
  "files": {
    "json": "exports/hourly-sales-2026-01-06.json",
    "csv": "exports/hourly-sales-2026-01-06.csv"
  },
  "failedStores": []
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid date format or view parameter
- `404` - Store not found
- `503` - No active stores configured

---

## Jobs

### POST /api/jobs/:queueName/trigger

Manually trigger a background job.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `queueName` | string | Queue name (see below) |

**Valid Queue Names:**
- `inventory-sync` - Sync inventory from Dutchie POS
- `gl-export` - Generate GL journal export
- `banner-sync` - Update retailer banner
- `hourly-sales` - Generate hourly sales report

**Request Body:**
```json
{
  "data": {}
}
```

**Response:**
```json
{
  "success": true,
  "message": "Job triggered for inventory-sync",
  "jobId": "abc-123-def-456"
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid queue name

---

### GET /api/jobs/status

Get current status of all job queues.

**Response:**
```json
{
  "queues": {
    "inventorySync": {
      "waiting": 5,
      "active": 1,
      "completed": 250,
      "failed": 2
    },
    "glExport": {
      "waiting": 0,
      "active": 0,
      "completed": 30,
      "failed": 0
    },
    "bannerSync": {
      "waiting": 0,
      "active": 0,
      "completed": 15,
      "failed": 0
    },
    "hourlySales": {
      "waiting": 0,
      "active": 0,
      "completed": 150,
      "failed": 0
    }
  }
}
```

**Status Codes:**
- `200` - Success
- `503` - Queue system not initialized

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message describing the issue"
}
```

**Common Status Codes:**
| Code | Description |
|------|-------------|
| `400` | Bad Request - Invalid parameters |
| `401` | Unauthorized - Missing API key |
| `403` | Forbidden - Invalid API key |
| `404` | Not Found - Resource not found |
| `500` | Internal Server Error |
| `503` | Service Unavailable - Cache/DB not ready |

---

## Data Schemas

### Inventory Item

Key fields (130+ total from Dutchie):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Composite ID (`locationId_productId`) |
| `location_id` | string | Store location ID |
| `product_id` | string | Dutchie product ID |
| `inventory_id` | string | Dutchie inventory ID |
| `sku` | string | Product SKU |
| `product_name` | string | Product name |
| `brand_name` | string | Brand name |
| `category` | string | Product category |
| `master_category` | string | Master category |
| `strain` | string | Strain name |
| `strain_type` | string | Indica/Sativa/Hybrid |
| `price` | number | Current price |
| `quantity_available` | number | Available quantity |
| `is_active` | boolean | Active status |
| `images` | array | Product images (enriched) |
| `effects` | array | Product effects (enriched) |
| `tags` | array | Product tags (enriched) |

### Discount

Key fields (40+ total):

| Field | Type | Description |
|-------|------|-------------|
| `discount_id` | number | Dutchie discount ID |
| `discount_name` | string | Display name |
| `discount_code` | string | Promo code |
| `discount_type` | string | PERCENT, DOLLAR, etc. |
| `discount_amount` | number | Discount value |
| `is_active` | boolean | Active status |
| `valid_from` | string | Start date (ISO 8601) |
| `valid_until` | string | End date (ISO 8601) |
| `products` | object | Product eligibility rules |
| `brands` | object | Brand eligibility rules |
| `product_categories` | object | Category eligibility rules |
| `monday` - `sunday` | boolean | Day availability |
| `start_time` | string | Daily start time |
| `end_time` | string | Daily end time |
