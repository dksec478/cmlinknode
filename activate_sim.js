const { chromium } = require('playwright');
const fs = require('fs').promises;
const csv = require('csv-parse/sync');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const winston = require('winston');
const { Pool } = require('pg'); // 可選，用於持久化存儲

// 配置日誌
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} - ${level} - ${message}`)
  ),
  transports: [new winston.transports.File({ filename: 'activation.log' })]
});

// 讀取配置
const config = require('./config.json');

// 讀取 ICCID
async function loadIccids() {
  const fileContent = await fs.readFile('iccids.csv', 'utf-8');
  const iccids = csv.parse(fileContent, { columns: true, skip_empty_lines: true })
    .map(row => row.iccid)
    .filter((value, index, self) => self.indexOf(value) === index); // 去重
  return iccids;
}

// 初始化瀏覽器
async function initBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    ]
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  return { browser, context };
}

// 處理單個 ICCID
async function processIccid(iccid, maxRetries = 2) {
  const { browser, context } = await initBrowser();
  let result = { iccid, status: 'error', error_detail: '' };

  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      logger.info(`Processing ICCID: ${iccid} (Attempt ${attempt + 1}/${maxRetries})`);
      const page = await context.newPage();

      try {
        // 訪問頁面
        await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        logger.info(`Page title: ${await page.title()}, URL: ${page.url()}`);

        // 輸入 ICCID
        await page.waitForSelector(`.${config.selectors.iccid_input}`, { timeout: 30000 });
        await page.fill(`.${config.selectors.iccid_input}`, iccid);
        logger.info(`Entered ICCID: ${iccid}`);

        // 模擬滾動
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(Math.random() * 300 + 200); // 隨機延遲 200-500ms

        // 點擊 Next Step
        await page.waitForSelector(config.selectors.next_button, { timeout: 30000 });
        await page.click(config.selectors.next_button);
        logger.info(`Clicked Next Step button`);

        // 檢查響應
        try {
          await page.waitForSelector('text=Your SIM card has been successfully activated', { timeout: 5000 });
          result = { iccid, status: 'already_activated', error_detail: 'Your SIM card has been successfully activated' };
          logger.info(`ICCID ${iccid} already activated`);
          return result;
        } catch (e) {
          try {
            await page.waitForSelector('text=The system is currently experiencing some issues', { timeout: 5000 });
            result = { iccid, status: 'invalid_iccid', error_detail: 'The system is currently experiencing some issues' };
            logger.warn(`ICCID ${iccid} invalid`);
            return result;
          } catch (e) {
            try {
              await page.waitForSelector('text=Your activation order is being processed', { timeout: 5000 });
              result = { iccid, status: 'processing', error_detail: 'Your activation order is being processed, please try again later' };
              logger.info(`ICCID ${iccid} processing`);
              return result;
            } catch (e) {
              // 繼續到 Activate Now
            }
          }
        }

        // 點擊 Activate Now
        await page.waitForSelector(config.selectors.activate_button, { timeout: 30000 });
        await page.click(config.selectors.activate_button);
        logger.info(`Clicked Activate Now button`);

        // 檢查最終結果
        try {
          await page.waitForSelector('text=Your SIM card has been successfully activated', { timeout: 5000 });
          result = { iccid, status: 'success', error_detail: 'Your SIM card has been successfully activated' };
          logger.info(`ICCID ${iccid} successfully activated`);
          return result;
        } catch (e) {
          try {
            await page.waitForSelector('text=Your activation order is being processed', { timeout: 5000 });
            result = { iccid, status: 'processing', error_detail: 'Your activation order is being processed, please try again later' };
            logger.info(`ICCID ${iccid} processing`);
            return result;
          } catch (e) {
            result = { iccid, status: 'activation_failed', error_detail: 'No expected response received' };
            logger.error(`ICCID ${iccid} activation failed: No expected response`);
            return result;
          }
        }
      } catch (e) {
        logger.error(`ICCID ${iccid} error on attempt ${attempt + 1}: ${e.message}`);
        result.error_detail = e.message;
      } finally {
        await page.close();
      }
    }
  } catch (e) {
    logger.error(`ICCID ${iccid} critical error: ${e.message}`);
    result.error_detail = e.message;
  } finally {
    await browser.close();
  }
  return result;
}

// 主函數
async function main(maxWorkers = 3) {
  const iccids = await loadIccids();
  const results = [];
  const pool = new Array(maxWorkers).fill().map(() => Promise.resolve());

  for (const iccid of iccids) {
    const worker = pool.shift();
    pool.push(
      worker.then(async () => {
        const result = await processIccid(iccid);
        results.push(result);
        return result;
      })
    );
  }

  await Promise.all(pool);

  // 保存無效 ICCID
  const invalidIccids = results.filter(r => r.status === 'invalid_iccid').map(r => ({ iccid: r.iccid }));
  if (invalidIccids.length > 0) {
    const csvWriter = createCsvWriter({ path: 'invalid_iccids.csv', header: [{ id: 'iccid', title: 'iccid' }] });
    await csvWriter.writeRecords(invalidIccids);
    logger.info('Invalid ICCIDs saved to invalid_iccids.csv');
  }

  // 保存所有結果
  const csvWriter = createCsvWriter({
    path: 'activation_results.csv',
    header: [
      { id: 'iccid', title: 'iccid' },
      { id: 'status', title: 'status' },
      { id: 'error_detail', title: 'error_detail' }
    ]
  });
  await csvWriter.writeRecords(results);
  logger.info('Results saved to activation_results.csv');
}

// 執行主函數
main().catch(err => {
  logger.error(`Main process error: ${err.message}`);
  process.exit(1);
});