import { Hono } from 'hono';
import { cors } from 'hono/cors';
import auth from './routes/auth';
import chat from './routes/chat';
import internal from './routes/internal';
import user from './routes/user';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	'/*',
	cors({
		origin: (origin) => {
			if (!origin) return 'https://lolisland.us';
			// Allow production domain
			if (origin === 'https://lolisland.us') return origin;
			if (origin === 'https://www.lolisland.us') return origin;
			// Allow local development
			if (origin.startsWith('http://localhost:')) return origin;
			// Allow Cloudflare Pages
			if (origin.endsWith('.lolisland.pages.dev') || origin.endsWith('.pages.dev')) return origin;
			// Block others (or return null)
			return null;
		},
		allowHeaders: ['Content-Type', 'Authorization', 'X-Custom-Header', 'Cache-Control'],
		allowMethods: ['POST', 'GET', 'OPTIONS', 'DELETE', 'PUT'],
		exposeHeaders: ['Content-Length'],
		maxAge: 600,
		credentials: true,
	}),
);

// Mount routers
app.route('/api', auth);
app.route('/api', chat);
app.route('/api', user);
app.route('/api/internal/bot', internal);

export { VerificationDO } from './do/verification';
export default app;
