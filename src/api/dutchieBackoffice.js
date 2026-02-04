/**
 * Dutchie Backoffice API Client
 *
 * Handles authentication and API calls to Dutchie backoffice for:
 * - Closing reports (prepaid sales data)
 * - Other backoffice-only endpoints
 *
 * Features:
 * - Auto-login with username/password
 * - Session caching and auto-refresh on expiry
 * - Retry on 401 errors
 */

const https = require('https');

// Default configuration
const BACKOFFICE_HOST = 'themint.backoffice.dutchie.com';
const DEFAULT_LSP_ID = 575;
const DEFAULT_ORG_ID = 5134;

class DutchieBackofficeClient {
  constructor(config = {}) {
    this.host = config.host || BACKOFFICE_HOST;
    this.username = config.username || process.env.DUTCHIE_BACKOFFICE_USERNAME;
    this.password = config.password || process.env.DUTCHIE_BACKOFFICE_PASSWORD;
    this.lspId = config.lspId || process.env.DUTCHIE_LSP_ID || DEFAULT_LSP_ID;
    this.orgId = config.orgId || process.env.DUTCHIE_ORG_ID || DEFAULT_ORG_ID;

    // Session state
    this.sessionId = config.sessionId || process.env.DUTCHIE_SESSION_ID || null;
    this.userId = config.userId || process.env.DUTCHIE_USER_ID || null;
    this.sessionExpiry = null;
    this.authenticated = false;

    // If we have a static session ID, mark as authenticated
    if (this.sessionId) {
      this.authenticated = true;
    }
  }

