/**
 * BullMQ Queue Definitions
 *
 * All queues use concurrency=1 to prevent overlapping jobs
 * and provide implicit locking.
 */

const { Queue } = require('bullmq');

// Queue names
const QUEUE_NAMES = {
  INVENTORY_SYNC: 'inventory-sync',
  GL_EXPORT: 'gl-export',
  BANNER_SYNC: 'banner-sync',
  HOURLY_SALES: 'hourly-sales'
};

// Default job options per queue type
const DEFAULT_OPTIONS = {
  [QUEUE_NAMES.INVENTORY_SYNC]: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000 // 1 min -> 5 min -> 15 min (approx with exponential)
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 }
  },
  [QUEUE_NAMES.GL_EXPORT]: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000
    },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 }
  },
  [QUEUE_NAMES.BANNER_SYNC]: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 60000
    },
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 30 }
  },
  [QUEUE_NAMES.HOURLY_SALES]: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 60000
    },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 30 }
  }
};

// Repeatable job schedules
const SCHEDULES = {
  [QUEUE_NAMES.INVENTORY_SYNC]: {
    pattern: '*/10 * * * *' // Every 10 minutes
  },
  [QUEUE_NAMES.GL_EXPORT]: {
    pattern: '0 8 * * *' // 8:00 AM daily
  },
  [QUEUE_NAMES.BANNER_SYNC]: {
    pattern: '0 5 * * *' // 5:00 AM daily
  },
  [QUEUE_NAMES.HOURLY_SALES]: {
    pattern: '0 * * * *' // Top of every hour
  }
};

let queues = {};

/**
 * Initialize all queues with the given Redis connection
 * @param {object} connection - Redis connection options or IORedis instance
 */
function initQueues(connection) {
  const queueOptions = { connection };

  queues = {
    inventorySync: new Queue(QUEUE_NAMES.INVENTORY_SYNC, queueOptions),
    glExport: new Queue(QUEUE_NAMES.GL_EXPORT, queueOptions),
    bannerSync: new Queue(QUEUE_NAMES.BANNER_SYNC, queueOptions),
    hourlySales: new Queue(QUEUE_NAMES.HOURLY_SALES, queueOptions)
  };

  console.log('BullMQ queues initialized');
  return queues;
}

/**
 * Get all queue instances
 */
function getQueues() {
  return queues;
}

/**
 * Schedule repeatable jobs on all queues
 */
async function scheduleRepeatableJobs() {
  const { inventorySync, glExport, bannerSync, hourlySales } = queues;

  // Remove existing repeatable jobs to prevent duplicates on restart
  await removeAllRepeatableJobs();

  // Schedule inventory sync every 10 minutes
  await inventorySync.add(
    'scheduled-sync',
    {},
    {
      ...DEFAULT_OPTIONS[QUEUE_NAMES.INVENTORY_SYNC],
      repeat: SCHEDULES[QUEUE_NAMES.INVENTORY_SYNC]
    }
  );
  console.log('  - Inventory sync: every 10 minutes');

  // Schedule GL export at 8 AM daily
  await glExport.add(
    'scheduled-export',
    {},
    {
      ...DEFAULT_OPTIONS[QUEUE_NAMES.GL_EXPORT],
      repeat: SCHEDULES[QUEUE_NAMES.GL_EXPORT]
    }
  );
  console.log('  - GL export: 8:00 AM daily');

  // Schedule banner sync at 5 AM daily
  await bannerSync.add(
    'scheduled-sync',
    {},
    {
      ...DEFAULT_OPTIONS[QUEUE_NAMES.BANNER_SYNC],
      repeat: SCHEDULES[QUEUE_NAMES.BANNER_SYNC]
    }
  );
  console.log('  - Banner sync: 5:00 AM daily');

  // Schedule hourly sales at top of each hour
  await hourlySales.add(
    'scheduled-sync',
    {},
    {
      ...DEFAULT_OPTIONS[QUEUE_NAMES.HOURLY_SALES],
      repeat: SCHEDULES[QUEUE_NAMES.HOURLY_SALES]
    }
  );
  console.log('  - Hourly sales: top of each hour');
}

/**
 * Remove all repeatable jobs from all queues
 */
async function removeAllRepeatableJobs() {
  for (const queue of Object.values(queues)) {
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
}

/**
 * Add a one-off job to a queue
 */
async function addJob(queueName, data = {}, options = {}) {
  const queueMap = {
    [QUEUE_NAMES.INVENTORY_SYNC]: queues.inventorySync,
    [QUEUE_NAMES.GL_EXPORT]: queues.glExport,
    [QUEUE_NAMES.BANNER_SYNC]: queues.bannerSync,
    [QUEUE_NAMES.HOURLY_SALES]: queues.hourlySales
  };

  const queue = queueMap[queueName];
  if (!queue) {
    throw new Error(`Unknown queue: ${queueName}`);
  }

  return queue.add('manual-job', data, {
    ...DEFAULT_OPTIONS[queueName],
    ...options
  });
}

/**
 * Close all queues gracefully
 */
async function closeQueues() {
  for (const queue of Object.values(queues)) {
    await queue.close();
  }
  console.log('All queues closed');
}

module.exports = {
  QUEUE_NAMES,
  DEFAULT_OPTIONS,
  SCHEDULES,
  initQueues,
  getQueues,
  scheduleRepeatableJobs,
  removeAllRepeatableJobs,
  addJob,
  closeQueues
};
