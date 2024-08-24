import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import fs from 'fs';
import https from 'https';
import sqlite3 from 'sqlite3';
import { MemoryStorage } from '@crawlee/memory-storage';

const db = new sqlite3.Database('crawler.db', (err) => {
  if (err) {
    console.error('Error opening database', err);
    return;
  }

  console.log('Connected to the SQLite database.');
});

let blockedDomains = [];

// Download and save txt files of banned domains
// From: https://blocklistproject.github.io/Lists/
const downloadBlockList = (): Promise<void> => {
  const file = fs.createWriteStream('block-list.txt');

  const promise = new Promise<void>((resolve) => {
    https.get(
      'https://blocklistproject.github.io/Lists/everything.txt',
      (response) => {
        response.pipe(file);
        file.on('finish', () => {
          console.log('Download Completed');
          file.close();
          resolve();
        });
      }
    );
  });

  return promise;
};

const memoryStorage = new MemoryStorage({
  persistStorage: true,
  writeMetadata: false,
});

const requestQueue = await RequestQueue.open(null, {
  storageClient: memoryStorage,
});

const crawler = new PlaywrightCrawler({
  requestQueue,
  maxConcurrency: 5,
  maxRequestRetries: 3,
  async requestHandler({ _, page, enqueueLinks }) {
    console.log('Processing:', page.url());

    const links = await page.$$eval('a', (anchors) =>
      anchors.map((anchor) => anchor.href)
    );

    console.log('Links found:', links.length);

    const externalLinks = links.filter(
      (link) => !link.includes('blogs-collection.com')
    );

    const safeLinksToSave = externalLinks.filter(
      (link) => !blockedDomains.some((domain) => link.includes(domain))
    );

    const safeLinksToSaveWithIsHome = safeLinksToSave.map((link) => {
      const url = new URL(link);
      const isHome = url.pathname === '/';

      return { url: link, is_home: isHome };
    });

    db.serialize(() => {
      const statement = db.prepare(
        'INSERT OR IGNORE INTO page (url, is_home) VALUES (?, ?)'
      );

      safeLinksToSaveWithIsHome.forEach((link) => {
        statement.run(link.url, link.is_home);
      });

      statement.finalize();
    });

    const safeLinksToCrawl = links.filter((link) => {
      return !blockedDomains.some((domain) => link.includes(domain));
    });

    await enqueueLinks({ urls: safeLinksToCrawl });
  },
});

await downloadBlockList();

const blockListFile = fs.readFileSync('block-list.txt', 'utf-8');
const lines = blockListFile.trim().split('\n');

const linesWithoutComments = lines.filter((line) => !line.startsWith('#'));

// Extract blocked domains from the block list
const blockedDomainsWithDuplicates = linesWithoutComments.map((line) => {
  // Split each line by space and take the second part (domain)
  return line.split(' ')[1];
});

blockedDomains = [...new Set(blockedDomainsWithDuplicates)];

const isEmpty = await requestQueue.isEmpty();
console.log('Queue is empty:', isEmpty);

if (isEmpty) {
  await crawler.run(['https://www.blogs-collection.com/']);
} else {
  await crawler.run();
}
