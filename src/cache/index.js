const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://default:tHxcZVRHjEQWzABYwSCpVTkrEuAuQyRf@hopper.proxy.rlwy.net:48513';

let redis = null;

function getClient() {
  if (!redis) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: true
    });

    redis.on('connect', () => {
      console.log('Connected to Redis');
    });

    redis.on('error', (err) => {
      console.error('Redis error:', err.message);
    });
  }
  return redis;
}

// Cache keys
const KEYS = {
  inventory: (locationId) => `inventory:${locationId}`,
  discounts: (locationId) => `discounts:${locationId}`,
  locations: 'locations:all',
  lastSync: (locationId) => `sync:${locationId}:timestamp`
};

// Cache inventory for a location
async function cacheInventory(locationId, items) {
  const client = getClient();
  const key = KEYS.inventory(locationId);

  await client.set(key, JSON.stringify(items));
  await client.set(KEYS.lastSync(locationId), Date.now().toString());

  return items.length;
}

// Cache discounts for a location
async function cacheDiscounts(locationId, items) {
  const client = getClient();
  const key = KEYS.discounts(locationId);

  await client.set(key, JSON.stringify(items));

  return items.length;
}

// Cache locations list
async function cacheLocations(locations) {
  const client = getClient();
  await client.set(KEYS.locations, JSON.stringify(locations));
  return locations.length;
}

// Get inventory from cache
async function getInventory(locationId) {
  const client = getClient();
  const data = await client.get(KEYS.inventory(locationId));
  return data ? JSON.parse(data) : null;
}

// Get discounts from cache
async function getDiscounts(locationId) {
  const client = getClient();
  const data = await client.get(KEYS.discounts(locationId));
  return data ? JSON.parse(data) : null;
}

// Get locations from cache
async function getLocations() {
  const client = getClient();
  const data = await client.get(KEYS.locations);
  return data ? JSON.parse(data) : null;
}

// Get last sync timestamp
async function getLastSync(locationId) {
  const client = getClient();
  const timestamp = await client.get(KEYS.lastSync(locationId));
  return timestamp ? parseInt(timestamp) : null;
}

// Clear cache for a location
async function clearLocation(locationId) {
  const client = getClient();
  await client.del(KEYS.inventory(locationId));
  await client.del(KEYS.discounts(locationId));
  await client.del(KEYS.lastSync(locationId));
}

// Close connection
async function close() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

module.exports = {
  getClient,
  cacheInventory,
  cacheDiscounts,
  cacheLocations,
  getInventory,
  getDiscounts,
  getLocations,
  getLastSync,
  clearLocation,
  close,
  KEYS
};