  /**
   * Make an HTTPS request
   */
  request(options, data = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          // Extract session cookie if present
          const cookies = res.headers['set-cookie'];
          if (cookies) {
            for (const cookie of cookies) {
              const match = cookie.match(/LLSession=([^;]+)/i);
              if (match) {
                this.sessionId = match[1];
                this.authenticated = true;
              }
            }
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          });
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (data) {
        req.write(data);
      }
      req.end();
    });
  }

  /**
   * Login to Dutchie backoffice
   * @returns {Promise<boolean>} True if login successful
   */
  async login() {
    if (!this.username || !this.password) {
      console.log('[Backoffice] No credentials configured, using static session if available');
      return !!this.sessionId;
    }

    console.log(`[Backoffice] Logging in as ${this.username}...`);

    const loginData = JSON.stringify({
      Username: this.username,
      Password: this.password,
      RememberMe: true
    });

    const options = {
      hostname: this.host,
      path: '/api/user/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json',
        'appname': 'Backoffice',
        'Origin': `https://${this.host}`,
        'Content-Length': Buffer.byteLength(loginData)
      }
    };

    try {
      const response = await this.request(options, loginData);

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);

        if (result.Result && result.Data) {
          this.sessionId = result.Data.SessionId || this.sessionId;
          this.userId = result.Data.UserId || result.Data.Id;
          this.authenticated = true;

          // Set session expiry (24 hours from now as a safe default)
          this.sessionExpiry = Date.now() + (24 * 60 * 60 * 1000);

          console.log(`[Backoffice] Login successful: userId=${this.userId}, sessionId=${this.sessionId?.substring(0, 8)}...`);
          return true;
        } else {
          console.error('[Backoffice] Login failed:', result.Message || 'Unknown error');
          return false;
        }
      } else {
        console.error(`[Backoffice] Login failed with status ${response.statusCode}`);
        return false;
      }
    } catch (error) {
      console.error('[Backoffice] Login error:', error.message);
      return false;
    }
  }

  /**
   * Ensure we have a valid session
   */
  async ensureAuthenticated() {
    // Check if session might be expired
    if (this.sessionExpiry && Date.now() > this.sessionExpiry) {
      console.log('[Backoffice] Session expired, re-authenticating...');
      this.authenticated = false;
      this.sessionId = null;
    }

    if (!this.authenticated || !this.sessionId) {
      const success = await this.login();
      if (!success) {
        throw new Error('Failed to authenticate with Dutchie backoffice');
      }
    }
  }

  /**
   * Make an authenticated API call with auto-retry on 401
   */
  async apiCall(path, data, retryCount = 0) {
    await this.ensureAuthenticated();

    const bodyData = JSON.stringify({
      ...data,
      SessionId: this.sessionId,
      LspId: parseInt(this.lspId),
      OrgId: parseInt(this.orgId),
      UserId: this.userId ? parseInt(this.userId) : undefined
    });

    const options = {
      hostname: this.host,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json',
        'appname': 'Backoffice',
        'Origin': `https://${this.host}`,
        'Cookie': `LLSession=${this.sessionId}`,
        'Content-Length': Buffer.byteLength(bodyData)
      }
    };

    const response = await this.request(options, bodyData);

    // Handle 401 - session expired
    if (response.statusCode === 401 && retryCount < 1) {
      console.log('[Backoffice] Session expired (401), re-authenticating...');
      this.authenticated = false;
      this.sessionId = null;
      return this.apiCall(path, data, retryCount + 1);
    }

    if (response.statusCode !== 200) {
      throw new Error(`API error: ${response.statusCode}`);
    }

    const result = JSON.parse(response.body);

    // Check for auth errors in response body
    if (result.Message && result.Message.includes('session') && retryCount < 1) {
      console.log('[Backoffice] Session invalid, re-authenticating...');
      this.authenticated = false;
      this.sessionId = null;
      return this.apiCall(path, data, retryCount + 1);
    }

    return result;
  }

  /**
   * Fetch closing report for a location
   * @param {number} locId - Location ID
   * @param {string} reportDate - Date in YYYY-MM-DD format
   * @returns {Promise<object>} Closing report data
   */
  async fetchClosingReport(locId, reportDate) {
    // Format dates for closing-report API: "MM/DD/YYYY 12:00 am"
    const [year, month, day] = reportDate.split('-');
    const dateFrom = `${month}/${day}/${year} 12:00 am`;
    const dateTo = `${month}/${String(parseInt(day) + 1).padStart(2, '0')}/${year} 12:00 am`;

    const result = await this.apiCall('/api/posv3/reports/closing-report', {
      Date: dateFrom,
      EndDate: dateTo,
      IncludeDetail: false,
      LocId: locId
    });

    return result;
  }

  /**
   * Get prepaid sales for a location
   * @param {number} locId - Location ID
   * @param {string} reportDate - Date in YYYY-MM-DD format
   * @returns {Promise<number>} Prepaid sales amount
   */
  async getPrepaidSales(locId, reportDate) {
    try {
      const result = await this.fetchClosingReport(locId, reportDate);

      if (result.Result && result.Data?.Registers) {
        const prepaidTotal = result.Data.Registers.reduce(
          (sum, reg) => sum + (reg['Prepaid Sales'] || 0),
          0
        );
        return prepaidTotal;
      }
      return 0;
    } catch (error) {
      console.log(`[Backoffice] Error fetching prepaid for locId ${locId}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get electronic paid amount for a location
   * @param {number} locId - Location ID
   * @param {string} reportDate - Date in YYYY-MM-DD format
   * @returns {Promise<number>} Electronic paid amount
   */
  async getElectronicPaid(locId, reportDate) {
    try {
      const result = await this.fetchClosingReport(locId, reportDate);

      if (result.Result && result.Data?.Overview?.[0]) {
        return result.Data.Overview[0].ElectronicPaid || 0;
      }
      return 0;
    } catch (error) {
      console.log(`[Backoffice] Error fetching electronic for locId ${locId}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get full payment summary for a location
   * @param {number} locId - Location ID
   * @param {string} reportDate - Date in YYYY-MM-DD format
   * @returns {Promise<object>} Payment summary
   */
  async getPaymentSummary(locId, reportDate) {
    try {
      const result = await this.fetchClosingReport(locId, reportDate);

      if (result.Result && result.Data) {
        const overview = result.Data.Overview?.[0] || {};
        const prepaidTotal = (result.Data.Registers || []).reduce(
          (sum, reg) => sum + (reg['Prepaid Sales'] || 0),
          0
        );

        return {
          prepaidSales: prepaidTotal,
          paidInCash: overview.PaidInCash || 0,
          paidInDebit: overview.PaidInDebit || 0,
          electronicPaid: overview.ElectronicPaid || 0,
          totalInvoice: overview.TotalInvoice || 0,
          netSales: overview.NetSales || 0
        };
      }
      return null;
    } catch (error) {
      console.log(`[Backoffice] Error fetching summary for locId ${locId}: ${error.message}`);
      return null;
    }
  }
}

module.exports = DutchieBackofficeClient;
