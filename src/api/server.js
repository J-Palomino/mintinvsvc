const express = require('express');
const cors = require('cors');
const cache = require('../cache');

const app = express();
const PORT = process.env.PORT || process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

function startServer() {
  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`API server running on port ${PORT}`);
      resolve(app);
    });
  });
}

module.exports = { app, startServer };
