'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

function getEnvInt(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

const DEFAULT_SCAN_TIMEOUT_MS = getEnvInt('CLAMAV_SCAN_TIMEOUT_MS', 120_000);
const DEFAULT_DOWNLOAD_TIMEOUT_MS = getEnvInt(
  'CLAMAV_DOWNLOAD_TIMEOUT_MS',
  120_000,
);
const DEFAULT_MAX_BYTES = getEnvInt('CLAMAV_MAX_BYTES', 250 * 1024 * 1024);

function createTempFilePath({ prefix = 'mehor-scan-', ext = '.zip' } = {}) {
  const id = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : require('crypto').randomUUID();
  return path.join(os.tmpdir(), `${prefix}${id}${ext}`);
}

async function withTempFile(filePath, fn) {
  try {
    return await fn(filePath);
  } finally {
    try {
      await fsp.unlink(filePath);
    } catch {
      // ignore
    }
  }
}

function downloadUrlToFile(
  url,
  outPath,
  {
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxRedirects = 5,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const start = (currentUrl, redirectsLeft) => {
      let urlObj;
      try {
        urlObj = new URL(String(currentUrl));
      } catch {
        return reject(
          Object.assign(new Error('Invalid download URL'), {
            code: 'INVALID_URL',
          }),
        );
      }

      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.get(urlObj, (res) => {
        const status = Number(res.statusCode || 0);
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          return start(res.headers.location, redirectsLeft - 1);
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(
            Object.assign(new Error(`Download failed (${status || 0})`), {
              code: 'DOWNLOAD_FAILED',
              status,
            }),
          );
        }

        const contentLenHeader = String(
          res.headers['content-length'] || '',
        ).trim();
        const contentLen = contentLenHeader ? Number(contentLenHeader) : NaN;
        if (Number.isFinite(contentLen) && contentLen > maxBytes) {
          res.resume();
          return reject(
            Object.assign(new Error('File too large to scan'), {
              code: 'TOO_LARGE',
              maxBytes,
              contentLen,
            }),
          );
        }

        const out = fs.createWriteStream(outPath);
        let total = 0;

        const cleanup = (err) => {
          try {
            out.destroy();
          } catch {
            // ignore
          }
          res.destroy();
          return reject(err);
        };

        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            cleanup(
              Object.assign(new Error('File too large to scan'), {
                code: 'TOO_LARGE',
                maxBytes,
              }),
            );
          }
        });

        out.on('error', (e) => cleanup(e));
        res.on('error', (e) => cleanup(e));

        res.pipe(out);
        out.on('finish', () => resolve({ bytes: total }));
      });

      req.on('error', (e) => reject(e));
      req.setTimeout(timeoutMs, () => {
        req.destroy(
          Object.assign(new Error('Download timed out'), {
            code: 'DOWNLOAD_TIMEOUT',
            timeoutMs,
          }),
        );
      });
    };

    start(url, maxRedirects);
  });
}

function scanFileWithClamAV(
  filePath,
  {
    timeoutMs = DEFAULT_SCAN_TIMEOUT_MS,
    clamscanPath = process.env.CLAMAV_CLAMSCAN_PATH,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const exe =
      clamscanPath && String(clamscanPath).trim()
        ? String(clamscanPath).trim()
        : 'clamscan';

    const args = ['--no-summary', filePath];
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const e = Object.assign(new Error('ClamAV scanner not available'), {
        code: 'CLAMAV_NOT_AVAILABLE',
        cause: err,
      });
      return reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      const exitCode = typeof code === 'number' ? code : 2;
      if (exitCode === 0) {
        return resolve({ clean: true, stdout, stderr });
      }
      if (exitCode === 1) {
        return resolve({ clean: false, stdout, stderr });
      }
      const e = Object.assign(new Error('ClamAV scan failed'), {
        code: 'CLAMAV_ERROR',
        exitCode,
        stdout,
        stderr,
      });
      return reject(e);
    });
  });
}

async function scanUrlWithClamAV(url, options = {}) {
  const tempPath = createTempFilePath();
  return withTempFile(tempPath, async (p) => {
    await downloadUrlToFile(url, p, options);
    return scanFileWithClamAV(p, options);
  });
}

async function scanBufferWithClamAV(buffer, options = {}) {
  const tempPath = createTempFilePath();
  return withTempFile(tempPath, async (p) => {
    await fsp.writeFile(p, buffer);
    return scanFileWithClamAV(p, options);
  });
}

module.exports = {
  scanUrlWithClamAV,
  scanBufferWithClamAV,
};
