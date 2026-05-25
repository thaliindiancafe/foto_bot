/**
 * One-time helper: obtain GOOGLE_REFRESH_TOKEN for Google Drive (storage.ts).
 *
 * Add ALL of these redirect URIs to your Web OAuth client (Authorized redirect URIs):
 *   http://127.0.0.1:54321/oauth2callback
 *   http://127.0.0.1:38475/oauth2callback
 *   http://127.0.0.1:41799/oauth2callback
 *
 * Optional: GOOGLE_OAUTH_REDIRECT_PORT=54321 in .env (must match a URI you added in GCP).
 *
 * Run: npm run google:oauth
 */
import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';

const FALLBACK_PORTS = [54321, 38475, 41799] as const;
const CALLBACK_PATH = '/oauth2callback';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function redirectUriForPort(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

async function listenOnPort(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => {
      server.removeListener('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', onOk);
  });
}

async function acquireServerAndPort(
  clientId: string,
  clientSecret: string,
): Promise<{ server: http.Server; port: number; redirectUri: string }> {
  const preferred = Number(process.env.GOOGLE_OAUTH_REDIRECT_PORT);
  const ports: number[] =
    Number.isFinite(preferred) && preferred > 0 && preferred < 65536
      ? [preferred, ...FALLBACK_PORTS.filter((p) => p !== preferred)]
      : [...FALLBACK_PORTS];

  const busy: string[] = [];
  for (const port of ports) {
    const redirectUri = redirectUriForPort(port);

    const handler: http.RequestListener = async (req, res) => {
      try {
        if (!req.url) return;
        const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<p>OAuth error: ${err}</p>`);
          console.error('[google:oauth] error param:', err, url.searchParams.get('error_description'));
          server.close();
          process.exit(1);
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end('Missing code');
          return;
        }

        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Success</h1><p>You can close this tab. Copy <code>GOOGLE_REFRESH_TOKEN</code> from the terminal into <code>.env</code>.</p>',
        );

        console.log('--- Paste into .env (keep secret) ---\n');
        if (tokens.refresh_token) {
          console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
        } else {
          console.warn(
            'No refresh_token in response. Revoke app access: https://myaccount.google.com/permissions — then run npm run google:oauth again.\n',
          );
        }

        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 500);
      } catch (e) {
        console.error('[google:oauth]', e);
        res.writeHead(500);
        res.end('Token exchange failed');
        server.close();
        process.exit(1);
      }
    };

    const server = http.createServer(handler);
    try {
      await listenOnPort(server, port);
      return { server, port, redirectUri };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      server.close();
      if (err.code === 'EADDRINUSE') {
        busy.push(String(port));
        console.warn(`[google:oauth] Порт ${port} занят, пробую следующий...`);
      } else {
        throw e;
      }
    }
  }

  console.error(
    '[google:oauth] Все порты заняты: ' + busy.join(', ') + '. Закрой старый терминал с npm run google:oauth или заверши процесс Node.',
  );
  console.error('[google:oauth] Windows: netstat -ano | findstr :54321');
  console.error('[google:oauth] Затем: taskkill /PID <номер> /F');
  process.exit(1);
  throw new Error('unreachable');
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[google:oauth] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
    process.exit(1);
  }

  const { port, redirectUri } = await acquireServerAndPort(clientId, clientSecret);

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n[google:oauth] Используется redirect (должен быть в Google Cloud → OAuth Web client → Redirect URIs):');
  console.log(`    ${redirectUri}\n`);
  console.log('[google:oauth] Open this URL in the browser (same Google account that owns the Drive folder):\n');
  console.log(authorizeUrl);
  console.log(`\n[google:oauth] Waiting for redirect on 127.0.0.1:${port} ...\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
