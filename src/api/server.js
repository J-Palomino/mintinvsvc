const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const cache = require('../cache');
const GLExportService = require('../services/glExportService');
const HourlySalesService = require('../services/hourlySalesService');

const app = express();
const STORES_API_URL = process.env.STORES_API_URL || 'https://mintdealsbackend-production.up.railway.app/api/stores';
const PORT = process.env.PORT || process.env.API_PORT || 3000;
const API_KEY = process.env.API_KEY || '7d176bcd2ea77429918fa50c85ebfa5ee5c09cde2ff72850660d81c4a4b40bb3';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/csv', limit: '50mb' }));

// API key authentication middleware
const requireApiKey = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];

  if (!providedKey) {
    return res.status(401).json({ error: 'Missing API key. Provide x-api-key header.' });
  }

  if (providedKey !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
};

// Health check (public - no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Bull Board setup (lazy initialization)
let bullBoardRouter = null;

function setupBullBoard() {
  if (bullBoardRouter) return bullBoardRouter;

  try {
    const { getQueues } = require('../jobs/queues');
    const queues = getQueues();

    // Only set up if queues are initialized
    if (!queues.inventorySync) {
      return null;
    }

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    createBullBoard({
      queues: [
        new BullMQAdapter(queues.inventorySync),
        new BullMQAdapter(queues.glExport),
        new BullMQAdapter(queues.bannerSync),
        new BullMQAdapter(queues.hourlySales)
      ],
      serverAdapter
    });

    bullBoardRouter = serverAdapter.getRouter();
    console.log('Bull Board UI available at /admin/queues');
    return bullBoardRouter;
  } catch (error) {
    console.warn('Bull Board setup skipped:', error.message);
    return null;
  }
}

// Bull Board route (public - no auth for dashboard access)
app.use('/admin/queues', (req, res, next) => {
  const router = setupBullBoard();
  if (router) {
    router(req, res, next);
  } else {
    res.status(503).json({ error: 'Queue system not initialized yet' });
  }
});

// Apply API key auth to all /api/* routes
app.use('/api', requireApiKey);

