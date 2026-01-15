const DiscountSyncService = require('../src/services/discountSync');

// Mock the database module
jest.mock('../src/db', () => ({
  query: jest.fn()
}));

// Mock the Dutchie client
jest.mock('../src/api/dutchie', () => {
  return jest.fn().mockImplementation(() => ({
    getDiscountsV2: jest.fn()
  }));
});

const db = require('../src/db');
const DutchieClient = require('../src/api/dutchie');

describe('DiscountSyncService', () => {
  let service;
  const locationId = 'LOC-123';
  const locationName = 'Test Store';
  const apiKey = 'test-api-key';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DiscountSyncService(locationId, locationName, apiKey);
  });

  describe('loadInventoryCache', () => {
    it('should load inventory data into a Map', async () => {
      const mockInventory = [
        {
          product_id: 'PROD-001',
          product_name: 'Blue Dream',
          brand_name: 'Top Shelf',
          category: 'Flower',
          image_url: 'https://images.dutchie.com/products/PROD-001/default.jpg',
          unit_price: 45.00
        },
        {
          product_id: 'PROD-002',
          product_name: 'OG Kush',
          brand_name: 'Premium',
          category: 'Flower',
          image_url: 'https://images.dutchie.com/products/PROD-002/default.jpg',
          unit_price: 50.00
        }
      ];

      db.query.mockResolvedValue({ rows: mockInventory });

      const cache = await service.loadInventoryCache();

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT product_id, product_name, brand_name, category, image_url, unit_price'),
        [locationId]
      );
      expect(cache).toBeInstanceOf(Map);
      expect(cache.size).toBe(2);
      expect(cache.get('PROD-001')).toEqual({
        product_name: 'Blue Dream',
        brand_name: 'Top Shelf',
        category: 'Flower',
        image_url: 'https://images.dutchie.com/products/PROD-001/default.jpg',
        unit_price: 45.00
      });
    });

    it('should return cached data on subsequent calls', async () => {
      const mockInventory = [
        { product_id: 'PROD-001', product_name: 'Blue Dream', brand_name: 'Top Shelf', category: 'Flower', image_url: null, unit_price: 45.00 }
      ];
      db.query.mockResolvedValue({ rows: mockInventory });

      await service.loadInventoryCache();
      await service.loadInventoryCache();

      // Should only query once due to caching
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('enrichWithProductData', () => {
    beforeEach(() => {
      // Pre-populate the inventory cache
      service.inventoryCache = new Map([
        ['PROD-001', {
          product_name: 'Blue Dream',
          brand_name: 'Top Shelf',
          category: 'Flower',
          image_url: 'https://images.dutchie.com/products/PROD-001/default.jpg',
          unit_price: 45.00
        }],
        ['PROD-002', {
          product_name: 'OG Kush',
          brand_name: 'Premium',
          category: 'Flower',
          image_url: 'https://images.dutchie.com/products/PROD-002/default.jpg',
          unit_price: 50.00
        }],
        ['PROD-003', {
          product_name: 'Sour Diesel',
          brand_name: 'Top Shelf',
          category: 'Flower',
          image_url: 'https://images.dutchie.com/products/PROD-003/default.jpg',
          unit_price: 55.00
        }]
      ]);
    });

    it('should enrich discount with product data for inclusion restrictions', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: '20% Off Blue Dream' };
      const restrictions = {
        Product: {
          restrictionIds: ['PROD-001'],
          isExclusion: false
        }
      };

      const result = await service.enrichWithProductData(transformed, restrictions);

      expect(result.product_name).toBe('Blue Dream');
      expect(result.brand_name).toBe('Top Shelf');
      expect(result.category).toBe('Flower');
      expect(result.image_url).toBe('https://images.dutchie.com/products/PROD-001/default.jpg');
      expect(result.unit_price).toBe(45.00);
      expect(result.product_details).toBeDefined();

      const productDetails = JSON.parse(result.product_details);
      expect(productDetails).toHaveLength(1);
      expect(productDetails[0].product_id).toBe('PROD-001');
    });

    it('should NOT enrich discount for exclusion restrictions', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: '20% Off (Excludes Blue Dream)' };
      const restrictions = {
        Product: {
          restrictionIds: ['PROD-001'],
          isExclusion: true
        }
      };

      const result = await service.enrichWithProductData(transformed, restrictions);

      expect(result.product_name).toBeUndefined();
      expect(result.brand_name).toBeUndefined();
      expect(result.image_url).toBeUndefined();
      expect(result.product_details).toBeUndefined();
    });

    it('should NOT enrich when no Product restrictions exist', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: 'Storewide Sale' };
      const restrictions = {
        Brand: {
          restrictionIds: ['BRAND-001'],
          isExclusion: false
        }
      };

      const result = await service.enrichWithProductData(transformed, restrictions);

      expect(result.product_name).toBeUndefined();
      expect(result.image_url).toBeUndefined();
    });

    it('should NOT enrich when restrictions is null', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: 'Storewide Sale' };

      const result = await service.enrichWithProductData(transformed, null);

      expect(result.product_name).toBeUndefined();
      expect(result.image_url).toBeUndefined();
    });

    it('should handle multiple products and use first as primary', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: 'Multi-Product Deal' };
      const restrictions = {
        Product: {
          restrictionIds: ['PROD-001', 'PROD-002', 'PROD-003'],
          isExclusion: false
        }
      };

      const result = await service.enrichWithProductData(transformed, restrictions);

      // Primary fields from first product
      expect(result.product_name).toBe('Blue Dream');
      expect(result.brand_name).toBe('Top Shelf');
      expect(result.image_url).toBe('https://images.dutchie.com/products/PROD-001/default.jpg');

      // All products in product_details
      const productDetails = JSON.parse(result.product_details);
      expect(productDetails).toHaveLength(3);
      expect(productDetails[0].product_name).toBe('Blue Dream');
      expect(productDetails[1].product_name).toBe('OG Kush');
      expect(productDetails[2].product_name).toBe('Sour Diesel');
    });

    it('should handle products not found in inventory', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: 'Unknown Product Deal' };
      const restrictions = {
        Product: {
          restrictionIds: ['UNKNOWN-001', 'UNKNOWN-002'],
          isExclusion: false
        }
      };

      const result = await service.enrichWithProductData(transformed, restrictions);

      // No enrichment when products not found
      expect(result.product_name).toBeUndefined();
      expect(result.product_details).toBeUndefined();
    });

    it('should handle mixed found/not-found products', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: 'Mixed Product Deal' };
      const restrictions = {
        Product: {
          restrictionIds: ['UNKNOWN-001', 'PROD-002', 'UNKNOWN-002'],
          isExclusion: false
        }
      };

      const result = await service.enrichWithProductData(transformed, restrictions);

      // Should use first found product as primary
      expect(result.product_name).toBe('OG Kush');
      expect(result.brand_name).toBe('Premium');

      // Only found product in details
      const productDetails = JSON.parse(result.product_details);
      expect(productDetails).toHaveLength(1);
      expect(productDetails[0].product_id).toBe('PROD-002');
    });

    it('should handle empty restrictionIds array', async () => {
      const transformed = { discount_id: 'DISC-001', discount_name: 'Empty Restriction' };
      const restrictions = {
        Product: {
          restrictionIds: [],
          isExclusion: false
        }
      };

      const result = await service.enrichWithProductData(transformed, restrictions);

      expect(result.product_name).toBeUndefined();
      expect(result.product_details).toBeUndefined();
    });
  });

  describe('transformItem', () => {
    it('should transform API discount to database format', () => {
      const apiItem = {
        id: 'DISC-001',
        discountDescription: '20% Off Flower',
        discountCode: 'FLOWER20',
        applicationMethod: 'Automatic',
        isActive: true,
        validDateFrom: '2026-01-01',
        validDateTo: '2026-12-31',
        reward: {
          calculationMethod: 'Percentage',
          discountValue: 20,
          thresholdType: 'None',
          restrictions: {
            Category: {
              restrictionIds: ['Flower'],
              isExclusion: false
            }
          }
        }
      };

      const result = service.transformItem(apiItem);

      expect(result.discount_id).toBe('DISC-001');
      expect(result.discount_name).toBe('20% Off Flower');
      expect(result.discount_code).toBe('FLOWER20');
      expect(result.application_method).toBe('Automatic');
      expect(result.is_active).toBe(true);
      expect(result.valid_from).toBe('2026-01-01');
      expect(result.valid_until).toBe('2026-12-31');
      expect(result.calculation_method).toBe('Percentage');
      expect(result.discount_amount).toBe(20);
      expect(result.location_id).toBe(locationId);
      expect(result.id).toBe(`${locationId}_DISC-001`);
      expect(result.is_available_online).toBe(true);
    });

    it('should set is_available_online false for non-automatic discounts', () => {
      const apiItem = {
        id: 'DISC-001',
        applicationMethod: 'Manual',
        isActive: true
      };

      const result = service.transformItem(apiItem);

      expect(result.is_available_online).toBe(false);
    });

    it('should handle weekly recurrence fields', () => {
      const apiItem = {
        id: 'DISC-001',
        isActive: true,
        monday: true,
        tuesday: true,
        wednesday: false,
        thursday: false,
        friday: true,
        saturday: true,
        sunday: false,
        startTime: '09:00',
        endTime: '17:00'
      };

      const result = service.transformItem(apiItem);

      expect(result.monday).toBe(true);
      expect(result.friday).toBe(true);
      expect(result.wednesday).toBe(false);
      expect(result.start_time).toBe('09:00');
      expect(result.end_time).toBe('17:00');

      const weeklyInfo = JSON.parse(result.weekly_recurrence_info);
      expect(weeklyInfo.monday).toBe(true);
      expect(weeklyInfo.startTime).toBe('09:00');
    });

    it('should extract product restrictions as JSON', () => {
      const apiItem = {
        id: 'DISC-001',
        isActive: true,
        reward: {
          restrictions: {
            Product: {
              restrictionIds: ['PROD-001', 'PROD-002'],
              isExclusion: false
            }
          }
        }
      };

      const result = service.transformItem(apiItem);

      const products = JSON.parse(result.products);
      expect(products.ids).toEqual(['PROD-001', 'PROD-002']);
      expect(products.isExclusion).toBe(false);
    });

    it('should extract brand restrictions as JSON', () => {
      const apiItem = {
        id: 'DISC-001',
        isActive: true,
        reward: {
          restrictions: {
            Brand: {
              restrictionIds: ['BRAND-001'],
              isExclusion: true
            }
          }
        }
      };

      const result = service.transformItem(apiItem);

      const brands = JSON.parse(result.brands);
      expect(brands.ids).toEqual(['BRAND-001']);
      expect(brands.isExclusion).toBe(true);
    });

    it('should handle menu display info', () => {
      const apiItem = {
        id: 'DISC-001',
        isActive: true,
        menuDisplay: {
          menuDisplayName: 'Special Deal!',
          menuDisplayImageUrl: 'https://example.com/deal.jpg',
          showOnMenu: true
        }
      };

      const result = service.transformItem(apiItem);

      expect(result.menu_display_name).toBe('Special Deal!');
      expect(result.menu_display_image_url).toBe('https://example.com/deal.jpg');

      const menuDisplay = JSON.parse(result.menu_display);
      expect(menuDisplay.showOnMenu).toBe(true);
    });
  });

  describe('buildUpsertQuery', () => {
    it('should build valid upsert query', () => {
      const item = {
        id: 'LOC-123_DISC-001',
        location_id: 'LOC-123',
        discount_id: 'DISC-001',
        discount_name: 'Test Discount',
        is_active: true
      };

      const { query, values } = service.buildUpsertQuery(item);

      expect(query).toContain('INSERT INTO discounts');
      expect(query).toContain('ON CONFLICT (id) DO UPDATE');
      expect(query).toContain('synced_at = CURRENT_TIMESTAMP');
      expect(query).not.toContain('id = EXCLUDED.id');
      expect(query).not.toContain('location_id = EXCLUDED.location_id');
      expect(query).not.toContain('discount_id = EXCLUDED.discount_id');
      expect(values).toHaveLength(5);
    });
  });

  describe('syncDiscounts (integration)', () => {
    it('should sync active discounts with product enrichment', async () => {
      const mockDiscounts = [
        {
          id: 'DISC-001',
          discountDescription: 'Product Deal',
          applicationMethod: 'Automatic',
          isActive: true,
          reward: {
            calculationMethod: 'Percentage',
            discountValue: 10,
            restrictions: {
              Product: {
                restrictionIds: ['PROD-001'],
                isExclusion: false
              }
            }
          }
        },
        {
          id: 'DISC-002',
          discountDescription: 'Inactive Deal',
          isActive: false
        }
      ];

      const mockInventory = [
        {
          product_id: 'PROD-001',
          product_name: 'Blue Dream',
          brand_name: 'Top Shelf',
          category: 'Flower',
          image_url: 'https://images.dutchie.com/products/PROD-001/default.jpg',
          unit_price: 45.00
        }
      ];

      // Mock Dutchie client
      const mockDutchieClient = {
        getDiscountsV2: jest.fn().mockResolvedValue(mockDiscounts)
      };
      service.dutchieClient = mockDutchieClient;

      // Mock inventory query (first call) and upsert (subsequent calls)
      db.query
        .mockResolvedValueOnce({ rows: mockInventory }) // loadInventoryCache
        .mockResolvedValue({ rows: [] }); // upserts

      const result = await service.syncDiscounts();

      expect(result.synced).toBe(1);
      expect(result.skipped).toBe(1); // inactive discount
      expect(result.errors).toBe(0);
      expect(result.locationId).toBe(locationId);

      // Verify the upsert was called with enriched data
      const upsertCall = db.query.mock.calls[1];
      expect(upsertCall[0]).toContain('INSERT INTO discounts');
      expect(upsertCall[1]).toContain('Blue Dream'); // product_name was enriched
    });

    it('should handle API errors gracefully', async () => {
      const mockDutchieClient = {
        getDiscountsV2: jest.fn().mockRejectedValue(new Error('API Error'))
      };
      service.dutchieClient = mockDutchieClient;

      const result = await service.syncDiscounts();

      expect(result.synced).toBe(0);
      expect(result.errors).toBe(1);
    });

    it('should handle empty discounts response', async () => {
      const mockDutchieClient = {
        getDiscountsV2: jest.fn().mockResolvedValue([])
      };
      service.dutchieClient = mockDutchieClient;

      const result = await service.syncDiscounts();

      expect(result.synced).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should handle null discounts response', async () => {
      const mockDutchieClient = {
        getDiscountsV2: jest.fn().mockResolvedValue(null)
      };
      service.dutchieClient = mockDutchieClient;

      const result = await service.syncDiscounts();

      expect(result.synced).toBe(0);
      expect(result.errors).toBe(0);
    });
  });
});