// Get all locations
app.get('/api/locations', async (req, res) => {
  try {
    const locations = await cache.getLocations();
    if (!locations) {
      return res.status(503).json({ error: 'Cache not ready' });
    }
    res.json({ data: locations, count: locations.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get inventory for a location
app.get('/api/locations/:locationId/inventory', async (req, res) => {
  try {
    const { locationId } = req.params;
    const { category, brand, search, limit = 100, offset = 0 } = req.query;

    let inventory = await cache.getInventory(locationId);

    if (!inventory) {
      return res.status(404).json({ error: 'Location not found or cache not ready' });
    }

    // Apply filters
    if (category) {
      inventory = inventory.filter(item =>
        item.category?.toLowerCase() === category.toLowerCase() ||
        item.master_category?.toLowerCase() === category.toLowerCase()
      );
    }

    if (brand) {
      inventory = inventory.filter(item =>
        item.brand_name?.toLowerCase().includes(brand.toLowerCase())
      );
    }

    if (search) {
      const searchLower = search.toLowerCase();
      inventory = inventory.filter(item =>
        item.product_name?.toLowerCase().includes(searchLower) ||
        item.brand_name?.toLowerCase().includes(searchLower) ||
        item.strain?.toLowerCase().includes(searchLower)
      );
    }

    const total = inventory.length;
    const paginated = inventory.slice(Number(offset), Number(offset) + Number(limit));

    res.json({
      data: paginated,
      total,
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get discounts for a location
app.get('/api/locations/:locationId/discounts', async (req, res) => {
  try {
    const { locationId } = req.params;
    const discounts = await cache.getDiscounts(locationId);

    if (!discounts) {
      return res.status(404).json({ error: 'Location not found or cache not ready' });
    }

    res.json({ data: discounts, count: discounts.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get inventory item with applicable discounts
app.get('/api/locations/:locationId/inventory/:sku', async (req, res) => {
  try {
    const { locationId, sku } = req.params;

    const inventory = await cache.getInventory(locationId);
    const discounts = await cache.getDiscounts(locationId);

    if (!inventory) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const item = inventory.find(i => i.sku === sku);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Find applicable discounts
    const applicableDiscounts = discounts?.filter(d => {
      if (!d.products?.ids) return false;
      const productIds = d.products.ids;
      const isExclusion = d.products.isExclusion;

      if (isExclusion) {
        return !productIds.includes(item.product_id);
      }
      return productIds.includes(item.product_id);
    }) || [];

    res.json({
      data: item,
      discounts: applicableDiscounts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get last sync timestamp
app.get('/api/locations/:locationId/sync-status', async (req, res) => {
  try {
    const { locationId } = req.params;
    const lastSync = await cache.getLastSync(locationId);

    res.json({
      locationId,
      lastSync: lastSync ? new Date(lastSync).toISOString() : null,
      ageSeconds: lastSync ? Math.floor((Date.now() - lastSync) / 1000) : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get categories for a location
app.get('/api/locations/:locationId/categories', async (req, res) => {
  try {
    const { locationId } = req.params;
    const inventory = await cache.getInventory(locationId);

    if (!inventory) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const categories = [...new Set(inventory.map(i => i.category).filter(Boolean))].sort();
    const masterCategories = [...new Set(inventory.map(i => i.master_category).filter(Boolean))].sort();

    res.json({ categories, masterCategories });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get brands for a location
app.get('/api/locations/:locationId/brands', async (req, res) => {
  try {
    const { locationId } = req.params;
    const inventory = await cache.getInventory(locationId);

    if (!inventory) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const brands = [...new Set(inventory.map(i => i.brand_name).filter(Boolean))].sort();

    res.json({ brands });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Daily sales report - GL Journal export
// GET /api/reports/daily-sales?date=2026-01-11
// GET /api/reports/daily-sales?date=2026-01-11&email=true
// GET /api/reports/daily-sales?date=2026-01-11&csvPath=/path/to/dashboard.csv (use CSV instead of API)
// GET /api/reports/daily-sales?date=2026-01-11&jsonPath=/path/to/dashboard.json (use JSON instead of API)
app.get('/api/reports/daily-sales', async (req, res) => {
  try {
    const { date, email, csvPath, jsonPath } = req.query;

    // Validate date parameter (required unless using file import auto-detect)
    if (!date && !csvPath && !jsonPath) {
      return res.status(400).json({
        error: 'Missing required parameter: date (or csvPath/jsonPath for auto-detect)',
        example: '/api/reports/daily-sales?date=2026-01-11'
      });
    }

    // Validate date format if provided (YYYY-MM-DD)
    if (date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return res.status(400).json({
          error: 'Invalid date format. Use YYYY-MM-DD',
          example: '2026-01-11'
        });
      }
    }

    const fs = require('fs');

    // If jsonPath provided, use JSON import instead of API
    if (jsonPath) {
      console.log(`\n[API] Daily sales report from JSON: ${jsonPath}`);

      // Verify JSON file exists
      if (!fs.existsSync(jsonPath)) {
        return res.status(400).json({
          error: 'JSON file not found',
          path: jsonPath
        });
      }

      // Create GL export service (no location configs needed for JSON import)
      const glExportService = new GLExportService([]);
      const result = await glExportService.exportFromJSON(jsonPath, date || null);

      return res.json({
        success: result.success,
        date: date || 'auto-detected',
        source: 'json',
        stores: result.stores || 0,
        totalSales: result.totalSales || 0,
        files: {
          tsv: result.tsvFilepath,
          csv: result.csvFilepath
        }
      });
    }

    // If csvPath provided, use CSV import instead of API
    if (csvPath) {
      console.log(`\n[API] Daily sales report from CSV: ${csvPath}`);

      // Verify CSV file exists
      if (!fs.existsSync(csvPath)) {
        return res.status(400).json({
          error: 'CSV file not found',
          path: csvPath
        });
      }

      // Create GL export service (no location configs needed for CSV import)
      const glExportService = new GLExportService([]);
      const result = await glExportService.exportFromCSV(csvPath, date || null);

      return res.json({
        success: result.success,
        date: date || 'auto-detected',
        source: 'csv',
        stores: result.stores || 0,
        totalSales: result.totalSales || 0,
        files: {
          tsv: result.tsvFilepath,
          csv: result.csvFilepath
        }
      });
    }

    console.log(`\n[API] Daily sales report requested for ${date}`);

    // Fetch store configurations
    const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
    const stores = response.data.data || response.data;
    const activeStores = stores.filter(s => s.dutchieApiKey && s.is_active);

    if (activeStores.length === 0) {
      return res.status(503).json({ error: 'No active stores configured' });
    }

    // Build location configs for GLExportService
    const locationConfigs = activeStores.map(store => ({
      id: store.DutchieStoreID,
      name: store.name,
      apiKey: store.dutchieApiKey
    }));

    // Create GL export service and run export
    const glExportService = new GLExportService(locationConfigs);

    let result;
    if (email === 'true') {
      result = await glExportService.exportAndEmail(date);
    } else {
      result = await glExportService.exportForDate(date);
    }

    res.json({
      success: result.success,
      date,
      source: 'api',
      stores: result.stores || 0,
      totalSales: result.totalSales || 0,
      files: {
        tsv: result.tsvFilepath,
        csv: result.csvFilepath
      },
      email: result.email || null,
      failedStores: result.failedStores || []
    });
  } catch (error) {
    console.error('[API] Daily sales report error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Daily sales report - GL Journal export from POST data
// POST /api/reports/daily-sales
// POST /api/reports/daily-sales?email=true
// Body: JSON { "date": "2026-01-26", "data": [...] } or CSV text (Content-Type: text/csv)
// Requires API key authentication
app.post('/api/reports/daily-sales', async (req, res) => {
  try {
    const { date, email } = req.query;
    const contentType = req.headers['content-type'] || '';
    const body = req.body;

    const glExportService = new GLExportService([]);
    let result;

    // Handle CSV text upload
    if (contentType.includes('text/csv') && typeof body === 'string') {
      if (!body.trim()) {
        return res.status(400).json({ error: 'Empty CSV content' });
      }
      console.log(`\n[API] Daily sales report POST (CSV upload)`);
      result = await glExportService.exportFromCSVText(body, date || null);
    }
    // Handle JSON data
    else {
      if (!body || (Array.isArray(body) && body.length === 0) ||
          (!Array.isArray(body) && (!body.data || body.data.length === 0))) {
        return res.status(400).json({
          error: 'Missing or empty data in request body',
          note: 'Send CSV with Content-Type: text/csv, or JSON with Content-Type: application/json',
          example: {
            date: '2026-01-26',
            data: [
              {
                'Location Name': 'The Mint - Paradise',
                'Transaction Date': '2026-01-26',
                'Total Price': '$24,573.75',
                'Amount': '$7,945.60',
                'Total Tax': '$3,011.57',
                'Cash Paid': '$19,218.83',
                'Debit Paid': '$0.00',
                'Total Cost': '$8,408.69'
              }
            ]
          }
        });
      }

      // Extract date from query param, body, or auto-detect
      let reportDate = date || body.date || null;

      console.log(`\n[API] Daily sales report POST (JSON)`);
      result = await glExportService.exportFromData(body, reportDate);
    }

    // Send email if requested
    let emailResult = null;
    if (email === 'true' && result.success) {
      emailResult = await glExportService.sendEmail(
        result.tsvFilepath,
        result.csvFilepath,
        result.date || date || 'unknown',
        {
          stores: result.stores || 0,
          totalSales: result.totalSales || 0,
          success: result.success
        }
      );
    }

    res.json({
      success: result.success,
      date: result.date || date || 'auto-detected',
      source: result.source || 'post',
      stores: result.stores || 0,
      totalSales: result.totalSales || 0,
      files: {
        tsv: result.tsvFilepath,
        csv: result.csvFilepath
      },
      email: emailResult
    });
  } catch (error) {
    console.error('[API] Daily sales POST error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Weekly hourly sales report
// GET /api/reports/hourly-sales?startDate=2026-01-06
// GET /api/reports/hourly-sales?startDate=2026-01-06&endDate=2026-01-12
// GET /api/reports/hourly-sales?startDate=2026-01-06&storeId=abc-123
// GET /api/reports/hourly-sales?startDate=2026-01-06&view=aggregated
app.get('/api/reports/hourly-sales', async (req, res) => {
  try {
    const { startDate, endDate, storeId, view = 'both' } = req.query;

    // Validate startDate parameter
    if (!startDate) {
      return res.status(400).json({
        error: 'Missing required parameter: startDate',
        example: '/api/reports/hourly-sales?startDate=2026-01-06'
      });
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate)) {
      return res.status(400).json({
        error: 'Invalid startDate format. Use YYYY-MM-DD',
        example: '2026-01-06'
      });
    }

    if (endDate && !dateRegex.test(endDate)) {
      return res.status(400).json({
        error: 'Invalid endDate format. Use YYYY-MM-DD',
        example: '2026-01-12'
      });
    }

    // Validate view parameter
    const validViews = ['aggregated', 'detailed', 'both'];
    if (!validViews.includes(view)) {
      return res.status(400).json({
        error: 'Invalid view parameter. Use: aggregated, detailed, or both',
        example: '/api/reports/hourly-sales?startDate=2026-01-06&view=aggregated'
      });
    }

    console.log(`\n[API] Hourly sales report requested: ${startDate} to ${endDate || '(+6 days)'}`);

    // Fetch store configurations
    const response = await axios.get(`${STORES_API_URL}?pagination[limit]=100`);
    const stores = response.data.data || response.data;
    const activeStores = stores.filter(s => s.dutchieApiKey && s.is_active);

    if (activeStores.length === 0) {
      return res.status(503).json({ error: 'No active stores configured' });
    }

    // Build location configs
    const locationConfigs = activeStores.map(store => ({
      id: store.DutchieStoreID,
      name: store.name,
      apiKey: store.dutchieApiKey
    }));

    // Create hourly sales service and generate report
    const hourlySalesService = new HourlySalesService(locationConfigs);
    const result = await hourlySalesService.generateWeeklyReport(startDate, endDate, storeId);

    if (!result.success && result.error) {
      return res.status(404).json({ error: result.error });
    }

    // Filter response based on view parameter
    const storesResponse = result.stores.map(store => {
      const storeData = {
        storeId: store.storeId,
        storeName: store.storeName,
        branchCode: store.branchCode,
        summary: store.summary,
        transactionCount: store.transactionCount
      };

      if (view === 'aggregated' || view === 'both') {
        storeData.aggregatedHourly = store.aggregatedHourly;
      }
      if (view === 'detailed' || view === 'both') {
        storeData.detailedByDayHour = store.detailedByDayHour;
      }

      return storeData;
    });

    res.json({
      success: result.success,
      dateRange: result.dateRange,
      generatedAt: result.generatedAt,
      view,
      stores: storesResponse,
      grandTotals: result.grandTotals,
      files: result.files,
      failedStores: result.failedStores
    });
  } catch (error) {
    console.error('[API] Hourly sales report error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger a job
// POST /api/jobs/:queueName/trigger
// Body: { data: {} } (optional job data)
app.post('/api/jobs/:queueName/trigger', async (req, res) => {
  try {
    const { queueName } = req.params;
    const jobData = req.body.data || {};

    const validQueues = ['inventory-sync', 'gl-export', 'banner-sync', 'hourly-sales'];
    if (!validQueues.includes(queueName)) {
      return res.status(400).json({
        error: 'Invalid queue name',
        validQueues
      });
    }

    const { addJob, QUEUE_NAMES } = require('../jobs');
    const queueNameMap = {
      'inventory-sync': QUEUE_NAMES.INVENTORY_SYNC,
      'gl-export': QUEUE_NAMES.GL_EXPORT,
      'banner-sync': QUEUE_NAMES.BANNER_SYNC,
      'hourly-sales': QUEUE_NAMES.HOURLY_SALES
    };

    const job = await addJob(queueNameMap[queueName], jobData, { priority: 1 });

    console.log(`[API] Manually triggered ${queueName} job ${job.id}`);

    res.json({
      success: true,
      message: `Job triggered for ${queueName}`,
      jobId: job.id
    });
  } catch (error) {
    console.error('[API] Job trigger error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get queue status
// GET /api/jobs/status
app.get('/api/jobs/status', async (req, res) => {
  try {
    const { getQueues } = require('../jobs/queues');
    const queues = getQueues();

    if (!queues.inventorySync) {
      return res.status(503).json({ error: 'Queue system not initialized' });
    }

    const status = {};
    for (const [name, queue] of Object.entries(queues)) {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount()
      ]);

      status[name] = { waiting, active, completed, failed };
    }

    res.json({ queues: status });
  } catch (error) {
    console.error('[API] Queue status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

function startServer() {
  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`API server running on port ${PORT}`);
      resolve(app);
    });
  });
}

module.exports = { app, startServer };
